// Convert the pages of a PDF into an XTC book for Xteink readers. Every page is
// rendered and fitted to the reader's screen: whole, or turned sideways and cut
// into parts so its text comes out bigger. Then it's dithered to black and white
// (XTC) or 4 shades of gray (XTCH). The image steps follow XTC.js
// (https://github.com/varo6/xtcjs, MIT License).

const { createCanvas, loadImage } = require('@napi-rs/canvas');
const { renderPage } = require('./figures');
const { encodePng } = require('./eink');
const { openPdf } = require('./pdf');
const { encodeXtg, encodeXth, decodePage, buildXtcFile } = require('./xtcfile');

const DEVICES = {
  x4: { name: 'Xteink X4 / X4 Pro', width: 480, height: 800 },
  'x4-pro': { name: 'Xteink X4 Pro', width: 480, height: 800 },
  x3: { name: 'Xteink X3', width: 528, height: 792 },
};
const DITHERING = ['atkinson', 'floyd', 'sierra-lite', 'ordered', 'none'];
const ORIENTATIONS = ['landscape', 'portrait'];
const SPLITS = ['overlap', 'half', 'none'];
const SCALE = 2; // render resolution: 2 pixels per PDF point (144 dpi)

// Settings, checked, with the defaults XTC.js suggests for PDFs:
//   device: a key of DEVICES
//   grays: false for black and white (XTC), true for 4 shades of gray (XTCH)
//   orientation: 'landscape' turns pages sideways so text is bigger, 'portrait' keeps them whole
//   split: how a sideways page is cut: 'overlap' (thirds that overlap a little), 'half', 'none'
//   dithering: one of DITHERING
//   contrast: 0 (none) to 8 (maximum)
//   cropX, cropY: percent of the page cut off each side (0 to 20), for wide margins
//   firstPageIsCover: page 1 is shown whole and upright, as the book's cover
//   flip: turn sideways pages the other way
function xtcOptions(options = {}) {
  const pick = (value, allowed, name, fallback) => {
    if (value === undefined || value === '') return fallback;
    if (!allowed.includes(value)) throw new Error(`Unknown ${name} "${value}". Available: ${allowed.join(', ')}.`);
    return value;
  };
  const percent = v => Math.min(20, Math.max(0, Number(v) || 0));
  return {
    device: pick(options.device, Object.keys(DEVICES), 'device', 'x4'),
    grays: !!options.grays,
    orientation: pick(options.orientation, ORIENTATIONS, 'orientation', 'landscape'),
    split: pick(options.split, SPLITS, 'split', 'overlap'),
    dithering: pick(options.dithering, DITHERING, 'dithering', 'atkinson'),
    contrast: Math.min(8, Math.max(0, Math.round(Number(options.contrast) || 0))),
    cropX: percent(options.cropX),
    cropY: percent(options.cropY),
    firstPageIsCover: options.firstPageIsCover !== false,
    flip: !!options.flip,
  };
}

// ---------- tones and dithering ----------

// Black and white points that cut off the darkest and lightest few percent of the page.
function contrastStretch(canvas, crop, level) {
  if (!level) return null;
  const { data } = canvas.getContext('2d').getImageData(crop.x, crop.y, crop.w, crop.h);
  const counts = new Uint32Array(256);
  for (let i = 0; i < data.length; i += 4) {
    counts[Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2])]++;
  }
  const total = crop.w * crop.h;
  let black = 0;
  for (let v = 0, seen = 0; v < 256; v++) {
    if ((seen += counts[v]) >= (total * 3 * level) / 100) { black = v; break; }
  }
  let white = 255;
  for (let v = 255, seen = 0; v >= 0; v--) {
    if ((seen += counts[v]) >= (total * (3 + 9 * level)) / 100) { white = v; break; }
  }
  return white > black ? { black, white } : null;
}

function toGray(canvas, stretch) {
  const { width, height } = canvas;
  const { data } = canvas.getContext('2d').getImageData(0, 0, width, height);
  const gray = new Float32Array(width * height);
  for (let i = 0, p = 0; p < gray.length; i += 4, p++) {
    let v = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    if (stretch) v = ((v - stretch.black) * 255) / (stretch.white - stretch.black);
    gray[p] = Math.min(255, Math.max(0, v));
  }
  return gray;
}

