// Local web UI: upload a PDF, preview the EPUB or XTC book, download.
// Usage: node server.js  then open http://localhost:3000

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { analyzePdf, buildEpub, openPdf, readerScreen } = require('./index');
const { imageCover, cleanBoxes } = require('./figures');
const { DEVICES, convertPdfPages, coverPage, bookPages, buildXtc, pagePng, extensionFor } = require('./xtc');
const { retryPage, manualReading } = require('./ocr');
const { parseLinks, readWebPages } = require('./web');

const { version } = require('./package.json');

const PORT = process.env.PORT || 3000;
const MAX_BYTES = 300 * 1024 * 1024;
const MAX_BOOKS = 5; // converted books kept in memory so their cover can be changed quickly
const LOW_CONFIDENCE = 75; // scanned pages read this well (%) or worse can be read again or typed in
const PICTURE_BELOW = 30; // ...unless they're read this badly: then they're pictures, not text
const OFFER_PICTURE = 90; // scanned pages read this well (%) or worse can be kept as a picture of the page
const MAX_TEXT_BYTES = 1024 * 1024; // typed-in text for one page
const MAX_COVER_BYTES = 20 * 1024 * 1024; // a cover picture chosen by the user
const MAX_BOXES_BYTES = 16 * 1024; // the boxes drawn around a page's pictures
const MAX_LINKS_BYTES = 64 * 1024; // the links of web pages to convert, and their book's details

const page = path.join(__dirname, 'public', 'index.html');
const vendor = {
  'epub.min.js': require.resolve('epubjs/dist/epub.min.js'),
  'jszip.min.js': require.resolve('jszip/dist/jszip.min.js'),
};
// IBM Plex, the web app's own typeface, served from here so the page works offline
const uiFontFiles = new Map(
  ['sans', 'mono'].flatMap(family =>
    [400, 500, 600].map(weight => {
      const file = `ibm-plex-${family}-latin-${weight}-normal.woff2`;
      const dir = path.dirname(require.resolve(`@fontsource/ibm-plex-${family}/package.json`));
      return [file, path.join(dir, 'files', file)];
    })
  )
);

// One per conversion: the PDF and options (to rebuild the book), previews of its
// scanned pages, the book once it's converted, and a cover picture if the user
// chose one. Only the last few are kept. An XTC conversion (for Xteink readers)
// keeps its rendered pages in `xtc` and its cover page in `xtcCover` instead.
// A book of web pages has no PDF.
const sessions = new Map();

function newSession(pdf, options) {
  const id = crypto.randomUUID();
  const session = {
    id, pdf, options, thumbnails: new Map(), book: null, cover: null, xtc: null, xtcCover: null,
    busy: false, improved: new Set(),
  };
  sessions.set(id, session);
  while (sessions.size > MAX_BOOKS) sessions.delete(sessions.keys().next().value);
  return session;
}

