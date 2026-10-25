// The converter run inside the page, for the website (GitHub Pages): the work
// server.js does for the app, done here without a server. public/index.html uses
// it when this file is loaded (window.convertPdfApi); web/build.js bundles it.

const { analyzePdf, typedParagraphs, newBookCache, buildEpub, readerScreen, contentsPagesFrom, chapterStartsFrom, looksFrom } = require('../index');
const { openPdf } = require('../pdf');
const { imageCover, titleCover, cleanBoxes } = require('../figures');
const { DEVICES, convertPdfPages, coverPage, bookPages, buildXtc, pagePng, extensionFor } = require('../xtc');
const { retryPage, pageThumbnail, manualReading, readAroundBoxes, readingWithBoxes, packReadings, unpackReadings } = require('../ocr');

const MAX_BYTES = 300 * 1024 * 1024;
const MAX_BOOKS = 8; // converted books kept, in this page's memory: the page converts several
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
    id, pdf, options, thumbnails: new Map(), scans: new Map(), book: null, cover: null, xtc: null, xtcCover: null,
    busy: false, improved: new Set(), screen: null,
    cache: newBookCache(), // what rebuilds of its book keep of the work on the PDF
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

// The page is done with a book (deleted from its list): it and its cache go.
function forget(id) {
  const s = sessions.get(id);
  if (!s) return;
  for (const url of s.thumbnails.values()) URL.revokeObjectURL(url);
  if (s.screen) URL.revokeObjectURL(s.screen);
  sessions.delete(id);
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
    ...readerSummary(book.device),
    lowPages: scanned.filter(r => !r.manual && !r.picture && r.confidence >= PICTURE_BELOW && r.confidence <= LOW_CONFIDENCE).length,
    pictures: scannedPictures(book),
    // the pages with their own text (not read with OCR): page → its text, for listing every page
    pdfPages: book.pdfTexts || {},
    ...(book.contents && { contents: book.contents }), // the book's own table of contents, when it's used
    // each chapter with the page (1-based) it starts on, and whether they're the user's own
    chapterList: book.chapters.map((ch, i) => ({
      title: ch.title, page: ch.page === undefined ? null : ch.page + 1, ...(i === 0 && ch.title === 'Opening' && { opening: true }),
    })),
    ownChapters: !!book.ownChapters,
  };
}

// Where the pictures are on each scanned page, and whether the user drew them.
function scannedPictures(book) {
  const pages = [...(book.ocr ? book.ocr.pages : [])].map(([n, r]) => [n, { drawn: !!r.boxes, boxes: book.pictureBoxes?.[n] || [] }]);
  // the pages with their own text too
  for (const n of Object.keys(book.pdfTexts || {})) pages.push([Number(n), { drawn: false, boxes: book.pictureBoxes?.[n] || [] }]);
  return Object.fromEntries(pages);
}

