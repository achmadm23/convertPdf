// Convert the text of a PDF into an EPUB 3 file.
// Usage: node index.js input.pdf [output.epub] [--title "My Book"] [--author "Name"]
//    or: node index.js https://... [more links] [output.epub or folder]   (web pages, see web.js)

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const JSZip = require('jszip');
const { measureLayout, layoutMeasures, findGaps, detectFigures, sidewaysParts, renderCover, imageCover, turned } = require('./figures');
const { screenImage } = require('./eink');
const { findPagePictures } = require('./picture-pages');
const { recognizePages, finishPages, LANGUAGES } = require('./ocr');
const { openPdf } = require('./pdf');
const { DEVICES, DITHERING, convertPdfPages, coverPage, bookPages, buildXtc, extensionFor } = require('./xtc');

function parseArgs(argv) {
  const opts = { positional: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--title') opts.title = argv[++i];
    else if (argv[i] === '--author') opts.author = argv[++i];
    else if (argv[i] === '--cover') opts.cover = argv[++i];
    else if (argv[i] === '--picture-parts') opts.pictureParts = Number(argv[++i]);
    else if (argv[i] === '--pictures') opts.pictures = argv[++i];
    else if (argv[i] === '--ocr-lang') opts.ocrLanguage = argv[++i];
    // XTC (Xteink) output
    else if (argv[i] === '--format') opts.format = argv[++i];
    else if (argv[i] === '--device') opts.device = argv[++i];
    else if (argv[i] === '--orientation') opts.orientation = argv[++i];
    else if (argv[i] === '--split') opts.split = argv[++i];
    else if (argv[i] === '--dither') opts.dithering = argv[++i];
    else if (argv[i] === '--contrast') opts.contrast = argv[++i];
    else if (argv[i] === '--crop') [opts.cropX, opts.cropY = opts.cropX] = argv[++i].split(',');
    else if (argv[i] === '--no-cover-page') opts.firstPageIsCover = false;
    else if (argv[i] === '--flip') opts.flip = true;
    else if (argv[i].startsWith('--')) throw new Error(`Unknown option "${argv[i]}".`);
    else opts.positional.push(argv[i]);
  }
  return opts;
}

function escapeXml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    // strip control characters that are invalid in XML
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

const letterCount = s => (s.match(/\p{L}/gu) || []).length;
// page and chapter numbers, allowing a stray symbol or two from scanning noise (e.g. "'32", "■55")
const isNumberLike = s => /^[^\p{L}\d]{0,2}(\d{1,4}|[ivxlc]{1,6})[^\p{L}\d]{0,2}$/iu.test(s);

// Rebuild lines from positioned text items, keeping position and font size.
function pageToLines(items) {
  const lines = [];
  let line = null;

  const flush = () => {
    if (line) lines.push(line);
    line = null;
  };
  for (const item of items) {
    if (typeof item.str !== 'string') continue;
    const [, , c, d, x, y] = item.transform;
    if (line && Math.abs(y - line.y) > 1) flush();
    if (!line) line = { text: '', y, x: Infinity, xEnd: -Infinity, size: 0, sizeChars: 0 };
    line.text += item.str;
    const chars = item.str.trim().length;
    if (chars) {
      line.x = Math.min(line.x, x);
      line.xEnd = Math.max(line.xEnd, x + (item.width || 0));
      // the line's size is the font size of its longest piece of text
      if (chars > line.sizeChars) {
        line.size = Math.round(Math.hypot(c, d));
        line.sizeChars = chars;
      }
    }
    if (item.hasEOL) flush();
  }
  flush();

  const cleaned = lines
    .map(l => ({ ...l, text: l.text.replace(/\s+/g, ' ').trim() }))
    .filter(l => l.text);
  return readingOrder(cleaned);
}

// Lines in reading order, top to bottom. Most PDFs list their text that way
// already, but some (machine-translated ones, for example) list blocks in any
// order: a line that jumps back up the page in the same column gives that away,
// and then the page is sorted by position. A jump up into a column further
// right is just the next column, so pages with columns keep their own order.
function readingOrder(lines) {
  const jumbled = lines.some((l, i) => {
    const prev = lines[i - 1];
    return prev && l.y > prev.y + Math.max(l.size, prev.size, 6) && l.x < prev.x + 40;
  });
  if (!jumbled) return lines;
  // lines at the same height read left to right
  return [...lines].sort((a, b) => (Math.abs(a.y - b.y) <= 2 ? a.x - b.x : b.y - a.y));
}

// An OCR line without the words read inside a picture (a sign, a speech bubble,
// or marks of the picture read as letters), or null when none of it is left.
function wordsOutside(l, fig) {
  const inside = (x, y) => x >= fig.left - 2 && x <= fig.right + 2 && y >= fig.bottom - 2 && y <= fig.top + 2;
  if (l.image || !l.words) return l.image || !inside((l.x + l.xEnd) / 2, l.y + l.size / 2) ? l : null;
  const words = l.words.filter(w => !inside((w.x + w.xEnd) / 2, (w.top + w.bottom) / 2));
  if (words.length === l.words.length) return l;
  if (!words.some(w => /[\p{L}\d]/u.test(w.text))) return null;
  return { ...l, words, text: words.map(w => w.text).join(' '), x: words[0].x, xEnd: words[words.length - 1].xEnd };
}

// Lines in a column beside a picture: their own left (or right) edge is the
// column's, so they read as one paragraph instead of each looking indented (or short).
function besidePicture(lines, fig) {
  const beside = l => !l.image && l.y < fig.top && (l.top ?? l.y + l.size) > fig.bottom;
  const right = lines.filter(l => beside(l) && l.x >= fig.right - 2);
  const left = lines.filter(l => beside(l) && l.xEnd <= fig.left + 2);
  // the column's edge is where most of its lines start (or end), not the furthest
  // one: OCR can stretch the first word of a line over a stroke of the picture next
  // to it, and that one line would make all the others look indented
  const quarter = (values, from) => [...values].sort((a, b) => from * (a - b))[Math.floor(values.length / 4)];
  const colLeft = right.length ? quarter(right.map(l => l.x), 1) : null;
  const colRight = left.length ? quarter(left.map(l => l.xEnd), -1) : null;
  return lines.map(l =>
    right.includes(l) ? { ...l, colLeft } : left.includes(l) ? { ...l, colRight } : l
  );
}

