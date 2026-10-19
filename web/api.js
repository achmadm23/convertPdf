// The converter run inside the page, for the website (GitHub Pages): the work
// server.js does for the app, done here without a server. public/index.html uses
// it when this file is loaded (window.convertPdfApi); web/build.js bundles it.

const { analyzePdf, buildEpub } = require('../index');
const { openPdf } = require('../pdf');
const { imageCover } = require('../figures');
const { DEVICES, convertPdfPages, coverPage, bookPages, buildXtc, pagePng, extensionFor } = require('../xtc');
const { retryPage, manualReading } = require('../ocr');

const MAX_BYTES = 300 * 1024 * 1024;
const MAX_BOOKS = 2; // converted books kept, in this page's memory
const LOW_CONFIDENCE = 75; // scanned pages read this well (%) or worse can be read again or typed in
const PICTURE_BELOW = 30; // ...unless they're read this badly: then they're pictures, not text
const OFFER_PICTURE = 90; // scanned pages read this well (%) or worse can be kept as a picture of the page
const MAX_COVER_BYTES = 20 * 1024 * 1024;

// One per conversion, as in server.js: the PDF and options (to rebuild the book),
// previews of its scanned pages, the book, and a cover picture if one was chosen.
const sessions = new Map();

const objectUrl = (data, type) => URL.createObjectURL(new Blob([data], { type }));

function newSession(pdf, options) {
  const id = crypto.randomUUID();
  const session = {
    id, pdf, options, thumbnails: new Map(), book: null, cover: null, xtc: null, xtcCover: null,
    busy: false, improved: new Set(), screen: null,
  };
  sessions.set(id, session);
  while (sessions.size > MAX_BOOKS) {
    const [oldId, old] = sessions.entries().next().value;
    for (const url of old.thumbnails.values()) URL.revokeObjectURL(url);
    if (old.screen) URL.revokeObjectURL(old.screen);
    sessions.delete(oldId);
  }
  return session;
}

function session(id) {
  const s = sessions.get(id);
  if (!s) throw new Error('This book has expired. Please convert the PDF again.');
  return s;
}

async function readFile(file, maxBytes) {
  if (file.size > maxBytes) throw new Error(`Too large (max ${Math.round(maxBytes / 1024 / 1024)} MB).`);
  return Buffer.from(await file.arrayBuffer());
}

function bookSummary(s) {
  const { book } = s;
  const scanned = book.ocr ? [...book.ocr.pages.values()] : [];
  return {
    id: s.id,
    title: book.title,
    author: book.author,
    fileName: book.fileName,
    chapters: book.chapters.length,
    ...book.stats,
    scannedPages: scanned.length,
    lowPages: scanned.filter(r => !r.manual && !r.picture && r.confidence >= PICTURE_BELOW && r.confidence <= LOW_CONFIDENCE).length,
  };
}