function readBody(req, maxBytes = MAX_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error(`Too large (max ${Math.round(maxBytes / 1024 / 1024)} MB).`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function header(req, name) {
  const value = req.headers[name];
  return value ? decodeURIComponent(value) : undefined;
}

function sendError(res, status, message) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(message);
}

function sendFile(res, file, type, cache = 'max-age=86400') {
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': cache });
  fs.createReadStream(file).pipe(res);
}

// Answer with a stream of JSON lines: progress updates, then {result} or {error}.
// `run(send, onProgress)` does the work and returns the result.
async function streamJob(res, run) {
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-cache' });
  const send = obj => res.write(JSON.stringify(obj) + '\n');
  let lastSent = 0;
  let lastStage = null;
  const onProgress = ({ stage, done, total }) => {
    // at most a few updates a second, but always the first and last of each stage
    const now = Date.now();
    if (stage === lastStage && done !== total && now - lastSent < 200) return;
    lastSent = now;
    lastStage = stage;
    send({ progress: { stage, done, total } });
  };
  try {
    send({ result: await run(send, onProgress) });
  } catch (err) {
    console.error(err);
    send({ error: err.message || 'Conversion failed.' });
  }
  res.end();
}

function bookSummary(session) {
  const { book } = session;
  const scanned = book.ocr ? [...book.ocr.pages.values()] : [];
  return {
    id: session.id,
    title: book.title,
    author: book.author,
    fileName: book.fileName,
    chapters: book.chapters.length,
    ...book.stats,
    scannedPages: scanned.length,
    ...readerSummary(book.device),
    lowPages: scanned.filter(r => !r.manual && !r.picture && r.confidence >= PICTURE_BELOW && r.confidence <= LOW_CONFIDENCE).length,
    pictures: scannedPictures(book),
    ...(book.skipped && { skipped: book.skipped }), // web pages that couldn't be read
  };
}

// Where the pictures are on each scanned page (boxes, see figures.js cleanBoxes),
// and whether the user drew them.
function scannedPictures(book) {
  if (!book.ocr) return {};
  return Object.fromEntries(
    [...book.ocr.pages].map(([n, r]) => [n, { drawn: !!r.boxes, boxes: book.pictureBoxes?.[n] || [] }])
  );
}

// The e-reader an EPUB's pictures are drawn for, for the page's preview.
function readerSummary(device) {
  const screen = readerScreen(device);
  return { device: screen.name, width: screen.width, height: screen.height };
}

function xtcSummary(session) {
  const book = session.xtc;
  const { pages, chapters, sources } = bookPages(book, session.xtcCover);
  const device = DEVICES[book.options.device];
  return {
    id: session.id,
    format: 'xtc',
    title: book.title,
    author: book.author,
    fileName: session.options.name + extensionFor(book),
    device: device.name,
    width: device.width,
    height: device.height,
    grays: book.options.grays,
    pages: pages.length,
    sourcePages: book.stats.sourcePages,
    chapters: chapters.map(ch => ({ title: ch.title, page: ch.start })),
    sources,
  };
}

// POST /convert: read the PDF (the slow part) and keep the result. The stream
// starts with {session} (its id, for page previews), then sends {page} for each
// scanned page as OCR reads it.
async function handleConvert(req, res) {
  let pdf;
  try {
    pdf = await readBody(req);
    if (pdf.subarray(0, 5).toString() !== '%PDF-') throw new Error('That file is not a PDF.');
  } catch (err) {
    return sendError(res, 400, err.message);
  }

  const fileName = header(req, 'x-filename') || 'book.pdf';
  const name = path.basename(fileName, path.extname(fileName));
  const device = header(req, 'x-device');
  const session = newSession(pdf, { title: header(req, 'x-title'), author: header(req, 'x-author'), name, ...(device && { device }) });
  if (header(req, 'x-format') === 'xtc') {
    let settings;
    try {
      settings = JSON.parse(header(req, 'x-xtc') || '{}');
    } catch {
      return sendError(res, 400, 'The XTC settings could not be read.');
    }
    return streamJob(res, async (send, onProgress) => {
      send({ session: { id: session.id } });
      const started = Date.now();
      session.xtc = await convertPdfPages(pdf, { ...settings, ...session.options, onProgress });
      console.log(
        `Converted ${fileName} to XTC: ${session.xtc.stats.pages} screens from ` +
          `${session.xtc.stats.sourcePages} pages in ${Math.round((Date.now() - started) / 1000)} s`
      );
      return xtcSummary(session);
    });
  }
  await streamJob(res, async (send, onProgress) => {
    send({
      session: { id: session.id, lowConfidence: LOW_CONFIDENCE, pictureBelow: PICTURE_BELOW, offerPicture: OFFER_PICTURE },
    });
    const started = Date.now();
    const book = await analyzePdf(pdf, {
      ...session.options,
      onProgress,
      onOcrPage: (n, { confidence, text, thumbnail }) => {
        session.thumbnails.set(n, thumbnail);
        send({ page: { n, confidence, text } });
      },
    });
    book.fileName = name + '.epub';
    session.book = book;
    console.log(
      `Converted ${fileName}: ${book.stats.pages} pages, ${book.chapters.length} chapters, ` +
        `${book.stats.images} images in ${Math.round((Date.now() - started) / 1000)} s`
    );
    return bookSummary(session);
  });
}

// POST /links: web pages (news articles) into an EPUB, one chapter per article.
// The request body is JSON: { links (text, one per line), title, author, device }.
// Answers like /convert, with progress stages 'pages', 'images' and 'finishing'.
async function handleLinks(req, res) {
  let request, links;
  try {
    request = JSON.parse((await readBody(req, MAX_LINKS_BYTES)).toString('utf8'));
    links = parseLinks(request.links || '');
  } catch (err) {
    return sendError(res, 400, err instanceof SyntaxError ? 'The links could not be read.' : err.message);
  }
  const { title, author, device } = request;
  const session = newSession(null, { title, author, ...(device && { device }) });
  await streamJob(res, async (send, onProgress) => {
    send({ session: { id: session.id } });
    const started = Date.now();
    const book = await readWebPages(links, { ...session.options, onProgress });
    session.book = book;
    console.log(
      `Converted ${book.stats.articles} of ${links.length} web pages: ${book.stats.paragraphs} paragraphs, ` +
        `${book.stats.images} pictures in ${Math.round((Date.now() - started) / 1000)} s`
    );
    return bookSummary(session);
  });
}

// POST /book/<id>/pages/<n>/retry: read one scanned page again with other
// settings, and keep the new reading if it's better. It's used the next time
// the book is rebuilt.
async function handleRetry(res, session, n) {
  const current = session.book?.ocr?.pages.get(n);
  if (!current) return sendError(res, 404, 'That page was not read with OCR.');
  if (current.manual) return sendError(res, 409, 'This page has text typed in by hand, which is kept.');
  if (current.picture) return sendError(res, 409, 'This page is kept as a picture. Use its text first.');
  if (session.busy) return sendError(res, 409, 'Busy with another page. Try again in a moment.');
  session.busy = true;
  try {
    const best = await retryPage(await openPdf(session.pdf), n, session.book.ocr.language);
    const improved = (best.confidence ?? -1) > (current.confidence ?? -1);
    if (improved) {
      session.book.ocr.pages.set(n, { ...best, ...(current.boxes && { boxes: current.boxes }) });
      session.improved.add(n);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      improved,
      before: current.confidence,
      confidence: improved ? best.confidence : current.confidence,
      tried: best.confidence,
      setting: best.setting,
      text: improved ? best.text : current.text,
      pendingPages: session.improved.size,
    }));
  } finally {
    session.busy = false;
  }
}