// Group a page's lines into blocks: headings (text noticeably larger than the
// body font) and paragraphs.
function linesToBlocks(lines, bodySize) {
  const headingMin = bodySize * 1.4;
  const isHeading = l => !l.image && l.size >= headingMin && l.text.length <= 120;
  const body = lines.filter(l => !l.image && !isHeading(l));

  // typical left and right edges of the text block
  const round = v => Math.round(v / 2) * 2;
  const counts = new Map();
  for (const l of body) counts.set(round(l.x), (counts.get(round(l.x)) || 0) + 1);
  const leftEdge = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
  const ends = body.map(l => l.xEnd).sort((a, b) => a - b);
  const rightEdge = ends.length ? ends[Math.floor(ends.length * 0.9)] : 0;

  const gaps = [];
  for (let i = 1; i < body.length; i++) {
    const gap = Math.abs(body[i - 1].y - body[i].y);
    if (gap > 0) gaps.push(gap);
  }
  gaps.sort((a, b) => a - b);
  const normalGap = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0;

  const blocks = [];
  let block = null;
  let prev = null;
  let pendingImages = [];
  let afterImage = false;
  const flush = () => {
    if (block) blocks.push(block);
    block = null;
    for (const image of pendingImages) blocks.push({ image });
    pendingImages = [];
  };

  for (const l of lines) {
    if (l.image) {
      // a sentence that runs around a picture stays one paragraph; the picture follows it
      if (block && !block.heading && !/[.!?:;"”’)\]]$/.test(block.text)) {
        pendingImages.push(l.image);
        afterImage = true;
      } else {
        flush();
        blocks.push({ image: l.image });
      }
      continue;
    }
    if (isHeading(l)) {
      // large text that is neither words nor a chapter number is image noise
      if (letterCount(l.text) < 3 && !isNumberLike(l.text)) continue;
      const continues =
        block && block.heading && !isNumberLike(block.text) && !isNumberLike(l.text) &&
        Math.abs(block.size - l.size) <= 2 && prev && Math.abs(prev.y - l.y) < l.size * 2;
      if (continues) block.text += ' ' + l.text; // heading wrapped onto a second line
      else {
        flush();
        block = { heading: true, text: l.text, size: l.size };
      }
    } else {
      const bigGap = !afterImage && prev && normalGap && Math.abs(prev.y - l.y) > normalGap * 1.5;
      const indented = l.x > (l.colLeft ?? leftEdge) + 6;
      const prevShort = prev && prev.xEnd < (prev.colRight ?? rightEdge) - 25 && /[.!?:"”’)]$/.test(prev.text);
      if (block && (block.heading || bigGap || indented || prevShort)) flush();
      afterImage = false;
      if (!block) block = { heading: false, text: l.text, size: l.size };
      else if (block.text.endsWith('-')) block.text = block.text.slice(0, -1) + l.text; // join hyphenated words
      else block.text += ' ' + l.text;
    }
    prev = l;
  }
  flush();
  return blocks;
}

// `onProgress({ stage, done, total })` is called as pages are processed.
// Stages: 'text' (reading every page), 'ocr' (reading pages that have no text,
// only when there are some), 'pictures' (rendering pages that may hold pictures).
// OCR options:
//   ocrLanguage: a language code from ocr.js; empty means detect it
//   ocr: the `ocr` result of an earlier run on the same PDF, whose pages aren't read again
//   onOcrPage(n, { confidence, text, thumbnail }): called as each scanned page is read
// The result's `ocr` holds every scanned page's reading, for passing back in later.
// firstPageCover: page 1 is the cover, whatever is on it, and its text is left out
// (chosen in the web UI); otherwise page 1 is the cover only if it's mostly a picture.
// contentsPages: the pages of the book's own table of contents (chosen in the web UI),
// [] for none, or left out to look for it in the first and last pages of the book;
// the result's `contentsLines` are those pages' lines ([page, lines] each), read
// before anything else is done to them.
// The result's `printed` is the page number printed on each page, where there is one.
// cache: an object (newBookCache) kept with the book and passed to each rebuild of the
// same PDF: its pages' text and the pictures found on them are kept in it, so a rebuild
// only draws again the pages whose pictures could come out otherwise.
// looks: how the user turned and sized pictures (see looksFrom), by "page:number".
async function extractPdf(buffer, onProgress = () => {}, { ocrLanguage, ocr: previous, onOcrPage, screen, firstPageCover = false, contentsPages, cache, looks = {} } = {}) {
  const doc = await openPdf(buffer);

  let meta = {};
  try {
    meta = (await doc.getMetadata()).info || {};
  } catch {}

  let pageLines = [];
  if (cache?.text) pageLines = structuredClone(cache.text);
  else {
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      pageLines.push(pageToLines(content.items));
      onProgress({ stage: 'text', done: n, total: doc.numPages });
    }
    if (cache) cache.text = structuredClone(pageLines);
  }

  // pages with no text layer are scans: read them with OCR
  const scanned = [];
  pageLines.forEach((lines, i) => {
    if (letterCount(lines.map(l => l.text).join('')) < 20) scanned.push(i + 1);
  });
  // every line found on the page, even ones left out of the text, for the page layout
  const layoutLines = [...pageLines];
  // scanned pages kept whole as a picture instead of their text (chosen in the web UI);
  // they have no lines until the picture is put in, after pictures are found
  const picturePages = new Set();
  let ocr = null;
  // how many parts a page kept as a picture is cut into (1: the whole page upright)
  const pictureParts = n => (picturePages.has(n) && ocr?.pages.get(n)?.pictureParts) || 1;
  if (scanned.length) {
    const readings = new Map(scanned.filter(n => previous?.pages.has(n)).map(n => [n, previous.pages.get(n)]));
    const fresh = await recognizePages(
      doc,
      scanned.filter(n => !readings.has(n)),
      { language: previous?.language || ocrLanguage, onProgress, onPage: onOcrPage }
    );
    for (const [n, r] of fresh.pages) readings.set(n, r);
    ocr = { language: fresh.language || previous?.language, pages: readings };
    for (const [n, r] of readings) {
      if (!r.picture) continue;
      picturePages.add(n);
      layoutLines[n - 1] = pageLines[n - 1] = [];
    }
    const textReadings = new Map([...readings].filter(([n]) => !picturePages.has(n)));
    for (const [n, lines] of finishPages(textReadings)) {
      layoutLines[n - 1] = lines;
      pageLines[n - 1] = lines.filter(l => !l.unreadable);
    }
  }

  // the body font size is the one used for the most text
  const sizeChars = new Map();
  for (const l of pageLines.flat()) sizeChars.set(l.size, (sizeChars.get(l.size) || 0) + l.text.length);
  const bodySize = [...sizeChars.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 10;

  const layout = measureLayout(pageLines, bodySize);
  // Work on a page done before with the same inputs (see newBookCache), else done now
  // and kept: `slot` names the work, one kept result each.
  const measures = JSON.stringify([layoutMeasures(layout), screen]);
  const keyOf = inputs => crypto.createHash('md5').update(Buffer.from(JSON.stringify(inputs) + measures)).digest().toString('hex');
  const kept = async (slot, inputs, make) => {
    if (!cache) return make();
    const key = keyOf(inputs);
    const was = cache.work.get(slot);
    if (was && was.key === key) return was.value;
    const value = await make();
    cache.work.set(slot, { key, value });
    return value;
  };
  const printed = printedPageNumbers(pageLines);
  const tocPages = contentsPages ?? [...new Set([
    ...pageLines.slice(0, CONTENTS_FRONT).map((_, i) => i + 1),
    ...pageLines.map((_, i) => i + 1).slice(-CONTENTS_BACK),
  ])];
  const contentsLines = tocPages.filter(n => n >= 1 && n <= pageLines.length).map(n => [n, pageLines[n - 1]]);
  // pages read with OCR word by word are searched for pictures anywhere on them,
  // beside the text too; other pages only between paragraphs (findGaps)
  const readWords = new Set(
    scanned.filter(n => !picturePages.has(n) && !ocr.pages.get(n)?.manual && layoutLines[n - 1].some(l => l.words))
  );
  // pages whose pictures the user drew boxes around (see figures.js cleanBoxes):
  // those are its pictures, instead of the ones found
  const drawn = n => ocr?.pages.get(n)?.boxes;
  const mayHavePictures = n =>
    drawn(n) ? drawn(n).length > 0 : readWords.has(n) || findGaps(pageLines[n - 1], layout, bodySize).length > 0;
  const hasCoverCandidate = pageLines.length > 0 && pageLines[0].filter(layout.isLong).length < 5;
  const coverChecked = pageLines.length > 0 && (firstPageCover || hasCoverCandidate);
  const firstChecked = coverChecked ? 2 : 1;
  const candidates = [];
  for (let n = firstChecked; n <= doc.numPages; n++) {
    if (!picturePages.has(n) && mayHavePictures(n)) candidates.push(n);
  }
  const renders = candidates.length + picturePages.size + (coverChecked ? 1 : 0);
  let rendered = 0;
  onProgress({ stage: 'pictures', done: 0, total: renders });

  let cover = null;
  const coverOfPage1 = () => kept('cover', [], async () => renderCover(await doc.getPage(1), screen));
  if (firstPageCover && pageLines.length > 0) {
    cover = await coverOfPage1();
    pageLines[0] = [];
    picturePages.delete(1); // it's the cover, so not a picture in the text as well
    onProgress({ stage: 'pictures', done: ++rendered, total: renders });
  } else if (hasCoverCandidate && pictureParts(1) === 1 && !drawn(1)) {
    // a first page that is mostly picture with hardly any body text is the cover,
    // unless it was kept as a picture in parts, which go in the book instead
    const big = await kept('coverCheck', pageLines[0], async () => {
      const first = await doc.getPage(1);
      const height = first.view[3] - first.view[1];
      const [picture] = await detectFigures(first, pageLines[0], [{ top: height, bottom: 0 }], layout, screen);
      return !!picture && picture.top - picture.bottom > height * 0.5;
    });
    if (big) {
      cover = await coverOfPage1();
      pageLines[0] = [];
      picturePages.delete(1); // it's the cover, so not a picture in the text as well
    }
    onProgress({ stage: 'pictures', done: ++rendered, total: renders });
  }
  // page 1 wasn't the cover after all, so check it for pictures like any other page
  if (hasCoverCandidate && !cover && !picturePages.has(1) && mayHavePictures(1)) {
    candidates.unshift(1);
  }

  // crop pictures from pages with gaps in their text, and put them in the
  // text flow in place of the labels it contains
  const images = [];
  // where the pictures are on each scanned page, as boxes like the ones drawn
  // (cleanBoxes), for showing them on the page
  const pictureBoxes = {};
  // the pages are searched several at once (picture-pages.js), then their
  // pictures go in the text page by page, in order
  // the pictures of page n the user turned, by their number on it
  const turnsOf = n => Object.fromEntries(Object.entries(looks)
    .filter(([key, look]) => look.rotate && Number(key.split(':')[0]) === n)
    .map(([key, look]) => [Number(key.split(':')[1]), look.rotate]));
  const tasks = candidates.map(n => {
    const turns = turnsOf(n);
    return {
      ...(drawn(n)
        ? { n, find: 'drawn', boxes: drawn(n) }
        : readWords.has(n)
          ? { n, find: 'words', lines: layoutLines[n - 1] }
          : { n, find: 'gaps', lines: pageLines[n - 1], gaps: findGaps(pageLines[n - 1], layout, bodySize) }),
      ...(Object.keys(turns).length && { turns }),
    };
  });
  // pages searched before with the same lines, gaps or boxes keep what was found
  const found = new Map();
  const keys = new Map();
  const todo = [];
  for (const task of tasks) {
    const { n, ...inputs } = task;
    const key = cache && keyOf(inputs);
    const was = cache?.work.get(`page:${n}`);
    if (was && was.key === key) {
      found.set(n, was.value);
      onProgress({ stage: 'pictures', done: Math.min(++rendered, renders), total: renders });
    } else {
      keys.set(n, key);
      todo.push(task);
    }
  }
  const searched = await findPagePictures(buffer, doc, todo, layout, screen, () =>
    onProgress({ stage: 'pictures', done: Math.min(++rendered, renders), total: renders })
  );
  for (const [n, result] of searched) {
    found.set(n, result);
    if (cache) cache.work.set(`page:${n}`, { key: keys.get(n), value: result });
  }
  for (const n of candidates) {
    const { figures, pageWidth, pageHeight } = found.get(n);
    if (ocr?.pages.has(n)) {
      const share = v => Math.round(v * 10000) / 10000;
      pictureBoxes[n] = figures.map(f => ({
        x: share(f.left / pageWidth), y: share(1 - f.top / pageHeight),
        w: share((f.right - f.left) / pageWidth), h: share((f.top - f.bottom) / pageHeight),
      }));
    }
    for (const [j, fig] of figures.entries()) {
      const name = `img${images.length + 1}.png`;
      // a portrait picture filling most of its page also comes turned sideways in
      // 2 or 3 parts (buildEpub's pictureParts, see figures.js pagePictures); each
      // picture knows its page and number there, and the size the user gave it
      const size = looks[`${n}:${j}`]?.size;
      images.push({ name, data: fig.data, page: n, pic: j, ...(size && { size }), ...(fig.split && { split: fig.split }) });
      // text shown inside the cropped picture is dropped; anything outside it stays.
      // Text typed in by hand all stays: it isn't where it was on the page
      const lines = ocr?.pages.get(n)?.manual
        ? [...pageLines[n - 1]]
        : readWords.has(n)
        ? besidePicture(pageLines[n - 1].map(l => wordsOutside(l, fig)).filter(Boolean), fig)
        : pageLines[n - 1].filter(l => !(l.y <= fig.top + 2 && l.y >= fig.bottom - 2 && l.x >= fig.left - 2 && l.xEnd <= fig.right + 2));
      const at = lines.findIndex(l => l.y < fig.top);
      lines.splice(at < 0 ? lines.length : at, 0, { image: name, y: fig.top });
      pageLines[n - 1] = lines;
    }
  }

  // pages kept as a picture: the whole page, cropped to its ink like a cover,
  // upright or turned sideways and cut into 2 or 3 parts
  for (const n of picturePages) {
    const parts = pictureParts(n);
    const turn = looks[`${n}:0`]?.rotate || 0; // the whole page is its one picture
    const picture = await kept(`whole:${n}`, [parts, turn], async () => {
      const page = await doc.getPage(n);
      const height = page.view[3] - page.view[1];
      const [found] = await detectFigures(page, [], [{ top: height, bottom: 0 }], layout, screen);
      page.cleanup();
      if (!found) return null;
      const crop = turned(found.crop, turn);
      return { top: found.top, parts: parts > 1 ? sidewaysParts(crop, parts, screen) : [turn ? screenImage(crop, screen) : found.data] };
    });
    onProgress({ stage: 'pictures', done: Math.min(++rendered, renders), total: renders });
    if (!picture) continue; // a blank page
    pageLines[n - 1] = picture.parts.map((data, i) => {
      const name = `img${images.length + 1}.png`;
      const size = looks[`${n}:0`]?.size;
      images.push({ name, data, page: n, pic: 0, ...(size && parts === 1 && { size }), ...(parts > 1 && { sideways: true }) });
      return { image: name, y: picture.top - i };
    });
  }

  const startsLow = lowStartPages(pageLines, layoutLines, layout);
  const pages = pageLines.map(lines => linesToBlocks(lines, bodySize));
  return { pages, images, cover, startsLow, ocr, pictureBoxes, printed, contentsLines, title: meta.Title, author: meta.Author };
}

// How the user turned and sized pictures, as sent by the web app, made safe: by
// "page:number" (number: the picture's place among its page's, from 0), a turn of 90,
// 180 or 270 degrees clockwise and a width of 20 to 100 (% of the screen's).
function looksFrom(value) {
  const looks = {};
  for (const [key, look] of Object.entries(value || {}).slice(0, 5000)) {
    if (!/^\d{1,5}:\d{1,3}$/.test(key) || !look || typeof look !== 'object') continue;
    const rotate = [90, 180, 270].includes(look.rotate) ? look.rotate : 0;
    const size = Number.isInteger(look.size) && look.size >= 20 && look.size < 100 ? look.size : 0;
    if (rotate || size) looks[key] = { ...(rotate && { rotate }), ...(size && { size }) };
  }
  return looks;
}

// What a book's rebuilds keep of the work done on its PDF (see extractPdf's `cache`):
// its pages' text, and each page's pictures with what they were found from.
const newBookCache = () => ({ text: null, work: new Map() });

// Pages whose text starts far below the usual top of the text block, under a
// title or picture, as on the first page of a chapter. They find the chapters of
// books whose chapter titles aren't text, like decorative lettering in a scan.
// `layoutLines` also has the lines OCR couldn't read, which still show where the text starts.
function lowStartPages(pageLines, layoutLines, layout) {
  const blockHeight = layout.blockTop - layout.blockBottom;
  return pageLines.map((lines, i) => {
    const long = layoutLines[i].filter(l => !l.image && layout.isLong(l));
    if (long.length < 3 || !blockHeight) return false;
    const firstTop = Math.max(...long.map(l => l.y));
    // a page that just starts low with nothing above, like a notice box, isn't a chapter
    const titled = lines.some(l => l.y > firstTop + 1 && (l.image || letterCount(l.text) >= 1));
    return titled && layout.blockTop - firstTop > blockHeight * 0.3;
  });
}

// Remove page numbers and running headers/footers, then rejoin paragraphs
// that were cut in half by a page break.
function cleanPages(pages) {
  const edgeCounts = new Map();
  for (const page of pages) {
    const edges = new Set([...page.slice(0, 2), ...page.slice(-2)].map(b => b.text).filter(Boolean));
    for (const t of edges) if (t.length < 80) edgeCounts.set(t, (edgeCounts.get(t) || 0) + 1);
  }
  // body-size text that sits at the top/bottom of many pages is a running header or footer
  const isText = b => !b.heading && !b.image;
  const isRunning = b => isText(b) && b.text.length < 80 && (edgeCounts.get(b.text) || 0) >= 4;
  const isPageNumber = b => isText(b) && isNumberLike(b.text);

  const cleaned = pages.map(page => {
    const out = page.filter(b => !isRunning(b));
    while (out.length && isPageNumber(out[0])) out.shift();
    while (out.length && isPageNumber(out[out.length - 1])) out.pop();
    return out;
  });

  // join onto the last page that still has text, since a page may be emptied by an earlier join
  let prev = null;
  for (const cur of cleaned) {
    if (prev && cur.length) {
      const last = prev[prev.length - 1];
      const next = cur[0];
      if (
        isText(last) && isText(next) &&
        !/[.!?:;"”’)\]]$/.test(last.text) && /^[a-zÀ-ɏ(“"‘']/.test(next.text)
      ) {
        last.text = last.text.endsWith('-') ? last.text.slice(0, -1) + next.text : last.text + ' ' + next.text;
        cur.shift();
      }
    }
    if (cur.length) prev = cur;
  }
  return cleaned;
}

// Start a new chapter on every page whose biggest heading is chapter-sized.
// Chapter size is the smallest heading size that appears on few enough pages
// to be chapters rather than sections. Without such headings, chapters start on
// the pages flagged in `startsLow`, or failing that, every 10 pages.
function buildChapters(pages, startsLow = []) {
  const pageMax = pages.map(page =>
    Math.max(0, ...page.filter(b => b.heading && letterCount(b.text) >= 3).map(b => b.size))
  );
  const maxChapters = Math.max(2, Math.floor(pages.length / 8));
  const sizes = [...new Set(pageMax.filter(Boolean))].sort((a, b) => a - b);
  const chapterSize = sizes.find(s => pageMax.filter(m => m >= s).length <= maxChapters);

  if (!chapterSize) {
    const starts = startsLow.filter(Boolean).length;
    return starts >= 2 && starts <= maxChapters ? buildChaptersAtPages(pages, startsLow) : buildChaptersByPage(pages);
  }

  const chapters = [];
  let current = null;
  pages.forEach((page, i) => {
    if (pageMax[i] >= chapterSize) {
      // the chapter title is the run of big headings (and chapter numbers) at the top of the page
      const titleParts = [];
      const blocks = [...page];
      while (
        blocks.length && blocks[0].heading &&
        (blocks[0].size >= chapterSize - 1 || isNumberLike(blocks[0].text))
      ) {
        titleParts.push(blocks.shift().text);
      }
      if (!titleParts.some(t => letterCount(t) >= 3)) {
        const big = blocks.findIndex(b => b.heading && b.size >= chapterSize);
        titleParts.push(blocks.splice(big, 1)[0].text);
      }
      let title = titleParts.join(' ');
      if (title.length > 100) title = title.slice(0, 97) + '…';
      current = { title, blocks, page: i };
      chapters.push(current);
    } else {
      if (!current) {
        current = { title: 'Opening', blocks: [], page: i };
        chapters.push(current);
      }
      current.blocks.push(...page);
    }
  });
  // scanned books often misread a chapter number "1" as "i" or "l"
  if (chapters.filter(ch => /^\d+ /.test(ch.title)).length >= 2) {
    for (const ch of chapters) ch.title = ch.title.replace(/^[ilI|] (?=\p{Lu})/u, '1 ');
  }
  return chapters.filter(ch => ch.blocks.length || ch.title !== 'Opening');
}

// Chapters starting on the flagged pages, numbered since they have no title text.
function buildChaptersAtPages(pages, starts) {
  const chapters = [];
  let current = null;
  pages.forEach((page, i) => {
    if (starts[i]) {
      current = { title: `Chapter ${chapters.filter(ch => ch.title !== 'Opening').length + 1}`, blocks: [], page: i };
      chapters.push(current);
    } else if (!current) {
      current = { title: 'Opening', blocks: [], page: i };
      chapters.push(current);
    }
    current.blocks.push(...page);
  });
  return chapters.filter(ch => ch.blocks.length || ch.title !== 'Opening');
}

// The page number printed on each page (an index of pages, null where there's none):
// a line of only a number, the first or the last one on its page.
function printedPageNumbers(pageLines) {
  return pageLines.map(lines => {
    const byHeight = lines.filter(l => !l.image).sort((a, b) => b.y - a.y);
    for (const l of [byHeight[byHeight.length - 1], byHeight[0]]) {
      const m = l && /^[^\p{L}\d]{0,2}(\d{1,4})[^\p{L}\d]{0,2}$/u.exec(l.text.trim());
      if (m) return Number(m[1]);
    }
    return null;
  });
}

// The entries of a table of contents (its lines, top to bottom): [{ title, printed }],
// `printed` the page number printed after the title ("Bandung di Ujung Malam - 181",
// "Epilog ........ 285"). A title wrapped onto two lines is joined; the page's own
// heading ("Daftar Isi", "Contents") and its page number are left out.
function contentsEntries(lines) {
  const entries = [];
  let pending = '';
  for (const l of [...lines].sort((a, b) => b.y - a.y)) {
    const text = l.text.trim();
    if (!text || l.image) continue;
    const m = /^(.*?\p{L}.*?)[\s.·…_–—-]*?(\d{1,4})$/u.exec(text);
    if (m) {
      const title = (pending + ' ' + m[1]).replace(/[\s.·…_–—-]+$/u, '').replace(/\s+/g, ' ').trim();
      if (letterCount(title) >= 2) entries.push({ title, printed: Number(m[2]) });
      pending = '';
    } else if (!isNumberLike(text) && !/^(daftar isi|isi|contents?|table of contents)$/iu.test(text)) {
      pending = (pending + ' ' + text).trim(); // the first line of a wrapped title
    }
  }
  return entries;
}

// The page (an index) that printed page number `n` is on, from the pages that show
// their numbers: counted from the nearest one at or before it, so pages without a
// number (pictures, chapter openings) and pages left out of the numbering both
// work out. Numbers misread now and then are ignored: only gaps between printed
// and real page numbers that 3 or more pages agree on are used.
function pageOfPrinted(printed, n) {
  const gaps = new Map();
  printed.forEach((p, i) => { if (p !== null) gaps.set(i - p, (gaps.get(i - p) || 0) + 1); });
  const known = printed.map((p, i) => [i, p]).filter(([i, p]) => p !== null && gaps.get(i - p) >= 3);
  if (!known.length) return null;
  const before = known.filter(([, p]) => p <= n).pop() || known[0];
  return before[0] + (n - before[1]);
}

const titleWords = text => (text.toLowerCase().match(/[\p{L}\d]+/gu) || []);

// How much of a title is in a page's headings (0 to 1).
function titleOnPage(title, page) {
  const words = titleWords(title);
  const found = new Set(titleWords(page.filter(b => b.heading).map(b => b.text).join(' ')));
  return words.length ? words.filter(w => found.has(w)).length / words.length : 0;
}

// Where each entry of the table of contents starts: its page (an index) from its
// printed page number, moved to a page close by whose headings are the title; with
// no page numbers to go by, the first page after the entry before whose headings
// are the title. Entries not found have `page` null.
function placeContents(entries, pages, printed) {
  let from = 0;
  return entries.map(entry => {
    const guess = pageOfPrinted(printed, entry.printed);
    const near = guess === null
      ? pages.map((_, i) => i).filter(i => i >= from)
      : [0, -1, 1, -2, 2, -3, 3].map(d => guess + d).filter(i => i >= 0 && i < pages.length);
    let page = near.find(i => titleOnPage(entry.title, pages[i]) >= 0.6);
    const matched = page !== undefined; // its title is in the page's headings
    if (!matched) page = guess !== null && guess >= 0 && guess < pages.length ? guess : null;
    if (page !== null) from = page + 1;
    return { ...entry, page, matched };
  });
}

// Chapters from the book's own table of contents: one for each entry found, from
// its page to the next one's, titled as in the table of contents. The headings at
// the top of its first page are its printed title, so they're left out. Pages before
// the first chapter are the Opening.
function chaptersFromContents(pages, placed) {
  const starts = placed.filter(e => e.page !== null).sort((a, b) => a.page - b.page);
  const chapters = [];
  const opening = pages.slice(0, starts[0].page).flat();
  if (opening.length) chapters.push({ title: 'Opening', blocks: opening, page: 0 });
  starts.forEach((start, i) => {
    if (starts[i + 1]?.page === start.page) return; // an entry on the same page as the next one ("Part One", then its first chapter)
    const end = i + 1 < starts.length ? starts[i + 1].page : pages.length;
    const first = [...pages[start.page]];
    while (first.length && first[0].heading) first.shift();
    const before = starts.filter(e => e !== start && e.page === start.page && starts.indexOf(e) < i);
    let title = [...before.map(e => e.title), start.title].join(' · ');
    if (title.length > 100) title = title.slice(0, 97) + '…';
    chapters.push({ title, blocks: [...first, ...pages.slice(start.page + 1, end).flat()], page: start.page });
  });
  return chapters;
}

// The chapters chosen by the user: [{ page (1-based), title }], each starting on its
// page, in page order; pages before the first are the Opening. A chapter with no
// title takes the headings at the top of its page (or the start of its text). The
// headings at the top of its page that are in its title are its printed title, so
// they're left out. Null when none of the pages are in the book.
function chaptersAtStarts(pages, starts) {
  const list = starts.map(c => ({ ...c, page: c.page - 1 })).filter(c => c.page < pages.length).sort((a, b) => a.page - b.page);
  if (!list.length) return null;
  const chapters = [];
  const opening = pages.slice(0, list[0].page).flat();
  if (opening.length) chapters.push({ title: 'Opening', blocks: opening, page: 0 });
  list.forEach((start, i) => {
    const end = i + 1 < list.length ? list[i + 1].page : pages.length;
    const first = [...pages[start.page]];
    let title = start.title || pageTitle(first) || `Page ${start.page + 1}`;
    if (title.length > 100) title = title.slice(0, 97) + '…';
    const inTitle = new Set(titleWords(title));
    while (first.length && first[0].heading && titleWords(first[0].text).every(w => inTitle.has(w))) first.shift();
    chapters.push({ title, blocks: [...first, ...pages.slice(start.page + 1, end).flat()], page: start.page });
  });
  return chapters;
}

// A page's title: the headings at its top, or the start of its first paragraph.
function pageTitle(page) {
  const heads = [];
  for (const b of page) {
    if (!b.heading || heads.length === 3) break;
    if (letterCount(b.text)) heads.push(b.text.trim());
  }
  if (heads.length) return heads.join(' ');
  const text = page.find(b => !b.image && b.text && letterCount(b.text) >= 3)?.text.trim() || '';
  return text.length > 60 ? text.slice(0, 60).replace(/\s+\S*$/, '') + '…' : text;
}

const MAX_CHAPTER_STARTS = 1000;

// The chapters chosen by the user as asked for ([{ page, title }]), checked: one per
// page, the first one kept, titles trimmed (empty: found on the page).
function chapterStartsFrom(value) {
  const ok = Array.isArray(value) && value.length <= MAX_CHAPTER_STARTS &&
    value.every(c => c && Number.isInteger(c.page) && c.page >= 1 && c.page <= 100000 && (c.title === undefined || typeof c.title === 'string'));
  if (!ok) throw new Error(`The chapters could not be read (up to ${MAX_CHAPTER_STARTS}, each with a page number).`);
  const seen = new Set();
  return value.filter(c => !seen.has(c.page) && seen.add(c.page)).map(c => ({ page: c.page, title: (c.title || '').replace(/\s+/g, ' ').trim().slice(0, 200) }));
}

const MAX_CONTENTS_PAGES = 5;
const CONTENTS_FRONT = 20; // a table of contents is looked for in the first pages of the book
const CONTENTS_BACK = 10; // ...and in the last ones
const MIN_CONTENTS_ENTRIES = 5; // a page with fewer entries isn't a table of contents
const MIN_CONTENTS_MATCHED = 2; // ...nor one whose titles aren't found as headings in the book

// The book's table of contents, looked for in `candidates` ([page, lines] each): the
// page with the most entries, at least MIN_CONTENTS_ENTRIES, with their page numbers
// going up, and the pages right after it that carry on its list.
// Returns { pages, entries }, or null.
function findContents(candidates) {
  const lists = candidates.map(([n, lines]) => ({ n, entries: contentsEntries(lines) }));
  const goesUp = entries => entries.filter((e, i) => !i || e.printed >= entries[i - 1].printed).length >= entries.length * 0.8;
  const best = lists
    .filter(l => l.entries.length >= MIN_CONTENTS_ENTRIES && goesUp(l.entries))
    .sort((a, b) => b.entries.length - a.entries.length)[0];
  if (!best) return null;
  const pages = [best.n];
  const entries = [...best.entries];
  for (let next = lists.find(l => l.n === best.n + 1); next; next = lists.find(l => l.n === next.n + 1)) {
    if (next.entries.length < 3 || !goesUp(next.entries) || next.entries[0].printed < entries[entries.length - 1].printed) break;
    pages.push(next.n);
    entries.push(...next.entries);
  }
  return { pages, entries };
}

// The pages of a book's table of contents as asked for (page numbers), checked.
function contentsPagesFrom(value) {
  if (!Array.isArray(value) || value.length > MAX_CONTENTS_PAGES || !value.every(n => Number.isInteger(n) && n >= 1 && n <= 100000)) {
    throw new Error(`The contents pages could not be read (up to ${MAX_CONTENTS_PAGES} page numbers).`);
  }
  return [...new Set(value)].sort((a, b) => a - b);
}

// Fallback when the PDF has no recognisable headings: chapters of 10 pages.
function buildChaptersByPage(pages, pagesPerChapter = 10) {
  const chapters = [];
  for (let i = 0; i < pages.length; i += pagesPerChapter) {
    const first = i + 1;
    const last = Math.min(i + pagesPerChapter, pages.length);
    chapters.push({
      title: first === last ? `Page ${first}` : `Pages ${first}–${last}`,
      blocks: pages.slice(i, i + pagesPerChapter).flat(),
      page: i,
    });
  }
  return chapters;
}

function xhtmlFile(title, body, bodyClass) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
  <head>
    <title>${escapeXml(title)}</title>
    <link rel="stylesheet" type="text/css" href="style.css"/>
  </head>
  <body${bodyClass ? ` class="${bodyClass}"` : ''}>
${body}
  </body>
</html>`;
}

// A chapter's files: its text, with its pictures in the text, the text above and
// below each one (`inline`), or every picture on a page of its own that it fills,
// like a page of an XTC book. The title goes above the first text. Pictures turned
// on their side (`sideways`, image names) are always pages of their own, marked
// "sideways", which a preview can use to show them turned.
// Where a PDF page starts, an empty marker (pdfp12 for page 12) goes before its first block.
// Each picture is tagged with its PDF page and its number there (`info`: name → { page,
// pic, size }), so the web app can turn and size it, and shown at the width chosen (size,
// a share of the screen's width).
function chapterFiles(ch, number, sideways = new Set(), inline = false, info = new Map()) {
  const img = (name, alt = '') => {
    const p = info.get(name);
    const tags = p ? ` data-pdfpage="${p.page}" data-pic="${p.pic}"` : '';
    const width = p && p.size ? ` style="width: ${p.size}%"` : '';
    return `<img src="images/${name}" alt="${alt}"${tags}${width}/>`;
  };
  const parts = [];
  let pageBefore = null;
  const marker = b => {
    if (!b.pdfPage || b.pdfPage === pageBefore) return '';
    pageBefore = b.pdfPage;
    return `    <div id="pdfp${b.pdfPage}" class="pdfp"></div>\n`;
  };
  ch.blocks.forEach((b, i) => {
    const last = parts[parts.length - 1];
    if (b.image && !(inline && !sideways.has(b.image))) parts.push({ image: b.image, pdfPage: b.pdfPage });
    else if (last && !last.image) last.blocks.push({ ...b, id: `s${i}` });
    else parts.push({ blocks: [{ ...b, id: `s${i}` }] });
  });
  let titled = parts.find(p => !p.image);
  if (!titled) parts.unshift((titled = { blocks: [] }));
  return parts.map((part, k) => {
    const name = k ? `chapter${number}-${k + 1}.xhtml` : `chapter${number}.xhtml`;
    if (part.image) {
      const body = `${marker(part)}    ${img(part.image)}`;
      return { name, sections: [], xhtml: xhtmlFile(ch.title, body, sideways.has(part.image) ? 'picture sideways' : 'picture') };
    }
    const lines = part.blocks.map(b => marker(b) + (
      b.image ? `    <div class="pic">${img(b.image)}</div>`
      : b.heading ? `    <h3 id="${b.id}">${escapeXml(b.text)}</h3>` : `    <p>${escapeXml(b.text)}</p>`
    ));
    if (part === titled) lines.unshift(`    <h2>${escapeXml(ch.title)}</h2>`);
    const sections = part.blocks.filter(b => b.heading).map(b => ({ href: `${name}#${b.id}`, text: b.text }));
    return { name, sections, xhtml: xhtmlFile(ch.title, lines.join('\n')) };
  });
}

