// Local web UI: upload a PDF, preview the EPUB, pick a font, download.
// Usage: node server.js  then open http://localhost:3000

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { analyzePdf, buildEpub, openPdf } = require('./index');
const { retryPage, manualReading } = require('./ocr');
const { FONTS, findFont, fontFaces, fontFaceCss } = require('./fonts');

const PORT = process.env.PORT || 3000;
const MAX_BYTES = 300 * 1024 * 1024;
const MAX_BOOKS = 5; // converted books kept in memory so fonts can be switched quickly
const LOW_CONFIDENCE = 75; // scanned pages read this well (%) or worse can be read again or typed in
const PICTURE_BELOW = 30; // ...unless they're read this badly: then they're pictures, not text
const MAX_TEXT_BYTES = 1024 * 1024; // typed-in text for one page

const page = path.join(__dirname, 'public', 'index.html');
const vendor = {
  'epub.min.js': require.resolve('epubjs/dist/epub.min.js'),
  'jszip.min.js': require.resolve('jszip/dist/jszip.min.js'),
};
const fontFiles = new Map(FONTS.flatMap(f => fontFaces(f).map(face => [face.file, face.path])));

// One per conversion: the PDF and options (to rebuild the book), previews of its
// scanned pages, and the book once it's converted. Only the last few are kept.
const sessions = new Map();

function newSession(pdf, options) {
  const id = crypto.randomUUID();
  const session = { id, pdf, options, thumbnails: new Map(), book: null, busy: false, improved: new Set() };
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
    lowPages: scanned.filter(r => !r.manual && r.confidence >= PICTURE_BELOW && r.confidence <= LOW_CONFIDENCE).length,
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
  const session = newSession(pdf, { title: header(req, 'x-title'), author: header(req, 'x-author'), name });
  await streamJob(res, async (send, onProgress) => {
    send({ session: { id: session.id, lowConfidence: LOW_CONFIDENCE, pictureBelow: PICTURE_BELOW } });
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

// POST /book/<id>/pages/<n>/retry: read one scanned page again with other
// settings, and keep the new reading if it's better. It's used the next time
// the book is rebuilt.
async function handleRetry(res, session, n) {
  const current = session.book?.ocr?.pages.get(n);
  if (!current) return sendError(res, 404, 'That page was not read with OCR.');
  if (current.manual) return sendError(res, 409, 'This page has text typed in by hand, which is kept.');
  if (session.busy) return sendError(res, 409, 'Busy with another page. Try again in a moment.');
  session.busy = true;
  try {
    const best = await retryPage(await openPdf(session.pdf), n, session.book.ocr.language);
    const improved = (best.confidence ?? -1) > (current.confidence ?? -1);
    if (improved) {
      session.book.ocr.pages.set(n, best);
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
  session.book.ocr.pages.set(n, typed);
  session.improved.add(n);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ text: typed.text, pendingPages: session.improved.size }));
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

// GET /book/<id>.epub?font=<id>[&download=1]: package the book with a font.
async function handleBook(req, res, id, query) {
  const book = sessions.get(id)?.book;
  if (!book) return sendError(res, 404, 'This book has expired. Please convert the PDF again.');
  const font = findFont(query.get('font'));
  const epub = await buildEpub(book, { font: font.id });
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
  } else if (req.method === 'GET' && (match = route.match(/^\/book\/([\w-]+)\.epub$/))) {
    handleBook(req, res, match[1], url.searchParams).catch(err => {
      console.error(err);
      sendError(res, 500, 'Could not build the EPUB.');
    });
  } else if ((match = route.match(/^\/book\/([\w-]+)\/(?:pages\/(\d+)\.jpg|pages\/(\d+)\/retry|(rebuild)|pages\/(\d+)\/text)$/))) {
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
    } else {
      sendError(res, 404, 'Not found');
    }
  } else if (req.method === 'GET' && route === '/fonts.json') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(FONTS.map(f => ({ id: f.id, name: f.name, fallback: f.fallback, embedded: !!f.pkg }))));
  } else if (req.method === 'GET' && route === '/fonts.css') {
    // lets the upload page show each font option in its own typeface
    res.writeHead(200, { 'Content-Type': 'text/css' });
    res.end(FONTS.map(f => fontFaceCss(f, '/fontfiles/')).join('\n'));
  } else if (req.method === 'GET' && (match = route.match(/^\/fontfiles\/([\w.-]+)$/)) && fontFiles.has(match[1])) {
    sendFile(res, fontFiles.get(match[1]), 'font/woff');
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
      .get({ host: '127.0.0.1', port, path: '/fonts.json', timeout: 1500 }, res => {
        res.resume();
        resolve(res.statusCode === 200 && /json/.test(res.headers['content-type'] || ''));
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
    console.log(`PDF to EPUB converter running at ${url}`);
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
