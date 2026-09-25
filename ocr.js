// Read scanned pages with OCR. Pages without a text layer are rendered and read
// with Tesseract (tesseract.js, bundled, so nothing needs installing), and the
// result is returned as lines in the same shape as pageToLines in index.js.
//
// Reading happens in two steps, so a book can be rebuilt after a page is read
// again without reading every page again:
//   recognizePages / retryPage  → each page's raw reading
//   finishPages                 → the lines to use, judged across the whole book

const os = require('os');
const path = require('path');
const { createCanvas } = require('@napi-rs/canvas');
const { renderPage } = require('./figures');

const DPI = 300;
const MIN_CONFIDENCE = 50; // lines Tesseract is less sure of are ornaments, stains or decorative lettering
// Paragraphs whose median word confidence is this many points below the book's
// typical paragraph (and below MAX_PARAGRAPH_CUTOFF) are dropped. The median, not
// the mean, because a paragraph of clean print can include a few junk words from
// an ornament or a large first letter. Printed text reads at 90-96, handwriting
// fonts mostly at 35-80.
const PARAGRAPH_MARGIN = 8;
const MAX_PARAGRAPH_CUTOFF = 88;
const SHORT_PARAGRAPH_MARGIN = 3; // for a paragraph of 1-2 lines next to one that was dropped
const MIN_JUDGED_WORDS = 8; // shorter paragraphs are only dropped next to a dropped one
const SAMPLE_PAGES = 3; // pages read in every language to pick the book's language
const THUMB_WIDTH = 700; // pixels, for showing pages while they're read

// Other settings tried when a page is read again: a sharper image, black and
// white only (removes a grey or stained background), and reading the page as one
// block of text (helps when the layout is misjudged). The best reading is kept.
const RETRY_SETTINGS = [
  { name: 'higher resolution', dpi: 400 },
  { name: 'black and white', dpi: DPI, blackAndWhite: true },
  { name: 'single text block', dpi: DPI, pageSegMode: '6' },
];

// Languages whose data is bundled. Add one by installing @tesseract.js-data/<code>
// and listing it here; build/build-exe.js bundles the data of every language listed.
const LANGUAGES = { eng: 'English', ind: 'Indonesian' };

function langPath(code) {
  return path.join(path.dirname(require.resolve(`@tesseract.js-data/${code}/package.json`)), '4.0.0_best_int');
}

async function createWorker(code) {
  const { createWorker } = require('tesseract.js');
  return createWorker(code, 1, {
    langPath: langPath(code),
    cacheMethod: 'none', // read the bundled data, never write a copy into the working folder
    // without a handler, tesseract.js rethrows worker errors where nothing can catch
    // them, stopping the whole app; the failed job still rejects its own promise
    errorHandler: () => {},
  });
}

const median = arr => {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

// Make every pixel black or white, split at the level that best separates ink
// from paper (Otsu's method).
function toBlackAndWhite(canvas) {
  const ctx = canvas.getContext('2d');
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const px = img.data;
  const gray = new Uint8Array(px.length / 4);
  const hist = new Array(256).fill(0);
  for (let i = 0, p = 0; p < gray.length; i += 4, p++) {
    gray[p] = (0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]) | 0;
    hist[gray[p]]++;
  }
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumBack = 0, weightBack = 0, best = 0, threshold = 128;
  for (let t = 0; t < 256; t++) {
    weightBack += hist[t];
    if (!weightBack) continue;
    const weightFore = gray.length - weightBack;
    if (!weightFore) break;
    sumBack += t * hist[t];
    const between = weightBack * weightFore * (sumBack / weightBack - (sum - sumBack) / weightFore) ** 2;
    if (between > best) [best, threshold] = [between, t];
  }
  for (let i = 0, p = 0; p < gray.length; i += 4, p++) {
    const v = gray[p] > threshold ? 255 : 0;
    px[i] = px[i + 1] = px[i + 2] = v;
  }
  ctx.putImageData(img, 0, 0);
}

async function pageImage(doc, n, { dpi = DPI, blackAndWhite = false, thumb = false } = {}) {
  const page = await doc.getPage(n);
  const canvas = await renderPage(page, dpi / 72);
  const height = page.view[3] - page.view[1];
  const width = page.view[2] - page.view[0];
  page.cleanup();
  let thumbnail = null;
  if (thumb) {
    const t = createCanvas(THUMB_WIDTH, Math.round((canvas.height * THUMB_WIDTH) / canvas.width));
    t.getContext('2d').drawImage(canvas, 0, 0, t.width, t.height);
    thumbnail = await t.encode('jpeg', 75);
  }
  if (blackAndWhite) toBlackAndWhite(canvas);
  // JPEG encodes several times faster than PNG and reads just as well
  return { image: await canvas.encode('jpeg', 90), width, height, scale: dpi / 72, thumbnail };
}

