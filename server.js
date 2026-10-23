// Local web UI: upload a PDF, preview the EPUB or XTC book, download it or send it to the reader.
// Usage: node server.js  then open http://localhost:3000

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { analyzePdf, buildEpub, openPdf, readerScreen, contentsPagesFrom, chapterStartsFrom } = require('./index');
const { imageCover, cleanBoxes } = require('./figures');
const { DEVICES, convertPdfPages, coverPage, bookPages, buildXtc, pagePng, extensionFor } = require('./xtc');
const { retryPage, manualReading, readAroundBoxes, readingWithBoxes, packReadings, unpackReadings } = require('./ocr');
const { parseLinks, readWebPages, previewLink } = require('./web');

const { version } = require('./package.json');

const PORT = process.env.PORT || 3000;
const MAX_BYTES = 300 * 1024 * 1024;
const MAX_BOOKS = 20; // books of PDFs kept in memory: the page converts several, each shown and changed on its own
const MAX_WEB_BOOKS = 50; // books of web pages kept: the page makes one for each link, to download each
const LOW_CONFIDENCE = 75; // scanned pages read this well (%) or worse can be read again or typed in
const PICTURE_BELOW = 30; // ...unless they're read this badly: then they're pictures, not text
const OFFER_PICTURE = 90; // scanned pages read this well (%) or worse can be kept as a picture of the page
const MAX_TEXT_BYTES = 1024 * 1024; // typed-in text for one page
const MAX_COVER_BYTES = 20 * 1024 * 1024; // a cover picture chosen by the user
const MAX_BOXES_BYTES = 16 * 1024; // the boxes drawn around a page's pictures
const MAX_DETAILS_BYTES = 16 * 1024; // a book's title and author
const MAX_CHANGES_BYTES = 512 * 1024; // a book's settings to build it again with, its own chapters among them
const MAX_LINKS_BYTES = 64 * 1024; // the links of web pages to convert, and their book's details
const MAX_SEND_BYTES = 4 * 1024; // where to send a book: the reader's address and folder
const MAX_READINGS_BYTES = 300 * 1024 * 1024; // a book's scanned pages as read, kept by the page (see ocr.js packReadings)
const READINGS_KEPT = 10 * 60 * 1000; // readings sent ahead of their PDF wait this long for it
const SEND_TIMEOUT = 10 * 60 * 1000; // the reader takes in a file slowly over Wi-Fi

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
  // the oldest of the same kind go first: books of PDFs, or books of web pages
  const same = [...sessions.values()].filter(s => !s.pdf === !pdf);
  for (const old of same.slice(0, Math.max(0, same.length - (pdf ? MAX_BOOKS : MAX_WEB_BOOKS)))) sessions.delete(old.id);
  return session;
}

// A book opened again keeps its scanned pages' reading from before (the page keeps
// it, see GET /book/<id>/readings): it's sent first (POST /readings) and its PDF
// then names it (X-Readings), so the pages aren't read again.
const uploadedReadings = new Map(); // token → { readings: unpackReadings' result, timer }

function takeReadings(token) {
  const kept = uploadedReadings.get(token);
  if (!kept) throw new Error('The saved pages were not found. Please add the PDF again.');
  clearTimeout(kept.timer);
  uploadedReadings.delete(token);
  return kept.readings;
}

async function handleReadingsUpload(req, res) {
  let readings;
  try {
    readings = unpackReadings((await readBody(req, MAX_READINGS_BYTES)).toString('utf8'));
  } catch (err) {
    return sendError(res, 400, err instanceof SyntaxError ? 'The saved pages could not be read.' : err.message);
  }
  const token = crypto.randomUUID();
  uploadedReadings.set(token, { readings, timer: setTimeout(() => uploadedReadings.delete(token), READINGS_KEPT) });
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ token }));
}