// The book with each full-page picture replaced by its sideways parts, as pictures
// of their own in its place (img3.png → img3-1.png, img3-2.png, ...).
function splitPictures(chapters, images, parts) {
  const partsOf = new Map(images.filter(img => img.split?.[parts]).map(img => [img.name, img.split[parts]]));
  if (!partsOf.size) return { chapters, images };
  const partName = (name, k) => name.replace(/\.png$/, `-${k + 1}.png`);
  return {
    images: images.flatMap(img =>
      partsOf.has(img.name) ? partsOf.get(img.name).map((data, k) => ({ name: partName(img.name, k), data, sideways: true })) : [img]
    ),
    chapters: chapters.map(ch => ({
      ...ch,
      blocks: ch.blocks.flatMap(b =>
        b.image && partsOf.has(b.image) ? partsOf.get(b.image).map((_, k) => ({ ...b, image: partName(b.image, k) })) : [b]
      ),
    })),
  };
}

// Package an analysed book as an EPUB. This is fast, so the same book can be
// re-packaged with a different cover without reading the PDF again.
// `cover` (a PNG from imageCover) replaces the cover found in the PDF.
// The text uses the e-reader's own font. `language` is the book's (a code: en, id, ...).
// `pictureParts` 2 or 3 turns full-page portrait pictures sideways and cuts them into parts.
// `pictures` 'inline' puts the pictures in the text, with the text above and below
// each one; 'page' puts each on a page of its own that it fills.
async function buildEpub({ title, author, language = 'en', chapters, images = [], cover: pdfCover = null }, { cover: customCover, pictureParts = 1, pictures = 'inline' } = {}) {
  const cover = customCover || pdfCover;
  if (![1, 2, 3].includes(pictureParts)) throw new Error('Full-page pictures can be cut into 1, 2 or 3 parts.');
  if (!['inline', 'page'].includes(pictures)) throw new Error('Pictures go in the text (inline) or on pages of their own (page).');
  if (pictureParts > 1) ({ chapters, images } = splitPictures(chapters, images, pictureParts));
  const zip = new JSZip();
  const id = 'urn:uuid:' + crypto.randomUUID();
  const modified = new Date().toISOString().replace(/\.\d+Z$/, 'Z');

  // mimetype must be the first entry and stored uncompressed
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file('META-INF/container.xml', `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`);

  const manifest = [];
  const spine = [];
  const navItems = [];

  zip.file('OEBPS/style.css', `body { font-family: serif; line-height: 1.5; margin: 0 5%; }
h2 { text-align: center; margin: 1.5em 0; }
h3 { margin: 1.5em 0 0.75em; }
h3 + p { text-indent: 0; }
p { text-indent: 1.5em; margin: 0 0 0.5em 0; text-align: justify; }
.pic { margin: 0.8em 0; text-align: center; text-indent: 0; page-break-inside: avoid; break-inside: avoid; }
.pic img { width: auto; height: auto; max-width: 100%; max-height: 95vh; }
.pic + p { text-indent: 0; }
body.picture, body.cover { margin: 0; padding: 0; text-align: center; }
body.picture img, body.cover img { width: auto; height: auto; max-width: 100%; max-height: 100vh; }`);

  for (const img of images) {
    zip.file(`OEBPS/images/${img.name}`, img.data, { compression: 'STORE' });
    manifest.push(`    <item id="${img.name.replace('.', '-')}" href="images/${img.name}" media-type="image/png"/>`);
  }
  if (cover) {
    zip.file('OEBPS/images/cover.png', cover, { compression: 'STORE' });
    zip.file('OEBPS/cover.xhtml', xhtmlFile('Cover', '    <img src="images/cover.png" alt="Cover"/>', 'cover'));
    manifest.push('    <item id="cover-image" href="images/cover.png" media-type="image/png" properties="cover-image"/>');
    manifest.push('    <item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>');
    spine.push('    <itemref idref="cover"/>');
  }
  const sideways = new Set(images.filter(img => img.sideways).map(img => img.name));
  const info = new Map(images.filter(img => img.page).map(img => [img.name, img]));
  chapters.forEach((ch, i) => {
    const files = chapterFiles(ch, i + 1, sideways, pictures === 'inline', info);
    files.forEach((file, k) => {
      const id = k ? `ch${i + 1}-${k + 1}` : `ch${i + 1}`;
      zip.file(`OEBPS/${file.name}`, file.xhtml);
      manifest.push(`    <item id="${id}" href="${file.name}" media-type="application/xhtml+xml"/>`);
      spine.push(`    <itemref idref="${id}"/>`);
    });
    const sections = files
      .flatMap(f => f.sections)
      .map(s => `          <li><a href="${s.href}">${escapeXml(s.text)}</a></li>`);
    const sub = sections.length ? `\n          <ol>\n${sections.join('\n')}\n          </ol>\n        ` : '';
    navItems.push(`        <li><a href="${files[0].name}">${escapeXml(ch.title)}</a>${sub}</li>`);
  });

  zip.file('OEBPS/nav.xhtml', `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
  <head><title>Contents</title></head>
  <body>
    <nav epub:type="toc" id="toc">
      <h1>Contents</h1>
      <ol>
${navItems.join('\n')}
      </ol>
    </nav>
  </body>
</html>`);

  zip.file('OEBPS/content.opf', `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">${id}</dc:identifier>
    <dc:title>${escapeXml(title)}</dc:title>
    <dc:creator>${escapeXml(author)}</dc:creator>
    <dc:language>${escapeXml(language)}</dc:language>
    <meta property="dcterms:modified">${modified}</meta>${cover ? '\n    <meta name="cover" content="cover-image"/>' : ''}
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="css" href="style.css" media-type="text/css"/>
${manifest.join('\n')}
  </manifest>
  <spine>
${spine.join('\n')}
  </spine>
</package>`);

  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

// The readers an EPUB can be made for: the Xteink ones in DEVICES (xtc.js), whose
// screens its pictures and cover are drawn to fill (480 x 800 for the X4 and X4 Pro,
// 528 x 792 for the X3), and any other (a Kindle, a Kobo or a phone), whose pictures
// are kept full size (`pictures`, see screenImage) for it to fit to its own screen.
// Its `width` and `height` are a typical screen's shape, for the preview and for
// cutting full-page pictures in sideways parts.
const READERS = {
  ...DEVICES,
  any: { name: 'Kindle, Kobo or phone', width: 600, height: 800, pictures: { width: 1240, height: 1680 } },
};

// The screen of a reader in READERS.
function readerScreen(device = 'x4') {
  const screen = READERS[device];
  if (!screen) throw new Error(`Unknown device "${device}". Available: ${Object.keys(READERS).join(', ')}.`);
  return screen;
}

// Read a PDF into a book: chapters, images and cover, ready for buildEpub.
// `name` is used as the title when the PDF has none.
// OCR options are passed on to extractPdf; the book's `ocr` can be passed back in
// as `ocr` to rebuild it without reading its scanned pages again.
async function analyzePdf(pdfBuffer, { title, author, name = 'Untitled', device = 'x4', onProgress, ...ocrOptions } = {}) {
  const extracted = await extractPdf(pdfBuffer, onProgress, { ...ocrOptions, screen: readerScreen(device) });
  const pages = cleanPages(extracted.pages);
  // each block knows the PDF page it comes from, so the EPUB can mark where every page
  // starts (see chapterFiles) and the web app can turn its preview to a page
  pages.forEach((blocks, i) => { for (const b of blocks) b.pdfPage = i + 1; });
  // chapters from the book's own table of contents, whose pages then leave the book
  // (the EPUB has its own): the pages asked for, or the ones found, used only if
  // enough of their titles are headings in the book; else the chapters found as usual
  const asked = ocrOptions.contentsPages;
  const toc = asked === undefined
    ? findContents(extracted.contentsLines)
    : asked.length ? { pages: asked, entries: contentsEntries(extracted.contentsLines.flatMap(([, lines]) => lines)) } : null;
  const placed = toc ? placeContents(toc.entries, pages, extracted.printed) : [];
  const fromContents = asked === undefined
    ? placed.filter(e => e.page !== null).length >= 3 && placed.filter(e => e.matched).length >= MIN_CONTENTS_MATCHED
    : placed.some(e => e.page !== null);
  if (fromContents) for (const n of toc.pages) if (pages[n - 1]) pages[n - 1] = [];
  const paragraphs = pages.reduce((n, p) => n + p.filter(b => !b.heading && !b.image).length, 0);
  if (paragraphs === 0) {
    throw new Error('No text found, even with OCR. The PDF may contain only pictures.');
  }
  // the chapters chosen by the user come first; the Daftar Isi still leaves the book
  const own = ocrOptions.chapterStarts?.length ? chaptersAtStarts(pages, ocrOptions.chapterStarts) : null;
  return {
    title: title || extracted.title || name,
    author: author || extracted.author || 'Unknown',
    chapters: own || (fromContents ? chaptersFromContents(pages, placed) : buildChapters(pages, extracted.startsLow)),
    ownChapters: !!own,
    // the table of contents: its pages, whether it was found by itself (auto), and each
    // entry with the page (1-based) it starts on, or null; there's none when none was
    // found, or none is wanted
    ...(toc && (asked !== undefined || fromContents) && {
      contents: {
        pages: toc.pages,
        auto: asked === undefined,
        entries: placed.map(({ matched, ...e }) => ({ ...e, page: e.page === null ? null : e.page + 1 })),
      },
    }),
    images: extracted.images,
    cover: extracted.cover,
    ocr: extracted.ocr,
    pictureBoxes: extracted.pictureBoxes,
    device, // the e-reader its pictures are drawn for
    stats: { pages: pages.length, paragraphs, images: extracted.images.length, fullPagePictures: extracted.images.filter(i => i.split).length },
  };
}

// Convert PDF bytes to EPUB bytes in one go. `cover` is a picture file's bytes.
async function convertPdfToEpub(pdfBuffer, { cover, pictureParts, pictures, ...options } = {}) {
  // read the cover first, so an unreadable picture fails before the slow part
  const coverImage = cover && (await imageCover(cover, readerScreen(options.device)));
  const book = await analyzePdf(pdfBuffer, options);
  const epub = await buildEpub(book, { cover: coverImage, pictureParts, pictures });
  return { epub, ...book.stats, chapters: book.chapters.length };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.positional.some(p => /^https?:\/\//i.test(p))) return writeWebPages(opts);
  const [input, output] = opts.positional;
  if (!input) {
    console.error(
      'Usage: node index.js input.pdf [output.epub] [--title "Title"] [--author "Author"] [--cover image] [--device x4|x4-pro|x3|any] [--picture-parts 2|3] [--pictures inline|page] [--ocr-lang code]'
    );
    console.error('Web pages (news articles), a book for each link: node index.js https://... [more links] [output.epub, or a folder for several] [--title ...] [--author ...] [--cover image] [--device ...]');
    console.error(
      'OCR languages (for scanned pages; detected when not given): ' +
        Object.entries(LANGUAGES).map(([code, name]) => `${code} (${name})`).join(', ')
    );
    console.error(
      '\nXteink (XTC) output: node index.js input.pdf [output.xtc] --format xtc|xtch [--device x4|x4-pro|x3]\n' +
        '  [--orientation landscape|portrait] [--split overlap|half|none] [--dither ' + DITHERING.join('|') + ']\n' +
        '  [--contrast 0-8] [--crop percent[,percent]] [--no-cover-page] [--flip] [--title ...] [--author ...] [--cover image]'
    );
    process.exit(1);
  }
  if (opts.format && !['epub', 'xtc', 'xtch'].includes(opts.format)) {
    throw new Error(`Unknown format "${opts.format}". Available: epub, xtc, xtch.`);
  }
  if (opts.format === 'xtc' || opts.format === 'xtch') return writeXtc(input, output, opts);
  const outFile = output || input.replace(/\.pdf$/i, '') + '.epub';

  const { epub, pages, paragraphs, chapters, images } = await convertPdfToEpub(fs.readFileSync(input), {
    title: opts.title,
    author: opts.author,
    cover: opts.cover && fs.readFileSync(opts.cover),
    device: opts.device,
    pictureParts: opts.pictureParts,
    pictures: opts.pictures,
    ocrLanguage: opts.ocrLanguage,
    name: path.basename(input, path.extname(input)),
    onProgress: ({ stage, done, total }) => {
      if (stage === 'ocr' && process.stderr.isTTY) process.stderr.write(`\rOCR: page ${done} of ${total}`);
      if (stage === 'ocr' && done === total && process.stderr.isTTY) process.stderr.write('\n');
    },
  });
  fs.writeFileSync(outFile, epub);
  console.log(`Wrote ${outFile} (${pages} pages, ${chapters} chapters, ${paragraphs} paragraphs, ${images} images)`);
}

// The PDF's pages as an XTC (black and white) or XTCH (4 grays) book for an Xteink reader.
async function writeXtc(input, output, opts) {
  const { title, author, format, cover: coverFile, ...settings } = opts;
  // read the cover first, so a missing file fails before the slow part
  const coverData = coverFile && fs.readFileSync(coverFile);
  const book = await convertPdfPages(fs.readFileSync(input), {
    ...settings,
    grays: format === 'xtch',
    title,
    author,
    name: path.basename(input, path.extname(input)),
    onProgress: ({ done, total }) => {
      if (process.stderr.isTTY) process.stderr.write(`\rPage ${done} of ${total}${done === total ? '\n' : ''}`);
    },
  });
  const cover = coverData && (await coverPage(coverData, book));
  const outFile = output || input.replace(/\.pdf$/i, '') + extensionFor(book);
  fs.writeFileSync(outFile, buildXtc(book, cover));
  console.log(
    `Wrote ${outFile} for the ${DEVICES[book.options.device].name} ` +
      `(${bookPages(book, cover).pages.length} screens from ${book.stats.sourcePages} PDF pages, ${book.chapters.length} chapters)`
  );
}

// Web pages (positional links) as EPUBs, a book for each link, made one after
// another. A positional argument that isn't a link is the output: the file for one
// link, or the folder for several (each book named after its article).
async function writeWebPages(opts) {
  const { parseLinks, readWebPages } = require('./web');
  const links = parseLinks(opts.positional.filter(p => /^https?:\/\//i.test(p)).join(' '));
  const output = opts.positional.find(p => !/^https?:\/\//i.test(p));
  const coverImage = opts.cover && (await imageCover(fs.readFileSync(opts.cover), readerScreen(opts.device)));
  if (links.length > 1 && output) fs.mkdirSync(output, { recursive: true });
  let made = 0;
  for (const [i, link] of links.entries()) {
    const which = links.length > 1 ? `Book ${i + 1} of ${links.length}: ` : '';
    try {
      const book = await readWebPages([link], {
        title: opts.title,
        author: opts.author,
        device: opts.device,
        onProgress: ({ stage, done, total }) => {
          if (!process.stderr.isTTY || stage === 'finishing') return;
          process.stderr.write(`\r${which}${stage === 'pages' ? 'web page' : 'pictures'} ${done} of ${total}${done === total ? '\n' : ''}`);
        },
      });
      const outFile = links.length === 1 ? output || book.fileName : path.join(output || '.', book.fileName);
      fs.writeFileSync(outFile, await buildEpub(book, { cover: coverImage, pictures: opts.pictures }));
      made++;
      console.log(`Wrote ${outFile} (${book.stats.paragraphs} paragraphs, ${book.stats.images} pictures)`);
    } catch (err) {
      if (links.length === 1) throw err;
      console.error(`Skipped book ${i + 1} of ${links.length}: ${err.message}`);
    }
  }
  if (links.length > 1) console.log(`${made} of ${links.length} books made.`);
  if (!made) process.exitCode = 1;
}

module.exports = { convertPdfToEpub, analyzePdf, newBookCache, looksFrom, buildEpub, extractPdf, openPdf, cleanPages, buildChapters, readerScreen, contentsPagesFrom, chapterStartsFrom };

if (require.main === module) {
  main().catch(err => {
    console.error(err.message || err);
    process.exit(1);
  });
}