// POST /book/<id>/pages/<n>/text: use text typed in by hand (the request body,
// plain text) for a scanned page instead of what OCR read. Used the next time
// the book is rebuilt. A blank line separates paragraphs.
async function handleText(req, res, session, n) {
  const current = session.book?.ocr?.pages.get(n);
  if (!current) return sendError(res, 404, 'That page was not read with OCR.');
  if (session.busy) return sendError(res, 409, 'Busy updating the book. Try again in a moment.');
  let text;
  try {
    text = (await readBody(req, MAX_TEXT_BYTES)).toString('utf8');
  } catch (err) {
    return sendError(res, 400, err.message);
  }
  const typed = manualReading(text, current);
  session.book.ocr.pages.set(n, { ...typed, ...(current.boxes && { boxes: current.boxes }) });
  session.improved.add(n);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ text: typed.text, pendingPages: session.improved.size }));
}

// POST /book/<id>/pages/<n>/picture[?parts=2|3]: put the whole page in the book as
// a picture instead of its text, upright or turned sideways and cut into parts.
// DELETE: use its text again. Used the next time the book is rebuilt.
function handlePicture(res, session, n, keep, parts = 1) {
  const current = session.book?.ocr?.pages.get(n);
  if (!current) return sendError(res, 404, 'That page was not read with OCR.');
  if (session.busy) return sendError(res, 409, 'Busy updating the book. Try again in a moment.');
  const { picture, pictureParts, ...reading } = current;
  const kept = keep ? { ...reading, picture: true, ...(parts > 1 && { pictureParts: parts }) } : reading;
  session.book.ocr.pages.set(n, kept);
  session.improved.add(n);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ picture: keep, parts: keep ? parts : 1, pendingPages: session.improved.size }));
}

// POST /book/<id>/pages/<n>/boxes: use the pictures in boxes drawn by the user
// (the request body, JSON: [{ x, y, w, h }, ...], see figures.js cleanBoxes) for
// a scanned page instead of the ones found; the text outside them stays text.
// No boxes: no pictures. DELETE: use the pictures found again. Used the next time
// the book is rebuilt.
async function handleBoxes(req, res, session, n, use) {
  const current = session.book?.ocr?.pages.get(n);
  if (!current) return sendError(res, 404, 'That page was not read with OCR.');
  if (session.busy) return sendError(res, 409, 'Busy updating the book. Try again in a moment.');
  let boxes;
  try {
    if (use) boxes = cleanBoxes(JSON.parse((await readBody(req, MAX_BOXES_BYTES)).toString('utf8')));
  } catch (err) {
    return sendError(res, 400, err instanceof SyntaxError ? 'The picture boxes could not be read.' : err.message);
  }
  const { boxes: old, ...reading } = current;
  session.book.ocr.pages.set(n, use ? { ...reading, boxes } : reading);
  session.improved.add(n);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ drawn: use, boxes: boxes || null, pendingPages: session.improved.size }));
}