// GET /book/<id>/readings: the book's scanned pages as read, with every change made
// to them, for the page to keep; or their scans, with ?part=scans. Nothing (204) for
// a book with no scanned pages.
function handleReadings(res, session, scans) {
  const ocr = session.book?.ocr;
  if (!ocr) {
    res.writeHead(204);
    return res.end();
  }
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(scans ? packReadings(null, session.thumbnails) : packReadings(ocr));
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

// A scanned page as the page lists it: how well it was read, its text, and what was
// done to it (typed in, kept as a picture).
function pageSummary(n, r) {
  return {
    n, confidence: r.confidence ?? null, text: r.text || '',
    ...(r.manual && { manual: true }), ...(r.picture && { picture: true, pictureParts: r.pictureParts || 1 }),
  };
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
    ...(book.contents && { contents: book.contents }), // the book's own table of contents, when it's used
    // each chapter with the page (1-based) it starts on, and whether they're the user's own
    chapterList: book.chapters.map((ch, i) => ({
      title: ch.title, page: ch.page === undefined ? null : ch.page + 1, ...(i === 0 && ch.title === 'Opening' && { opening: true }),
    })),
    ownChapters: !!book.ownChapters,
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
  let contentsPages;
  try {
    const asked = header(req, 'x-contents-pages');
    if (asked === 'none') contentsPages = [];
    else if (asked) contentsPages = contentsPagesFrom(asked.split(',').map(Number));
  } catch (err) {
    return sendError(res, 400, err.message);
  }
  let saved = null; // the book opened again: its pages as read before
  try {
    if (header(req, 'x-readings')) saved = takeReadings(header(req, 'x-readings'));
  } catch (err) {
    return sendError(res, 400, err.message);
  }
  const session = newSession(pdf, {
    title: header(req, 'x-title'), author: header(req, 'x-author'), name, ...(device && { device }),
    ...(header(req, 'x-first-page-cover') === '1' && { firstPageCover: true }),
    ...(contentsPages && { contentsPages }),
  });
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
    // pages read before are listed at once, as they were left
    for (const [n, jpeg] of saved?.thumbs || []) session.thumbnails.set(n, jpeg);
    for (const [n, r] of saved?.ocr?.pages || []) send({ page: pageSummary(n, r) });
    const book = await analyzePdf(pdf, {
      ...session.options,
      ...(saved?.ocr && { ocr: saved.ocr }),
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
// The page sends one link at a time, for a book each.
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
  // the text beside the pictures is read again without them (a few seconds)
  session.busy = true;
  let next;
  try {
    next = await readingWithBoxes(current, use ? boxes : null, async around =>
      readAroundBoxes(await openPdf(session.pdf), n, around, session.book.ocr.language)
    );
  } finally {
    session.busy = false;
  }
  session.book.ocr.pages.set(n, next);
  session.improved.add(n);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    drawn: use, boxes: boxes || null, text: next.text, confidence: next.confidence, pendingPages: session.improved.size,
  }));
}

// POST /book/<id>/rebuild: build the book again using improved page readings.
// Pages aren't read with OCR again, so this only takes the time for pictures and chapters.
// The request body can change the book's settings (JSON: { firstPageCover, contentsPages, device }):
// page 1 as the cover, its text left out of the book, instead of a picture chosen; the
// pages of the book's own table of contents to take its chapters from ([] for none, null
// to look for it); the reader its pictures are drawn for. Pages aren't read again, so
// changes made to them stay.
async function handleRebuild(req, res, session) {
  if (session.busy) return sendError(res, 409, 'Busy reading a page. Try again in a moment.');
  let changes;
  try {
    const body = (await readBody(req, MAX_CHANGES_BYTES)).toString('utf8');
    changes = body ? JSON.parse(body) : {};
  } catch {
    return sendError(res, 400, 'The book’s settings could not be read.');
  }
  let options;
  try {
    options = { ...session.options };
    if (typeof changes.firstPageCover === 'boolean') options.firstPageCover = changes.firstPageCover;
    if (changes.contentsPages === null) delete options.contentsPages; // looked for again
    else if (changes.contentsPages !== undefined) options.contentsPages = contentsPagesFrom(changes.contentsPages);
    // the chapters chosen by the user ([{ page, title }]), or the ones found again (null)
    if (changes.chapterStarts === null) delete options.chapterStarts;
    else if (changes.chapterStarts !== undefined) options.chapterStarts = chapterStartsFrom(changes.chapterStarts);
    if (changes.device !== undefined) {
      if (!DEVICES[changes.device]) throw new Error(`Unknown reader "${changes.device}".`);
      options.device = changes.device; // its pictures are drawn again for this reader's screen
    }
  } catch (err) {
    return sendError(res, 400, err.message);
  }
  session.busy = true;
  try {
    await streamJob(res, async (send, onProgress) => {
      const book = await analyzePdf(session.pdf, { ...options, onProgress, ocr: session.book.ocr });
      // the same PDF, so the title and author stay as they are (maybe changed by the user)
      Object.assign(book, { fileName: session.book.fileName, title: session.book.title, author: session.book.author });
      session.book = book;
      session.options = options;
      if (changes.firstPageCover === true) session.cover = null; // page 1 is the cover, not a picture chosen
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

// POST /book/<id>/details: a converted book's title and author (JSON: { title, author }).
// An empty one goes back to the book's own (from the PDF or the article).
async function handleDetails(req, res, session) {
  const book = session.xtc || session.book;
  if (!book) return sendError(res, 409, 'The book is still being converted.');
  let details;
  try {
    details = JSON.parse((await readBody(req, MAX_DETAILS_BYTES)).toString('utf8'));
  } catch {
    return sendError(res, 400, 'The title and author could not be read.');
  }
  session.own ??= { title: book.title, author: book.author };
  const text = v => (typeof v === 'string' ? v.trim().slice(0, 500) : '');
  book.title = text(details.title) || session.own.title;
  book.author = text(details.author) || session.own.author;
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ title: book.title, author: book.author }));
}

// POST /links/preview: a web page's title, site and main picture (JSON: { link }),
// read quickly so the page's list can show them before the book is made.
async function handlePreview(req, res) {
  let link;
  try {
    link = JSON.parse((await readBody(req, MAX_LINKS_BYTES)).toString('utf8')).link;
  } catch {
    return sendError(res, 400, 'The link could not be read.');
  }
  try {
    const preview = await previewLink(link || '');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(preview));
  } catch (err) {
    sendError(res, 422, err.message);
  }
}