const quantize = (v, grays) => (grays ? (v < 42.5 ? 0 : v < 127.5 ? 85 : v < 212.5 ? 170 : 255) : v >= 128 ? 255 : 0);

// Unsharp mask: brings back the crispness of text and lines lost when shrinking the page.
function sharpen(gray, width, height, amount) {
  const blurred = new Float32Array(gray.length);
  for (let y = 0; y < height; y++) {
    const up = Math.max(0, y - 1) * width, row = y * width, down = Math.min(height - 1, y + 1) * width;
    for (let x = 0; x < width; x++) {
      const l = Math.max(0, x - 1), r = Math.min(width - 1, x + 1);
      blurred[row + x] =
        (gray[up + l] + 2 * gray[up + x] + gray[up + r] +
          2 * gray[row + l] + 4 * gray[row + x] + 2 * gray[row + r] +
          gray[down + l] + 2 * gray[down + x] + gray[down + r]) / 16;
    }
  }
  for (let i = 0; i < gray.length; i++) gray[i] = Math.min(255, Math.max(0, gray[i] + amount * (gray[i] - blurred[i])));
}

// For 4 grays: lift the shadows, because the screen's dark gray shows darker than it should.
const SHADOW_LIFT = (() => {
  const gamma = 0.75, toe = 24;
  const toeTop = 255 * Math.pow(toe / 255, gamma);
  return Float32Array.from({ length: 256 }, (_, v) => (v < toe ? (v / toe) * toeTop : 255 * Math.pow(v / 255, gamma)));
})();

// Error diffusion patterns: [dx ahead, dy, weight]
const DIFFUSION = {
  floyd: [[1, 0, 7 / 16], [-1, 1, 3 / 16], [0, 1, 5 / 16], [1, 1, 1 / 16]],
  atkinson: [[1, 0, 1 / 8], [2, 0, 1 / 8], [-1, 1, 1 / 8], [0, 1, 1 / 8], [1, 1, 1 / 8], [0, 2, 1 / 8]],
  'sierra-lite': [[1, 0, 2 / 4], [-1, 1, 1 / 4], [0, 1, 1 / 4]],
};
const ERROR_CLAMP = 96; // keeps sharp edges from smearing streaks into flat areas
const BAYER_8 = [
  [0, 32, 8, 40, 2, 34, 10, 42], [48, 16, 56, 24, 50, 18, 58, 26],
  [12, 44, 4, 36, 14, 46, 6, 38], [60, 28, 52, 20, 62, 30, 54, 22],
  [3, 35, 11, 43, 1, 33, 9, 41], [51, 19, 59, 27, 49, 17, 57, 25],
  [15, 47, 7, 39, 13, 45, 5, 37], [63, 31, 55, 23, 61, 29, 53, 21],
];

// Reduce gray to the screen's shades. Error diffusion scans rows in alternate directions.
function dither(gray, width, height, method, grays) {
  sharpen(gray, width, height, grays ? 0.45 : 0.7);
  if (grays) {
    for (let i = 0; i < gray.length; i++) {
      const lo = Math.floor(gray[i]), hi = Math.min(255, lo + 1), f = gray[i] - lo;
      gray[i] = SHADOW_LIFT[lo] * (1 - f) + SHADOW_LIFT[hi] * f;
    }
  }
  const out = new Uint8Array(gray.length);
  if (method === 'ordered') {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const p = y * width + x;
        const m = (BAYER_8[y & 7][x & 7] + 0.5) / 64;
        out[p] = grays
          ? quantize(Math.min(255, Math.max(0, gray[p] + (m - 0.5) * 85)), true)
          : gray[p] > m * 255 ? 255 : 0;
      }
    }
    return out;
  }
  const spread = DIFFUSION[method];
  for (let y = 0; y < height; y++) {
    const dir = y % 2 ? -1 : 1;
    for (let i = 0; i < width; i++) {
      const x = dir > 0 ? i : width - 1 - i;
      const p = y * width + x;
      out[p] = quantize(gray[p], grays);
      if (!spread) continue;
      const error = Math.min(ERROR_CLAMP, Math.max(-ERROR_CLAMP, gray[p] - out[p]));
      for (const [dx, dy, w] of spread) {
        const xx = x + dx * dir;
        if (xx >= 0 && xx < width && y + dy < height) gray[p + dy * width + dx * dir] += error * w;
      }
    }
  }
  return out;
}

