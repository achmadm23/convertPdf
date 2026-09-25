// Read scanned pages with OCR. Pages without a text layer are rendered and read
// with Tesseract (tesseract.js, bundled, so nothing needs installing), and the
// result is returned as lines in the same shape as pageToLines in index.js.

const os = require('os');
const path = require('path');
const { renderPage } = require('./figures');

const DPI = 300;
const SCALE = DPI / 72; // pixels per PDF point
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

async function pageImage(doc, n) {
  const page = await doc.getPage(n);
  const canvas = await renderPage(page, SCALE);
  // JPEG encodes several times faster than PNG and reads just as well
  const image = await canvas.encode('jpeg', 90);
  const height = page.view[3] - page.view[1];
  page.cleanup();
  return { image, height };
}

const median = arr => {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

// Tesseract's blocks → lines with PDF coordinates (y is the baseline, measured from the bottom).
function toLines(data, pageHeight) {
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
        const size = Math.round(median(words.map(w => w.bbox.y1 - w.bbox.y0)) / SCALE);
        const baseline = (line.baseline.y0 + line.baseline.y1) / 2;
        const text = words.map(w => w.text).join(' ');
        lines.push({
          text,
          x: line.bbox.x0 / SCALE,
          xEnd: line.bbox.x1 / SCALE,
          y: pageHeight - baseline / SCALE,
          top: pageHeight - line.bbox.y0 / SCALE, // includes a large first letter, unlike size
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

// OCR the given pages (1-based numbers) of a pdf.js document.
// Returns Map(page number → lines); lines to leave out of the text have `unreadable` set. `language` is a code from LANGUAGES, or
// empty to detect it. `onProgress({ stage: 'ocr', done, total })` reports pages read.
async function ocrPages(doc, pageNumbers, { language, onProgress = () => {} } = {}) {
  const result = new Map();
  if (!pageNumbers.length) return result;
  if (language && !LANGUAGES[language]) {
    throw new Error(`Unknown OCR language "${language}". Available: ${Object.keys(LANGUAGES).join(', ')}.`);
  }
  const total = pageNumbers.length;
  let done = 0;
  onProgress({ stage: 'ocr', done, total });

  // sample pages from the middle of the book, where there's body text rather than covers
  const sampleCount = language ? 0 : Math.min(SAMPLE_PAGES, total);
  const sampleAt = Array.from({ length: sampleCount }, (_, i) =>
    pageNumbers[Math.floor((total * (i + 1)) / (sampleCount + 1))]
  );
  const samples = [];
  for (const n of sampleAt) samples.push({ n, ...(await pageImage(doc, n)) });

  const { createScheduler } = require('tesseract.js');
  const scheduler = createScheduler(); // terminating it also terminates its workers
  const cpus = os.availableParallelism ? os.availableParallelism() : os.cpus().length;
  // each worker reads one page at a time on its own CPU core, using up to ~150 MB
  const workerCount = Math.max(1, Math.min(8, cpus - 1, total - samples.length));
  try {
    let code = language;
    if (samples.length) {
      const detected = await detectLanguage(samples);
      code = detected.code;
      scheduler.addWorker(detected.worker);
      samples.forEach((s, i) => result.set(s.n, toLines(detected.results[i], s.height)));
      done += samples.length;
      onProgress({ stage: 'ocr', done, total });
    }
    while (scheduler.getNumWorkers() < workerCount) scheduler.addWorker(await createWorker(code));

    // render pages one at a time while the workers read earlier ones, with a
    // limit on rendered pages waiting, so memory stays bounded on long books
    const pending = new Set();
    for (const n of pageNumbers) {
      if (result.has(n)) continue;
      while (pending.size >= workerCount * 2) await Promise.race(pending);
      const { image, height } = await pageImage(doc, n);
      const job = scheduler
        .addJob('recognize', image, {}, { blocks: true, text: false })
        .then(({ data }) => {
          result.set(n, toLines(data, height));
          onProgress({ stage: 'ocr', done: ++done, total });
        })
        .finally(() => pending.delete(job));
      pending.add(job);
    }
    await Promise.all(pending);
  } finally {
    await scheduler.terminate();
  }
  return normalizeSizes(markUnreadable(result));
}

module.exports = { ocrPages, LANGUAGES };