// GET /book/<id>/cover.png: the book's cover as it is in the book (the picture
// chosen, or its own), or an XTC book's first page.
function handleCoverPicture(res, session) {
  const png = session.xtc ? pagePng(session.xtc, 1, session.xtcCover) : session.cover || session.book?.cover;
  if (!png) return sendError(res, 404, 'This book has no cover.');
  res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache' });
  res.end(png);
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

// The finished book's file and name: the XTC book, or the EPUB with its full-page
// pictures turned sideways in `parts` parts and its pictures in the text or on pages of their own.
async function bookFile(session, { parts = 1, pictures = 'inline' } = {}) {
  if (session.xtc) return { data: buildXtc(session.xtc, session.xtcCover), name: xtcSummary(session).fileName };
  const data = await buildEpub(session.book, {
    cover: session.cover,
    pictureParts: parts,
    pictures: pictures === 'page' ? 'page' : 'inline',
  });
  return { data, name: session.book.fileName };
}

// GET /book/<id>.epub[?parts=2|3][&pictures=page][&download=1]: package the book as an
// EPUB, with its full-page pictures turned sideways in 2 or 3 parts when asked, and
// its pictures in the text or (pictures=page) on pages of their own.
async function handleBook(req, res, id, query) {
  const session = sessions.get(id);
  if (!session?.book) return sendError(res, 404, 'This book has expired. Please convert the PDF again.');
  const { data: epub, name } = await bookFile(session, {
    parts: Number(query.get('parts')) || 1,
    pictures: query.get('pictures'),
  });
  const headers = { 'Content-Type': 'application/epub+zip', 'Content-Length': epub.length };
  if (query.get('download')) {
    headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(name)}`;
  }
  res.writeHead(200, headers);
  res.end(epub);
}

// The reader's address as typed: an IP address or name on this Wi-Fi (192.168.1.23,
// crosspoint.local), with a port if it has one. Only addresses on the local network,
// so a book never leaves it.
function readerAddress(text) {
  const address = String(text || '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  const match = address.match(/^([\w.-]+)(?::(\d{1,5}))?$/);
  if (!match) throw new Error('Type the reader’s address as it shows it, like 192.168.1.23.');
  const host = match[1].toLowerCase();
  const ip = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)?.slice(1).map(Number);
  const local = ip
    ? ip.every(n => n <= 255) &&
      (ip[0] === 10 || (ip[0] === 172 && ip[1] >= 16 && ip[1] <= 31) || (ip[0] === 192 && ip[1] === 168) || (ip[0] === 169 && ip[1] === 254))
    : host.endsWith('.local') || !host.includes('.');
  if (!local) throw new Error(`${host} is not on this Wi-Fi. Type the address the reader shows, like 192.168.1.23.`);
  return match[2] ? `${host}:${match[2]}` : host;
}

// POST /book/<id>/send: upload the finished book to an e-reader on the same Wi-Fi
// (JSON: { address, folder, name, parts, pictures }), the way the reader's own
// file transfer page does (CrossPoint firmware: POST /upload?path=<folder>, the
// file in the form field "file"). `name` is the file's name on the reader.
async function handleSend(req, res, session) {
  if (!session.xtc && !session.book) return sendError(res, 409, 'The book is still being converted.');
  let request, address;
  try {
    request = JSON.parse((await readBody(req, MAX_SEND_BYTES)).toString('utf8'));
    address = readerAddress(request.address);
  } catch (err) {
    return sendError(res, 400, err instanceof SyntaxError ? 'Where to send the book could not be read.' : err.message);
  }
  const folder = '/' + String(request.folder || '').split(/[\\/]+/).filter(p => p && p !== '.' && p !== '..').join('/');
  const file = await bookFile(session, { parts: Number(request.parts) || 1, pictures: request.pictures });
  const name = path.basename(String(request.name || '')).replace(/[\x00-\x1f<>:"|?*]/g, '') || file.name;

  const form = new FormData();
  form.append('file', new Blob([file.data]), name);
  let answer;
  try {
    answer = await fetch(`http://${address}/upload?path=${encodeURIComponent(folder)}`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(SEND_TIMEOUT),
    });
  } catch (err) {
    console.error(`Could not send ${name} to ${address}:`, err.cause?.code || err.message);
    return sendError(res, 502,
      `Could not reach the reader at ${address}. Check it is in Wi-Fi file transfer, on the same Wi-Fi as this computer, and that the address is the one it shows.`);
  }
  const text = (await answer.text().catch(() => '')).trim();
  if (!answer.ok) {
    return sendError(res, 502, `The reader at ${address} did not take ${name}` + (text ? `: ${text.slice(0, 200)}` : ` (error ${answer.status}).`));
  }
  console.log(`Sent ${name} (${Math.round(file.data.length / 1024)} KB) to ${address}${folder}`);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ sent: name, address, folder }));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const route = url.pathname;
  let match;

  if (req.method === 'GET' && (route === '/' || route === '/index.html')) {
    sendFile(res, page, 'text/html; charset=utf-8', 'no-cache');
  } else if (req.method === 'POST' && route === '/convert') {
    handleConvert(req, res);
  } else if (req.method === 'POST' && route === '/readings') {
    handleReadingsUpload(req, res).catch(err => {
      console.error(err);
      if (!res.headersSent) sendError(res, 500, 'Could not keep the saved pages.');
    });
  } else if (req.method === 'GET' && (match = route.match(/^\/book\/([\w-]+)\/readings$/))) {
    const session = sessions.get(match[1]);
    if (!session) return sendError(res, 404, 'This book has expired. Please convert it again.');
    try {
      handleReadings(res, session, url.searchParams.get('part') === 'scans');
    } catch (err) {
      console.error(err);
      sendError(res, 500, 'Could not save the pages.');
    }
  } else if (req.method === 'POST' && route === '/links/preview') {
    handlePreview(req, res).catch(err => {
      console.error(err);
      if (!res.headersSent) sendError(res, 500, 'Could not read the link.');
    });
  } else if (req.method === 'GET' && (match = route.match(/^\/book\/([\w-]+)\/cover\.png$/))) {
    const session = sessions.get(match[1]);
    if (!session) return sendError(res, 404, 'This book has expired. Please convert it again.');
    try {
      handleCoverPicture(res, session);
    } catch (err) {
      console.error(err);
      sendError(res, 500, 'Could not show the cover.');
    }
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
  } else if (req.method === 'POST' && (match = route.match(/^\/book\/([\w-]+)\/details$/))) {
    const session = sessions.get(match[1]);
    if (!session) return sendError(res, 404, 'This book has expired. Please convert it again.');
    handleDetails(req, res, session).catch(err => {
      console.error(err);
      if (!res.headersSent) sendError(res, 500, 'Could not change the details.');
    });
  } else if (req.method === 'POST' && (match = route.match(/^\/book\/([\w-]+)\/send$/))) {
    const session = sessions.get(match[1]);
    if (!session) return sendError(res, 404, 'This book has expired. Please convert it again.');
    handleSend(req, res, session).catch(err => {
      console.error(err);
      if (!res.headersSent) sendError(res, 500, err.message || 'Could not send the book.');
    });
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
      handleRebuild(req, res, session).catch(fail);
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