// How well a page was read: the median word confidence (0-100), or null for a
// page with hardly any text. The median, so an ornament read as junk doesn't
// make a page of clean print look bad.
function pageConfidence(data) {
  const words = (data.blocks || []).flatMap(b => b.paragraphs.flatMap(p => p.lines.flatMap(l => l.words)));
  return words.length >= 5 ? Math.round(median(words.map(w => w.confidence))) : null;
}

// Tesseract's blocks → lines with PDF coordinates (y is the baseline, measured from the bottom).
// `scale` is pixels per PDF point in the image that was read.
function toLines(data, pageHeight, scale) {
  const lines = [];
  for (const block of data.blocks || []) {
    for (const para of block.paragraphs) {
      const paraWords = para.lines.flatMap(l => l.words);
      const paraInfo = {
        confidence: median(paraWords.map(w => w.confidence)) ?? 0,
        lines: para.lines.length,
        words: paraWords.length,
      };
      for (const line of para.lines) {
        const words = line.words.filter(w => w.text.trim());
        if (!words.length || line.confidence < MIN_CONFIDENCE) continue;
        if (!words.some(w => /[\p{L}\d]/u.test(w.text))) continue; // specks read as punctuation
        // the typical word height, so a large decorative first letter doesn't make the line a heading
        const size = Math.round(median(words.map(w => w.bbox.y1 - w.bbox.y0)) / scale);
        const baseline = (line.baseline.y0 + line.baseline.y1) / 2;
        const text = words.map(w => w.text).join(' ');
        lines.push({
          text,
          x: line.bbox.x0 / scale,
          xEnd: line.bbox.x1 / scale,
          y: pageHeight - baseline / scale,
          top: pageHeight - line.bbox.y0 / scale, // includes a large first letter, unlike size
          size,
          // headings are short, stand alone, and are printed clearly; anything else in
          // large type (a letter in a handwriting font, say) is body text
          mayBeHeading: para.lines.length <= 2 && text.length <= 60 && line.confidence >= 80,
          para: paraInfo, // shared by the paragraph's lines
        });
      }
    }
  }
  return lines.sort((a, b) => b.y - a.y || a.x - b.x);
}

// A page's raw reading: its lines, how well it was read, its text for showing,
// and the page size (PDF points).
function reading(data, { width, height, scale }) {
  const lines = toLines(data, height, scale);
  return { lines, confidence: pageConfidence(data), text: lines.map(l => l.text).join('\n'), page: { width, height } };
}