function xtcSummary(s) {
  const book = s.xtc;
  const { pages, chapters, sources } = bookPages(book, s.xtcCover);
  const device = DEVICES[book.options.device];
  return {
    id: s.id,
    format: 'xtc',
    title: book.title,
    author: book.author,
    fileName: s.options.name + extensionFor(book),
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

// Convert a PDF file. `xtc` is the XTC settings, or null for an EPUB. Reports
// progress like the server's stream: onProgress, onSession, and onPage for each
// scanned page as it's read.
async function convert(file, { title, author, xtc }, { onProgress = () => {}, onSession = () => {}, onPage = () => {} }) {
  const pdf = await readFile(file, MAX_BYTES);
  if (pdf.subarray(0, 5).toString() !== '%PDF-') throw new Error('That file is not a PDF.');
  const name = file.name.replace(/\.[^.]*$/, '') || 'book';
  const s = newSession(pdf, { title: title || undefined, author: author || undefined, name });
  onProgress({ stage: 'text', done: 0, total: 1 });
  if (xtc) {
    onSession({ id: s.id });
    s.xtc = await convertPdfPages(pdf, { ...xtc, ...s.options, onProgress });
    return xtcSummary(s);
  }
  onSession({ id: s.id, lowConfidence: LOW_CONFIDENCE, pictureBelow: PICTURE_BELOW, offerPicture: OFFER_PICTURE });
  const book = await analyzePdf(pdf, {
    ...s.options,
    onProgress,
    onOcrPage: (n, { confidence, text, thumbnail }) => {
      s.thumbnails.set(n, objectUrl(thumbnail, 'image/jpeg'));
      onPage({ n, confidence, text });
    },
  });
  book.fileName = name + '.epub';
  s.book = book;
  return bookSummary(s);
}

// Read one scanned page again with other settings; keep the new reading if it's better.
async function retry(id, n) {
  const s = session(id);
  const current = s.book?.ocr?.pages.get(n);
  if (!current) throw new Error('That page was not read with OCR.');
  if (current.manual) throw new Error('This page has text typed in by hand, which is kept.');
  if (current.picture) throw new Error('This page is kept as a picture. Use its text first.');
  if (s.busy) throw new Error('Busy with another page. Try again in a moment.');
  s.busy = true;
  try {
    const best = await retryPage(await openPdf(s.pdf), n, s.book.ocr.language);
    const improved = (best.confidence ?? -1) > (current.confidence ?? -1);
    if (improved) {
      s.book.ocr.pages.set(n, best);
      s.improved.add(n);
    }
    return {
      improved,
      before: current.confidence,
      confidence: improved ? best.confidence : current.confidence,
      tried: best.confidence,
      setting: best.setting,
      text: improved ? best.text : current.text,
      pendingPages: s.improved.size,
    };
  } finally {
    s.busy = false;
  }
}

// Use text typed in by hand for a scanned page.
async function setText(id, n, text) {
  const s = session(id);
  const current = s.book?.ocr?.pages.get(n);
  if (!current) throw new Error('That page was not read with OCR.');
  if (s.busy) throw new Error('Busy updating the book. Try again in a moment.');
  const typed = manualReading(text, current);
  s.book.ocr.pages.set(n, typed);
  s.improved.add(n);
  return { text: typed.text, pendingPages: s.improved.size };
}

// Put a scanned page in the book as a picture (keep), or its text again.
async function setPicture(id, n, keep) {
  const s = session(id);
  const current = s.book?.ocr?.pages.get(n);
  if (!current) throw new Error('That page was not read with OCR.');
  if (s.busy) throw new Error('Busy updating the book. Try again in a moment.');
  const { picture, ...reading } = current;
  s.book.ocr.pages.set(n, keep ? { ...reading, picture: true } : reading);
  s.improved.add(n);
  return { picture: keep, pendingPages: s.improved.size };
}

// Build the book again with the changed pages.
async function rebuild(id, { onProgress = () => {} } = {}) {
  const s = session(id);
  if (!s.book) throw new Error('The book is still being converted.');
  if (s.busy) throw new Error('Busy reading a page. Try again in a moment.');
  s.busy = true;
  try {
    const book = await analyzePdf(s.pdf, { ...s.options, onProgress, ocr: s.book.ocr });
    book.fileName = s.book.fileName;
    s.book = book;
    s.improved.clear();
    return bookSummary(s);
  } finally {
    s.busy = false;
  }
}

// Use a picture as the cover (file), or the PDF's own again (null).
async function setCover(id, file) {
  const s = session(id);
  if (file) {
    const data = await readFile(file, MAX_COVER_BYTES);
    if (s.xtc) s.xtcCover = await coverPage(data, s.xtc);
    else s.cover = await imageCover(data);
  } else {
    s.cover = s.xtcCover = null;
  }
  return { cover: !!file, book: s.xtc ? xtcSummary(s) : undefined };
}

async function epubFile(s) {
  if (!s.book) throw new Error('This book has expired. Please convert the PDF again.');
  return buildEpub(s.book, { cover: s.cover });
}

// The EPUB, for the preview.
async function epub(id) {
  const file = await epubFile(session(id));
  return file.buffer.slice(file.byteOffset, file.byteOffset + file.length);
}

// The scan of a page read with OCR, as a picture address.
const scanUrl = (id, n) => sessions.get(id)?.thumbnails.get(n) || '';

// Page n of an XTC book as the reader shows it, as a picture address.
async function screenUrl(id, n) {
  const s = session(id);
  const png = pagePng(s.xtc, n, s.xtcCover);
  if (!png) throw new Error('No such page.');
  if (s.screen) URL.revokeObjectURL(s.screen);
  s.screen = objectUrl(png, 'image/png');
  return s.screen;
}

// Save the finished book (EPUB or XTC) to the visitor's computer.
async function download(id) {
  const s = session(id);
  const [data, name] = s.xtc
    ? [buildXtc(s.xtc, s.xtcCover), xtcSummary(s).fileName]
    : [await epubFile(s), s.book.fileName];
  const url = objectUrl(data, s.xtc ? 'application/octet-stream' : 'application/epub+zip');
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// eslint-disable-next-line no-undef
const version = async () => __VERSION__;

window.convertPdfApi = { convert, retry, setText, setPicture, rebuild, setCover, epub, scanUrl, screenUrl, download, version };