// ---------- page layout ----------

// Parts of a tall page that, turned sideways, each fill the screen: at least 3,
// overlapping by at least 5% so no line is cut in two without showing whole.
function overlapParts(w, h, screen) {
  const partHeight = Math.max(1, Math.floor(screen.width / (screen.height / w)));
  if (partHeight >= h) return [{ y: 0, h }];
  const shiftFor = count => Math.floor(partHeight - (partHeight * count - h) / (count - 1));
  let count = 3;
  while (shiftFor(count) / partHeight > 0.95 && count < 10) count++;
  const shift = shiftFor(count);
  return Array.from({ length: count }, (_, i) => ({ y: shift * i, h: i === count - 1 ? h - shift * i : partHeight }));
}

// The parts of a page (in the cropped page's pixels) and how far each is turned.
function pageParts(crop, opts, isCover) {
  const whole = [{ y: 0, h: crop.h }];
  if (isCover || opts.orientation === 'portrait') return whole.map(p => ({ ...p, turn: 0 }));
  const turn = opts.flip ? -90 : 90;
  let parts = whole;
  if (crop.w < crop.h && opts.split === 'overlap') parts = overlapParts(crop.w, crop.h, DEVICES[opts.device]);
  if (crop.w < crop.h && opts.split === 'half') {
    const half = Math.floor(crop.h / 2);
    parts = [{ y: 0, h: half }, { y: half, h: crop.h - half }];
  }
  return parts.map(p => ({ ...p, turn }));
}

// Draw a region of `source`, turned, as large as fits on a white screen.
function fitOnScreen(source, sx, sy, sw, sh, turn, screen) {
  const canvas = createCanvas(screen.width, screen.height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, screen.width, screen.height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  const [w, h] = turn ? [sh, sw] : [sw, sh];
  const scale = Math.min(screen.width / w, screen.height / h);
  ctx.translate(screen.width / 2, screen.height / 2);
  ctx.rotate((turn * Math.PI) / 180);
  ctx.drawImage(source, sx, sy, sw, sh, (-sw * scale) / 2, (-sh * scale) / 2, sw * scale, sh * scale);
  return canvas;
}

function encodeScreen(canvas, opts, stretch) {
  const { width, height } = canvas;
  const shades = dither(toGray(canvas, stretch), width, height, opts.dithering, opts.grays);
  return opts.grays ? encodeXth(shades, width, height) : encodeXtg(shades, width, height);
}

// ---------- chapters ----------

async function destinationPage(doc, dest) {
  try {
    if (typeof dest === 'string') dest = await doc.getDestination(dest);
    if (!Array.isArray(dest)) return null;
    return typeof dest[0] === 'number' ? dest[0] + 1 : (await doc.getPageIndex(dest[0])) + 1;
  } catch {
    return null;
  }
}

// The PDF's bookmarks, nested ones included, as [{ title, page }] (PDF page numbers).
async function bookmarks(doc) {
  const found = [];
  const walk = async items => {
    for (const item of items || []) {
      const page = await destinationPage(doc, item.dest);
      if (page && item.title.trim()) found.push({ title: item.title.trim(), page });
      await walk(item.items);
    }
  };
  try {
    await walk(await doc.getOutline());
  } catch {}
  return found;
}

// Bookmarks as chapters of the XTC book: `firstPart[n]` is the first book page
// made from PDF page n. Each chapter runs to the page before the next one.
function chaptersFor(marks, firstPart, pageCount) {
  const chapters = marks
    .filter(m => firstPart[m.page])
    .map(m => ({ title: m.title, start: firstPart[m.page] }))
    .sort((a, b) => a.start - b.start);
  return chapters.map((ch, i) => ({
    ...ch,
    end: Math.max(ch.start, i + 1 < chapters.length ? chapters[i + 1].start - 1 : pageCount),
  }));
}

// ---------- the book ----------

// Render a PDF's pages for an Xteink reader. Returns the encoded pages and what
// buildXtc needs; the cover can still be changed afterwards without rendering again.
// `onProgress({ stage: 'xtc', done, total })` is called after each PDF page.
async function convertPdfPages(pdfBuffer, { title, author, name = 'Untitled', onProgress = () => {}, ...settings } = {}) {
  const opts = xtcOptions(settings);
  const screen = DEVICES[opts.device];
  const doc = await openPdf(pdfBuffer);
  let meta = {};
  try {
    meta = (await doc.getMetadata()).info || {};
  } catch {}

  const pages = [];
  const sources = []; // for each book page: the PDF page it shows, and which part of it
  const firstPart = [];
  onProgress({ stage: 'xtc', done: 0, total: doc.numPages });
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const canvas = await renderPage(page, SCALE);
    page.cleanup();
    const cropX = Math.min(Math.floor((canvas.width * opts.cropX) / 100), Math.floor((canvas.width - 1) / 2));
    const cropY = Math.min(Math.floor((canvas.height * opts.cropY) / 100), Math.floor((canvas.height - 1) / 2));
    const crop = { x: cropX, y: cropY, w: canvas.width - 2 * cropX, h: canvas.height - 2 * cropY };
    const stretch = contrastStretch(canvas, crop, opts.contrast);
    firstPart[n] = pages.length + 1;
    const parts = pageParts(crop, opts, n === 1 && opts.firstPageIsCover);
    parts.forEach((part, i) => {
      const screenCanvas = fitOnScreen(canvas, crop.x, crop.y + part.y, crop.w, part.h, part.turn, screen);
      pages.push(encodeScreen(screenCanvas, opts, stretch));
      sources.push({ page: n, part: i + 1, of: parts.length, ...(part.turn && { turn: part.turn }) });
    });
    onProgress({ stage: 'xtc', done: n, total: doc.numPages });
  }

  return {
    title: title || meta.Title || name,
    author: author || meta.Author || '',
    options: opts,
    pages,
    sources,
    chapters: chaptersFor(await bookmarks(doc), firstPart, pages.length),
    stats: { sourcePages: doc.numPages, pages: pages.length },
  };
}