// POST /book/<id>/rebuild: build the book again using improved page readings.
// Pages aren't read with OCR again, so this only takes the time for pictures and chapters.
async function handleRebuild(res, session) {
  if (session.busy) return sendError(res, 409, 'Busy reading a page. Try again in a moment.');
  session.busy = true;
  try {
    await streamJob(res, async (send, onProgress) => {
      const book = await analyzePdf(session.pdf, { ...session.options, onProgress, ocr: session.book.ocr });
      book.fileName = session.book.fileName;
      session.book = book;
      session.improved.clear();
      return bookSummary(session);
    });
  } finally {
    session.busy = false;
  }
}

// POST /book/<id>/cover: use a picture (the request body) as the book's cover
// instead of the one found in the PDF. DELETE: go back to the PDF's cover.
// Kept with the session, so it stays when the book is rebuilt.
// An XTC book gets the picture as a page drawn for its reader's screen, and the
// answer has the book's new summary (a cover can add a page).
async function handleCover(req, res, session, use) {
  if (use) {
    try {
      const data = await readBody(req, MAX_COVER_BYTES);
      if (session.xtc) session.xtcCover = await coverPage(data, session.xtc);
      else session.cover = await imageCover(data, readerScreen(session.book?.device));
    } catch (err) {
      return sendError(res, 400, err.message);
    }
  } else {
    session.cover = session.xtcCover = null;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ cover: use, book: session.xtc ? xtcSummary(session) : undefined }));
}

// GET /book/<id>.xtc (or .xtch)[?download=1]: the XTC book for an Xteink reader.
function handleXtc(res, session) {
  const file = buildXtc(session.xtc, session.xtcCover);
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': file.length,
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(xtcSummary(session).fileName)}`,
  });
  res.end(file);
}

// GET /book/<id>/screens/<n>.png: page n of an XTC book as the reader shows it.
function handleScreen(res, session, n) {
  const png = pagePng(session.xtc, n, session.xtcCover);
  if (!png) return sendError(res, 404, 'No such page.');
  res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache' });
  res.end(png);
}

// GET /book/<id>.epub[?parts=2|3][&download=1]: package the book as an EPUB, with
// its full-page pictures turned sideways in 2 or 3 parts when asked.
async function handleBook(req, res, id, query) {
  const session = sessions.get(id);
  const book = session?.book;
  if (!book) return sendError(res, 404, 'This book has expired. Please convert the PDF again.');
  const epub = await buildEpub(book, { cover: session.cover, pictureParts: Number(query.get('parts')) || 1 });
  const headers = { 'Content-Type': 'application/epub+zip', 'Content-Length': epub.length };
  if (query.get('download')) {
    headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(book.fileName)}`;
  }
  res.writeHead(200, headers);
  res.end(epub);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const route = url.pathname;
  let match;

  if (req.method === 'GET' && (route === '/' || route === '/index.html')) {
    sendFile(res, page, 'text/html; charset=utf-8', 'no-cache');
  } else if (req.method === 'POST' && route === '/convert') {
    handleConvert(req, res);
  } else if (req.method === 'POST' && route === '/links') {
    handleLinks(req, res);
  } else if (req.method === 'GET' && (match = route.match(/^\/book\/([\w-]+)\.epub$/))) {
    handleBook(req, res, match[1], url.searchParams).catch(err => {
      console.error(err);
      sendError(res, 500, 'Could not build the EPUB.');
    });
  } else if (req.method === 'GET' && (match = route.match(/^\/book\/([\w-]+)(?:\.xtch?|\/screens\/(\d+)\.png)$/))) {
    const session = sessions.get(match[1]);
    if (!session?.xtc) return sendError(res, 404, 'This book has expired. Please convert the PDF again.');
    try {
      if (match[2]) handleScreen(res, session, Number(match[2]));
      else handleXtc(res, session);
    } catch (err) {
      console.error(err);
      sendError(res, 500, err.message || 'Could not build the XTC file.');
    }
  } else if ((req.method === 'POST' || req.method === 'DELETE') && (match = route.match(/^\/book\/([\w-]+)\/cover$/))) {
    const session = sessions.get(match[1]);
    if (!session) return sendError(res, 404, 'This book has expired. Please convert the PDF again.');
    handleCover(req, res, session, req.method === 'POST').catch(err => {
      console.error(err);
      if (!res.headersSent) sendError(res, 500, 'Could not use that picture as the cover.');
    });
  } else if ((match = route.match(/^\/book\/([\w-]+)\/(?:pages\/(\d+)\.jpg|pages\/(\d+)\/retry|(rebuild)|pages\/(\d+)\/text|pages\/(\d+)\/picture|pages\/(\d+)\/boxes)$/))) {
    const session = sessions.get(match[1]);
    if (!session) return sendError(res, 404, 'This book has expired. Please convert the PDF again.');
    const fail = err => {
      console.error(err);
      if (!res.headersSent) sendError(res, 500, err.message || 'Something went wrong.');
      else res.end();
    };
    if (req.method === 'GET' && match[2]) {
      const image = session.thumbnails.get(Number(match[2]));
      if (!image) return sendError(res, 404, 'No preview for that page.');
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'max-age=3600' });
      res.end(image);
    } else if (req.method === 'POST' && match[3]) {
      handleRetry(res, session, Number(match[3])).catch(fail);
    } else if (req.method === 'POST' && match[4]) {
      if (!session.book) return sendError(res, 409, 'The book is still being converted.');
      handleRebuild(res, session).catch(fail);
    } else if (req.method === 'POST' && match[5]) {
      handleText(req, res, session, Number(match[5])).catch(fail);
    } else if ((req.method === 'POST' || req.method === 'DELETE') && match[6]) {
      const parts = Number(url.searchParams.get('parts')) || 1;
      if (![1, 2, 3].includes(parts)) return sendError(res, 400, 'A page can be kept as 1, 2 or 3 pictures.');
      handlePicture(res, session, Number(match[6]), req.method === 'POST', parts);
    } else if ((req.method === 'POST' || req.method === 'DELETE') && match[7]) {
      handleBoxes(req, res, session, Number(match[7]), req.method === 'POST').catch(fail);
    } else {
      sendError(res, 404, 'Not found');
    }
  } else if (req.method === 'GET' && route === '/about.json') {
    // tells a second copy of the exe that the converter is already running here,
    // and the page which version it is
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ app: 'convertPdf', version }));
  } else if (req.method === 'GET' && (match = route.match(/^\/uifonts\/([\w.-]+)$/)) && uiFontFiles.has(match[1])) {
    sendFile(res, uiFontFiles.get(match[1]), 'font/woff2');
  } else if (req.method === 'GET' && (match = route.match(/^\/vendor\/([\w.-]+)$/)) && vendor[match[1]]) {
    sendFile(res, vendor[match[1]], 'text/javascript');
  } else {
    sendError(res, 404, 'Not found');
  }
});