// The e-reader an EPUB's pictures are drawn for, for the page's preview.
function readerSummary(device) {
  const screen = readerScreen(device);
  return { device: screen.name, width: screen.width, height: screen.height };
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

// A scanned page as the page lists it (as server.js pageSummary).
function pageSummary(n, r) {
  return {
    n, confidence: r.confidence ?? null, text: r.text || '',
    ...(r.manual && { manual: true }), ...(r.picture && { picture: true, pictureParts: r.pictureParts || 1 }),
  };
}

// The scan of a page read with OCR: kept (to save with the book) and shown.
function keepScan(s, n, jpeg) {
  s.scans.set(n, jpeg);
  s.thumbnails.set(n, objectUrl(jpeg, 'image/jpeg'));
}

// Convert a PDF file. `xtc` is the XTC settings, or null for an EPUB. Reports
// progress like the server's stream: onProgress, onSession, and onPage for each
// scanned page as it's read. `readings`: the book's pages as read before (see
// readings), to open it again without reading them again.
async function convert(file, { title, author, xtc, device, firstPageCover, contentsPages, readings }, { onProgress: report = () => {}, onSession = () => {}, onPage = () => {}, signal }) {
  // a book paused while it's made (signal aborted) stops at the conversion's next step
  const onProgress = update => {
    if (signal && signal.aborted) throw new Error('Stopped: the book was paused.');
    report(update);
  };
  const pdf = await readFile(file, MAX_BYTES);
  if (pdf.subarray(0, 5).toString() !== '%PDF-') throw new Error('That file is not a PDF.');
  let saved = null;
  try {
    if (readings) saved = unpackReadings(readings);
  } catch {
    throw new Error('The saved pages could not be read.');
  }
  const name = file.name.replace(/\.[^.]*$/, '') || 'book';
  const s = newSession(pdf, {
    title: title || undefined, author: author || undefined, name, ...(device && { device }), ...(firstPageCover && { firstPageCover }),
    ...(contentsPages && { contentsPages: contentsPagesFrom(contentsPages) }), // [] for none; left out, it's looked for
  });
  onProgress({ stage: 'text', done: 0, total: 1 });
  if (xtc) {
    onSession({ id: s.id });
    s.xtc = await convertPdfPages(pdf, { ...xtc, ...s.options, onProgress });
    return xtcSummary(s);
  }
  onSession({ id: s.id, lowConfidence: LOW_CONFIDENCE, pictureBelow: PICTURE_BELOW, offerPicture: OFFER_PICTURE });
  // pages read before are listed at once, as they were left
  for (const [n, jpeg] of saved?.thumbs || []) keepScan(s, n, jpeg);
  for (const [n, r] of saved?.ocr?.pages || []) onPage(pageSummary(n, r));
  const book = await analyzePdf(pdf, {
    ...s.options,
    cache: s.cache,
    ...(saved?.ocr && { ocr: saved.ocr }),
    onProgress,
    onOcrPage: (n, { confidence, text, thumbnail }) => {
      keepScan(s, n, thumbnail);
      onPage({ n, confidence, text });
    },
  });
  book.fileName = name + '.epub';
  s.book = book;
  return bookSummary(s);
}

// The book's scanned pages as read, with every change made to them, as text to keep
// (see ocr.js packReadings); or their scans (`part` 'scans'). Null without scanned pages.
async function readings(id, part = 'pages') {
  const s = session(id);
  if (!s.book?.ocr) return null;
  return part === 'scans' ? packReadings(null, s.scans) : packReadings(s.book.ocr);
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
      s.book.ocr.pages.set(n, { ...best, ...(current.boxes && { boxes: current.boxes }) });
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
  const own = !current && s.book?.pdfTexts?.[n] !== undefined; // a page with its own text
  if (!current && !own) throw new Error('That page is not in the book.');
  if (s.busy) throw new Error('Busy updating the book. Try again in a moment.');
  if (own) {
    const typed = typedParagraphs(text).join('\n\n');
    s.book.textEdits = { ...s.book.textEdits, [n]: typed };
    s.improved.add(n);
    return { text: typed, pendingPages: s.improved.size };
  }
  const typed = manualReading(text, current);
  s.book.ocr.pages.set(n, { ...typed, ...(current.boxes && { boxes: current.boxes }) });
  s.improved.add(n);
  return { text: typed.text, pendingPages: s.improved.size };
}

// Put a scanned page in the book as a picture (keep), upright or turned sideways
// and cut into 2 or 3 parts, or its text again.
async function setPicture(id, n, keep, parts = 1) {
  const s = session(id);
  const current = s.book?.ocr?.pages.get(n);
  if (!current) throw new Error('That page was not read with OCR.');
  if (s.busy) throw new Error('Busy updating the book. Try again in a moment.');
  if (![1, 2, 3].includes(parts)) throw new Error('A page can be kept as 1, 2 or 3 pictures.');
  const { picture, pictureParts, ...reading } = current;
  s.book.ocr.pages.set(n, keep ? { ...reading, picture: true, ...(parts > 1 && { pictureParts: parts }) } : reading);
  s.improved.add(n);
  return { picture: keep, parts: keep ? parts : 1, pendingPages: s.improved.size };
}

// Use the pictures in boxes drawn by the user for a scanned page (boxes: [{ x, y, w, h }, ...],
// see figures.js cleanBoxes) instead of the ones found, or the found ones again (null).
async function setBoxes(id, n, boxes) {
  const s = session(id);
  const current = s.book?.ocr?.pages.get(n);
  if (!current) throw new Error('That page was not read with OCR.');
  if (s.busy) throw new Error('Busy updating the book. Try again in a moment.');
  const use = boxes && cleanBoxes(boxes);
  // the text beside the pictures is read again without them (a few seconds)
  s.busy = true;
  let next;
  try {
    next = await readingWithBoxes(current, use || null, async around =>
      readAroundBoxes(await openPdf(s.pdf), n, around, s.book.ocr.language)
    );
  } finally {
    s.busy = false;
  }
  s.book.ocr.pages.set(n, next);
  s.improved.add(n);
  return { drawn: !!use, boxes: use || null, text: next.text, confidence: next.confidence, pendingPages: s.improved.size };
}

// Build the book again with the changed pages.
async function rebuild(id, { onProgress = () => {} } = {}, changes = {}) {
  const s = session(id);
  if (!s.book) throw new Error('The book is still being converted.');
  if (s.busy) throw new Error('Busy reading a page. Try again in a moment.');
  // page 1 as the cover, the book's own table of contents (see server.js handleRebuild)
  const options = { ...s.options };
  if (typeof changes.firstPageCover === 'boolean') options.firstPageCover = changes.firstPageCover;
  if (changes.contentsPages === null) delete options.contentsPages; // looked for again
  else if (changes.contentsPages !== undefined) options.contentsPages = contentsPagesFrom(changes.contentsPages);
  // the chapters chosen by the user ([{ page, title }]), or the ones found again (null)
  if (changes.chapterStarts === null) delete options.chapterStarts;
  else if (changes.chapterStarts !== undefined) options.chapterStarts = chapterStartsFrom(changes.chapterStarts);
  // the pictures turned and sized by the user ({} or null: as they were found)
  if (changes.looks !== undefined) options.looks = looksFrom(changes.looks);
  if (changes.device !== undefined) {
    readerScreen(changes.device); // a reader there is, or this says which there are
    options.device = changes.device; // its pictures are drawn again for this reader's screen
  }
  s.busy = true;
  try {
    const book = await analyzePdf(s.pdf, { ...options, onProgress, ocr: s.book.ocr, ...(s.book.textEdits && { textEdits: s.book.textEdits }), cache: s.cache });
    Object.assign(book, { fileName: s.book.fileName, title: s.book.title, author: s.book.author });
    s.book = book;
    s.options = options;
    if (changes.firstPageCover === true) s.cover = null;
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
    else s.cover = await imageCover(data, readerScreen(s.book?.device));
  } else {
    s.cover = s.xtcCover = null;
  }
  return { cover: !!file, book: s.xtc ? xtcSummary(s) : undefined };
}

async function epubFile(s, pictureParts = 1, pictures = 'inline') {
  if (!s.book) throw new Error('This book has expired. Please convert the PDF again.');
  return buildEpub(s.book, { cover: s.cover, pictureParts, pictures });
}

// A converted book's title and author; an empty one goes back to the book's own.
async function setDetails(id, details) {
  const s = session(id);
  const book = s.xtc || s.book;
  if (!book) throw new Error('The book is still being converted.');
  s.own ??= { title: book.title, author: book.author };
  const text = v => (typeof v === 'string' ? v.trim().slice(0, 500) : '');
  book.title = text(details.title) || s.own.title;
  book.author = text(details.author) || s.own.author;
  // a book of web pages: its cover has the title on it, drawn again
  if (book.coverSource) book.cover = await titleCover({ ...book.coverSource, title: book.title, by: book.author }, readerScreen(book.device)).catch(() => book.cover);
  return { title: book.title, author: book.author };
}

// The EPUB, for the preview; full-page pictures in `pictureParts` parts, and the
// pictures in the text or on pages of their own (`pictures`, see buildEpub).
async function epub(id, pictureParts, pictures) {
  const file = await epubFile(session(id), pictureParts, pictures);
  return file.buffer.slice(file.byteOffset, file.byteOffset + file.length);
}

// The book's cover as it is in the book, or an XTC book's first page, as a picture address.
async function coverUrl(id) {
  const s = session(id);
  const png = s.xtc ? pagePng(s.xtc, 1, s.xtcCover) : s.cover || s.book?.cover;
  if (!png) return null;
  if (s.coverPicture) URL.revokeObjectURL(s.coverPicture);
  s.coverPicture = objectUrl(png, 'image/png');
  return s.coverPicture;
}

// The scan of a page read with OCR, as a picture address.
const scanUrl = (id, n) => sessions.get(id)?.thumbnails.get(n) || '';
// A page with its own text: its picture, drawn the first time it's asked for (a promise of its URL)
async function pageThumb(id, n) {
  const s = sessions.get(id);
  if (!s) return '';
  if (s.thumbnails.has(n)) return s.thumbnails.get(n);
  if (!s.pdf || !s.book?.pdfTexts?.[n]) return '';
  if (!s.pdfDoc) s.pdfDoc = openPdf(s.pdf);
  const jpeg = await pageThumbnail(await s.pdfDoc, n);
  if (!s.thumbnails.has(n)) s.thumbnails.set(n, objectUrl(jpeg, 'image/jpeg'));
  return s.thumbnails.get(n);
}

// Page n of an XTC book as the reader shows it, as a picture address.
async function screenUrl(id, n) {
  const s = session(id);
  const png = pagePng(s.xtc, n, s.xtcCover);
  if (!png) throw new Error('No such page.');
  if (s.screen) URL.revokeObjectURL(s.screen);
  s.screen = objectUrl(png, 'image/png');
  return s.screen;
}

// The finished book's file (EPUB or XTC), for Download all.
async function file(id, { parts = 1, pictures } = {}) {
  const s = session(id);
  return s.xtc ? buildXtc(s.xtc, s.xtcCover) : epubFile(s, parts, pictures);
}

// Save the finished book (EPUB or XTC) to the visitor's computer.
async function download(id, pictureParts, pictures) {
  const s = session(id);
  const [data, name] = s.xtc
    ? [buildXtc(s.xtc, s.xtcCover), xtcSummary(s).fileName]
    : [await epubFile(s, pictureParts, pictures), s.book.fileName];
  const url = objectUrl(data, s.xtc ? 'application/octet-stream' : 'application/epub+zip');
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// Upload the finished book to an e-reader on the same Wi-Fi, the way its own file
// transfer page does (CrossPoint firmware: POST /upload?path=<folder>, field "file").
// The reader doesn't answer pages from other sites, so the upload is sent blind;
// a website on https can't reach it at all, which the app (server.js) can.
async function send(id, { address, folder = '/', name, parts = 1, pictures } = {}) {
  const s = session(id);
  const host = String(address || '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  if (!/^[\w.-]+(:\d{1,5})?$/.test(host)) throw new Error('Type the reader’s address as it shows it, like 192.168.1.23.');
  const data = s.xtc ? buildXtc(s.xtc, s.xtcCover) : await epubFile(s, parts, pictures);
  const fileName = name || (s.xtc ? xtcSummary(s).fileName : s.book.fileName);
  const form = new FormData();
  form.append('file', new Blob([data]), fileName);
  try {
    await fetch(`http://${host}/upload?path=${encodeURIComponent(folder || '/')}`, { method: 'POST', body: form, mode: 'no-cors' });
  } catch {
    throw new Error(
      location.protocol === 'https:'
        ? `This website can’t reach the reader at ${host}: browsers block it. Use the convertPdf app to send, or download the book and upload it on the reader’s page.`
        : `Could not reach the reader at ${host}. Check it is in Wi-Fi file transfer, on the same Wi-Fi as this computer.`
    );
  }
  return { sent: fileName, address: host, folder };
}

// eslint-disable-next-line no-undef
const version = async () => __VERSION__;

window.convertPdfApi = { convert, forget, readings, retry, setText, setPicture, setBoxes, rebuild, setCover, setDetails, epub, file, coverUrl, scanUrl, pageThumb, screenUrl, download, send, version };