// Split a paragraph into lines of about `chars` characters, at spaces.
function wrap(paragraph, chars) {
  const lines = [];
  let line = '';
  for (const word of paragraph.split(/\s+/)) {
    if (line && line.length + 1 + word.length > chars) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

// A page's reading from text typed by hand, replacing `previous` (the OCR reading).
// The text is laid out like a printed page over the area the OCR'd lines covered,
// so it takes their place: picture detection treats that area as text, and a
// chapter title above it stays a picture. A blank line starts a new paragraph.
// Paragraphs are wrapped into lines as long as the page's, with the first line
// indented and the last one short, so the converter finds the paragraphs just
// as it does on a printed page (people type a paragraph as one long line).
function manualReading(text, previous) {
  const paragraphs = text
    .replace(/\r/g, '')
    .split(/\n\s*\n/)
    .map(p => p.split('\n').map(line => line.trim()).filter(Boolean).join(' '))
    .filter(Boolean);
  const { width, height } = previous.page;
  const old = previous.ocrLines || previous.lines; // editing again: still the area OCR found text in
  const size = median(old.map(l => l.size)) ?? 10;
  const left = old.length ? Math.min(...old.map(l => l.x)) : width * 0.12;
  const right = old.length ? Math.max(...old.map(l => l.xEnd)) : width * 0.88;
  const top = old.length ? Math.max(...old.map(l => l.top)) : height * 0.9;
  const bottom = old.length ? Math.min(...old.map(l => l.y - l.size * 0.3)) : height * 0.1;
  const chars = Math.max(30, median(old.filter(l => l.xEnd - l.x > (right - left) * 0.8).map(l => l.text.length)) ?? 55);
  const wrapped = paragraphs.map(p => wrap(p, chars));
  const rows = wrapped.reduce((n, p) => n + p.length, 0);
  const pitch = rows ? (top - bottom) / rows : 0;

  const lines = [];
  for (const p of wrapped) {
    const para = { confidence: 100, lines: p.length, words: p.join(' ').split(/\s+/).length };
    p.forEach((line, j) => {
      const slotTop = top - pitch * lines.length;
      const last = j === p.length - 1;
      lines.push({
        text: line,
        x: j === 0 ? left + size * 1.5 : left,
        xEnd: last ? left + (right - left) * Math.max(0.3, Math.min(0.75, line.length / chars)) : right,
        y: slotTop - pitch + Math.min(pitch * 0.3, size * 0.4),
        top: slotTop, // each line's slot reaches up to the one above, so no strip between them looks like a picture
        size,
        mayBeHeading: false,
        para,
      });
    });
  }
  return { lines, confidence: null, manual: true, text: paragraphs.join('\n\n'), page: previous.page, ocrLines: old };
}

// Average word confidence, weighted by word length.
function confidence(data) {
  let sum = 0;
  let chars = 0;
  for (const block of data.blocks || []) {
    for (const para of block.paragraphs) {
      for (const line of para.lines) {
        for (const w of line.words) {
          sum += w.confidence * w.text.length;
          chars += w.text.length;
        }
      }
    }
  }
  return chars ? sum / chars : 0;
}

const recognize = (worker, image) => worker.recognize(image, {}, { blocks: true, text: false }).then(r => r.data);

// Read the sample pages in every language (all at once, a worker each) and keep
// the language read most confidently. Returns it with its worker and the sample
// results, so those pages aren't read twice.
async function detectLanguage(samples) {
  const trials = await Promise.allSettled(
    Object.keys(LANGUAGES).map(async code => {
      const worker = await createWorker(code);
      try {
        const results = await Promise.all(samples.map(s => recognize(worker, s.image)));
        const score = results.reduce((sum, r) => sum + confidence(r), 0) / results.length;
        return { code, score, worker, results };
      } catch (err) {
        await worker.terminate();
        throw err;
      }
    })
  );
  const done = trials.filter(t => t.status === 'fulfilled').map(t => t.value);
  const best = done.sort((a, b) => b.score - a.score)[0];
  for (const t of done) if (t !== best) await t.worker.terminate();
  if (!best) throw trials[0].reason;
  return best;
}

// Read the given pages (1-based numbers) of a pdf.js document.
// `language` is a code from LANGUAGES, or empty to detect it.
// `onProgress({ stage: 'ocr', done, total })` reports pages read, and
// `onPage(n, { confidence, text, thumbnail })` hands over each page as it's read.
// Returns { language, pages: Map(page number → raw reading) } for finishPages.
async function recognizePages(doc, pageNumbers, { language, onProgress = () => {}, onPage } = {}) {
  const pages = new Map();
  if (!pageNumbers.length) return { language, pages };
  if (language && !LANGUAGES[language]) {
    throw new Error(`Unknown OCR language "${language}". Available: ${Object.keys(LANGUAGES).join(', ')}.`);
  }
  const total = pageNumbers.length;
  let done = 0;
  onProgress({ stage: 'ocr', done, total });
  const thumb = !!onPage;
  const finished = (n, data, img) => {
    const r = reading(data, img);
    const { thumbnail } = img;
    pages.set(n, r);
    if (onPage) onPage(n, { confidence: r.confidence, text: r.text, thumbnail });
    onProgress({ stage: 'ocr', done: ++done, total });
  };

  // sample pages from the middle of the book, where there's body text rather than covers
  const sampleCount = language ? 0 : Math.min(SAMPLE_PAGES, total);
  const sampleAt = Array.from({ length: sampleCount }, (_, i) =>
    pageNumbers[Math.floor((total * (i + 1)) / (sampleCount + 1))]
  );
  const samples = [];
  for (const n of sampleAt) samples.push({ n, ...(await pageImage(doc, n, { thumb })) });

  const { createScheduler } = require('tesseract.js');
  const scheduler = createScheduler(); // terminating it also terminates its workers
  const cpus = os.availableParallelism ? os.availableParallelism() : os.cpus().length;
  // each worker reads one page at a time on its own CPU core, using up to ~150 MB
  const workerCount = Math.max(1, Math.min(8, cpus - 1, total - samples.length));
  let code = language;
  try {
    if (samples.length) {
      const detected = await detectLanguage(samples);
      code = detected.code;
      scheduler.addWorker(detected.worker);
      samples.forEach((s, i) => finished(s.n, detected.results[i], s));
    }
    while (scheduler.getNumWorkers() < workerCount) scheduler.addWorker(await createWorker(code));

    // render pages one at a time while the workers read earlier ones, with a
    // limit on rendered pages waiting, so memory stays bounded on long books
    const pending = new Set();
    for (const n of pageNumbers) {
      if (pages.has(n)) continue;
      while (pending.size >= workerCount * 2) await Promise.race(pending);
      const img = await pageImage(doc, n, { thumb });
      const job = scheduler
        .addJob('recognize', img.image, {}, { blocks: true, text: false })
        .then(({ data }) => finished(n, data, img))
        .finally(() => pending.delete(job));
      pending.add(job);
    }
    await Promise.all(pending);
  } finally {
    await scheduler.terminate();
  }
  return { language: code, pages };
}

// Read one page again with each of RETRY_SETTINGS (all at once) and return the
// best reading, with the name of the setting that gave it.
async function retryPage(doc, n, language) {
  const tries = await Promise.all(
    RETRY_SETTINGS.map(async setting => {
      const img = await pageImage(doc, n, setting);
      const worker = await createWorker(language);
      try {
        if (setting.pageSegMode) await worker.setParameters({ tessedit_pageseg_mode: setting.pageSegMode });
        return { ...reading(await recognize(worker, img.image), img), setting: setting.name };
      } finally {
        await worker.terminate();
      }
    })
  );
  return tries.sort((a, b) => (b.confidence ?? -1) - (a.confidence ?? -1))[0];
}

// Mark whole paragraphs that were read far less confidently than the book's
// typical paragraph, like a letter in a handwriting font, as `unreadable`.
// Keeping only the lines that happened to pass would leave nonsense text broken
// up by strips of picture; left out entirely, the paragraph is cropped as one
// picture instead. The lines are still returned, because where they sit shows
// the page's layout (where its text starts, for finding chapters).
function markUnreadable(pages) {
  const confidences = [];
  for (const l of [...pages.values()].flat()) if (l.para.words >= MIN_JUDGED_WORDS) confidences.push(l.para.confidence);
  if (!confidences.length) return pages;
  const typical = median(confidences);
  const threshold = Math.min(MAX_PARAGRAPH_CUTOFF, typical - PARAGRAPH_MARGIN);
  for (const lines of pages.values()) {
    const paras = [...new Set(lines.map(l => l.para))]; // in reading order
    // a few words are too few to judge: a short line of dialogue with quote marks
    // reads less confidently than it deserves
    for (const p of paras) p.unreadable = p.words >= MIN_JUDGED_WORDS && p.confidence < threshold;
    // but a line or two next to an unreadable paragraph that reads a little below
    // typical is part of the same handwriting, which just happened to read better
    let changed = true;
    while (changed) {
      changed = false;
      paras.forEach((p, i) => {
        const nextToUnreadable = paras[i - 1]?.unreadable || paras[i + 1]?.unreadable;
        if (!p.unreadable && p.lines <= 2 && nextToUnreadable && p.confidence < typical - SHORT_PARAGRAPH_MARGIN) {
          p.unreadable = changed = true;
        }
      });
    }
    for (const l of lines) if (l.para.unreadable) l.unreadable = true;
  }
  return pages;
}

// Only lines that look like headings keep a size above the body text size,
// which is the size used for the most text across all the scanned pages. A line
// as wide as the text block is body text in a larger font, not a heading.
function normalizeSizes(pages) {
  const all = [...pages.values()].flat();
  const chars = new Map();
  for (const l of all) chars.set(l.size, (chars.get(l.size) || 0) + l.text.length);
  const bodySize = [...chars.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const bodyWidth = median(all.filter(l => l.size === bodySize).map(l => l.xEnd - l.x)) ?? Infinity;
  const isHeading = l => l.mayBeHeading && l.xEnd - l.x < bodyWidth * 0.8;
  for (const [n, lines] of pages) {
    pages.set(
      n,
      lines.map(({ mayBeHeading, para, ...l }) =>
        isHeading({ ...l, mayBeHeading }) ? l : { ...l, size: Math.min(l.size, bodySize) }
      )
    );
  }
  return pages;
}

// Raw readings → Map(page number → lines) for the converter, judging paragraphs
// and sizes across the whole book. Lines to leave out of the text have
// `unreadable` set. The raw readings aren't changed, so they can be finished again.
function finishPages(readings) {
  const pages = new Map();
  for (const [n, r] of readings) {
    const paras = new Map();
    pages.set(n, r.lines.map(l => {
      if (!paras.has(l.para)) paras.set(l.para, { ...l.para });
      return { ...l, para: paras.get(l.para) };
    }));
  }
  return normalizeSizes(markUnreadable(pages));
}

module.exports = { recognizePages, retryPage, manualReading, finishPages, LANGUAGES };