// scanned books with pictures can take a few minutes to convert
server.requestTimeout = 0;

// ConvertPdf.exe sets this so double-clicking it opens the app in the browser
const openBrowser = process.env.CONVERTPDF_OPEN_BROWSER === '1' || process.argv.includes('--open');

function open(url) {
  const { spawn } = require('child_process');
  const [cmd, args] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : [process.platform === 'darwin' ? 'open' : 'xdg-open', [url]];
  spawn(cmd, args, { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
}

// Is the converter already running on this port (e.g. the exe was opened twice)?
function isConverter(port) {
  return new Promise(resolve => {
    http
      .get({ host: '127.0.0.1', port, path: '/about.json', timeout: 1500 }, res => {
        let body = '';
        res.on('data', chunk => (body += chunk));
        res.on('end', () => resolve(res.statusCode === 200 && body.includes('"convertPdf"')));
      })
      .on('error', () => resolve(false))
      .on('timeout', function () {
        this.destroy();
        resolve(false);
      });
  });
}

function listen(port, triesLeft) {
  const onListening = () => {
    server.off('error', onError);
    const url = `http://localhost:${port}`;
    console.log(`convertPdf v${version} running at ${url}`);
    if (openBrowser) {
      console.log('Keep this window open while you use the converter. Close it to stop.');
      open(url);
    }
  };
  const onError = async err => {
    // this port failed, so its "listening" handler must not fire for the next port
    server.off('listening', onListening);
    if (err.code !== 'EADDRINUSE') throw err;
    if (await isConverter(port)) {
      const url = `http://localhost:${port}`;
      console.log(`ConvertPdf is already running at ${url}`);
      if (openBrowser) open(url);
      process.exit(0);
    }
    if (triesLeft > 0) return listen(port + 1, triesLeft - 1);
    console.error(`Ports ${PORT}–${port} are all in use. Set PORT to a free port and try again.`);
    process.exit(1);
  };
  server.once('error', onError);
  server.once('listening', onListening);
  server.listen(port, '127.0.0.1');
}

listen(Number(PORT), 10);