// A picture file (JPEG, PNG, WebP, ...) as a cover page for the book's reader.
async function coverPage(data, book) {
  let image;
  try {
    image = await loadImage(data);
  } catch {
    throw new Error('That file is not a picture that can be read. Use a JPEG, PNG or WebP image.');
  }
  const canvas = fitOnScreen(image, 0, 0, image.width, image.height, 0, DEVICES[book.options.device]);
  return encodeScreen(canvas, book.options, null);
}

// The book's pages, with `cover` (from coverPage) in place of the PDF's first
// page when that is the cover, or before it otherwise. `sources` says where each
// page comes from: { cover: true }, or { page, part, of, turn? } in the PDF.
function bookPages(book, cover) {
  const coverSource = { cover: true };
  if (book.options.firstPageIsCover) {
    const sources = [coverSource, ...book.sources.slice(1)];
    return { pages: cover ? [cover, ...book.pages.slice(1)] : book.pages, chapters: book.chapters, sources };
  }
  if (!cover) return { pages: book.pages, chapters: book.chapters, sources: book.sources };
  const chapters = book.chapters.map(ch => ({ ...ch, start: ch.start + 1, end: ch.end + 1 }));
  return { pages: [cover, ...book.pages], chapters, sources: [coverSource, ...book.sources] };
}

// The XTC (or XTCH, for 4 grays) file.
function buildXtc(book, cover = null) {
  const { pages, chapters } = bookPages(book, cover);
  return buildXtcFile(pages, { title: book.title, author: book.author, chapters });
}

// Page n (from 1) as the reader will show it, as a PNG.
function pagePng(book, n, cover = null) {
  const page = bookPages(book, cover).pages[n - 1];
  if (!page) return null;
  const { width, height, gray } = decodePage(page);
  return encodePng(gray, width, height);
}

const extensionFor = book => (book.options.grays ? '.xtch' : '.xtc');

module.exports = { DEVICES, DITHERING, xtcOptions, convertPdfPages, coverPage, bookPages, buildXtc, pagePng, extensionFor };
