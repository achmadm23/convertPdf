// Convert the text of a PDF into an EPUB 3 file.
// Usage: node index.js input.pdf [output.epub] [--title "My Book"] [--author "Name"]

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const JSZip = require('jszip');
const { measureLayout, findGaps, detectFigures, renderCover } = require('./figures');
const { FONTS, findFont, fontFaces, fontFaceCss, fontStack } = require('./fonts');
const { ocrPages, LANGUAGES } = require('./ocr');

function parseArgs(argv) {
  const opts = { positional: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--title') opts.title = argv[++i];
    else if (argv[i] === '--author') opts.author = argv[++i];
    else if (argv[i] === '--font') opts.font = argv[++i];
    else if (argv[i] === '--ocr-lang') opts.ocrLanguage = argv[++i];
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

  return lines
    .map(l => ({ ...l, text: l.text.replace(/\s+/g, ' ').trim() }))
    .filter(l => l.text);
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
      const indented = l.x > leftEdge + 6;
      const prevShort = prev && prev.xEnd < rightEdge - 25 && /[.!?:"”’)]$/.test(prev.text);
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
// `ocrLanguage` is a language code from ocr.js; empty means detect it.
async function extractPdf(buffer, onProgress = () => {}, { ocrLanguage } = {}) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(buffer);
  // decoders for scanned images (JBIG2, JPEG 2000) and fonts, needed to render pages
  const pdfjsRoot = path.dirname(require.resolve('pdfjs-dist/package.json'));
  const doc = await pdfjs.getDocument({
    data,
    useSystemFonts: true,
    verbosity: 0,
    wasmUrl: path.join(pdfjsRoot, 'wasm') + '/',
    standardFontDataUrl: path.join(pdfjsRoot, 'standard_fonts') + '/',
    cMapUrl: path.join(pdfjsRoot, 'cmaps') + '/',
  }).promise;

  let meta = {};
  try {
    meta = (await doc.getMetadata()).info || {};
  } catch {}

  const pageLines = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    pageLines.push(pageToLines(content.items));
    onProgress({ stage: 'text', done: n, total: doc.numPages });
  }

  // pages with no text layer are scans: read them with OCR
  const scanned = [];
  pageLines.forEach((lines, i) => {
    if (letterCount(lines.map(l => l.text).join('')) < 20) scanned.push(i + 1);
  });
  // every line found on the page, even ones left out of the text, for the page layout
  const layoutLines = [...pageLines];
  if (scanned.length) {
    const ocrLines = await ocrPages(doc, scanned, { language: ocrLanguage, onProgress });
    for (const [n, lines] of ocrLines) {
      layoutLines[n - 1] = lines;
      pageLines[n - 1] = lines.filter(l => !l.unreadable);
    }
  }

  // the body font size is the one used for the most text
  const sizeChars = new Map();
  for (const l of pageLines.flat()) sizeChars.set(l.size, (sizeChars.get(l.size) || 0) + l.text.length);
  const bodySize = [...sizeChars.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 10;

  const layout = measureLayout(pageLines, bodySize);
  const hasCoverCandidate = pageLines.length > 0 && pageLines[0].filter(layout.isLong).length < 5;
  const firstChecked = hasCoverCandidate ? 2 : 1;
  const candidates = [];
  for (let n = firstChecked; n <= doc.numPages; n++) {
    if (findGaps(pageLines[n - 1], layout, bodySize).length) candidates.push(n);
  }
  const renders = candidates.length + (hasCoverCandidate ? 1 : 0);
  let rendered = 0;
  onProgress({ stage: 'pictures', done: 0, total: renders });

  let cover = null;
  // a first page that is mostly picture with hardly any body text is the cover
  if (hasCoverCandidate) {
    const first = await doc.getPage(1);
    const height = first.view[3] - first.view[1];
    const [picture] = await detectFigures(first, pageLines[0], [{ top: height, bottom: 0 }], layout);
    if (picture && picture.top - picture.bottom > height * 0.5) {
      cover = await renderCover(first);
      pageLines[0] = [];
    }
    onProgress({ stage: 'pictures', done: ++rendered, total: renders });
  }
  // page 1 wasn't the cover after all, so check it for pictures like any other page
  if (hasCoverCandidate && !cover && findGaps(pageLines[0], layout, bodySize).length) candidates.unshift(1);

  // crop pictures from pages with gaps in their text, and put them in the
  // text flow in place of the labels it contains
  const images = [];
  for (const n of candidates) {
    const gaps = findGaps(pageLines[n - 1], layout, bodySize);
    const page = await doc.getPage(n);
    const figures = await detectFigures(page, pageLines[n - 1], gaps, layout);
    page.cleanup();
    onProgress({ stage: 'pictures', done: Math.min(++rendered, renders), total: renders });
    for (const fig of figures) {
      const name = `img${images.length + 1}.jpg`;
      images.push({ name, data: fig.data });
      // text shown inside the cropped picture is dropped; anything outside it stays
      const inside = l =>
        l.y <= fig.top + 2 && l.y >= fig.bottom - 2 && l.x >= fig.left - 2 && l.xEnd <= fig.right + 2;
      const lines = pageLines[n - 1].filter(l => !inside(l));
      const at = lines.findIndex(l => l.y < fig.top);
      lines.splice(at < 0 ? lines.length : at, 0, { image: name, y: fig.top });
      pageLines[n - 1] = lines;
    }
  }

  const startsLow = lowStartPages(pageLines, layoutLines, layout);
  const pages = pageLines.map(lines => linesToBlocks(lines, bodySize));
  return { pages, images, cover, startsLow, title: meta.Title, author: meta.Author };
}

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
      current = { title, blocks };
      chapters.push(current);
    } else {
      if (!current) {
        current = { title: 'Opening', blocks: [] };
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
      current = { title: `Chapter ${chapters.filter(ch => ch.title !== 'Opening').length + 1}`, blocks: [] };
      chapters.push(current);
    } else if (!current) {
      current = { title: 'Opening', blocks: [] };
      chapters.push(current);
    }
    current.blocks.push(...page);
  });
  return chapters.filter(ch => ch.blocks.length || ch.title !== 'Opening');
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
    });
  }
  return chapters;
}

function chapterXhtml(ch) {
  const body = ch.blocks
    .map((b, i) => {
      if (b.image) return `    <figure><img src="images/${b.image}" alt=""/></figure>`;
      if (b.heading) return `    <h3 id="s${i}">${escapeXml(b.text)}</h3>`;
      return `    <p>${escapeXml(b.text)}</p>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
  <head>
    <title>${escapeXml(ch.title)}</title>
    <link rel="stylesheet" type="text/css" href="style.css"/>
  </head>
  <body>
    <h2>${escapeXml(ch.title)}</h2>
${body}
  </body>
</html>`;
}

// Package an analysed book as an EPUB. This is fast, so the same book can be
// re-packaged with a different font without reading the PDF again.
async function buildEpub({ title, author, chapters, images = [], cover = null }, { font: fontId } = {}) {
  const font = findFont(fontId);
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

  for (const face of fontFaces(font)) {
    zip.file(`OEBPS/fonts/${face.file}`, fs.readFileSync(face.path), { compression: 'STORE' });
    manifest.push(`    <item id="${face.file.replace(/\./g, '-')}" href="fonts/${face.file}" media-type="font/woff"/>`);
  }

  zip.file('OEBPS/style.css', `${fontFaceCss(font, 'fonts/')}
body { font-family: ${fontStack(font)}; line-height: 1.5; margin: 0 5%; }
h2 { text-align: center; margin: 1.5em 0; }
h3 { margin: 1.5em 0 0.75em; }
h3 + p { text-indent: 0; }
p { text-indent: 1.5em; margin: 0 0 0.5em 0; text-align: justify; }
figure { margin: 1em 0; text-align: center; page-break-inside: avoid; }
figure img { max-width: 100%; height: auto; }
body.cover { margin: 0; text-align: center; }
body.cover img { max-width: 100%; max-height: 100vh; }`);

  for (const img of images) {
    zip.file(`OEBPS/images/${img.name}`, img.data, { compression: 'STORE' });
    manifest.push(`    <item id="${img.name.replace('.', '-')}" href="images/${img.name}" media-type="image/jpeg"/>`);
  }
  if (cover) {
    zip.file('OEBPS/images/cover.jpg', cover, { compression: 'STORE' });
    zip.file('OEBPS/cover.xhtml', `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
  <head>
    <title>Cover</title>
    <link rel="stylesheet" type="text/css" href="style.css"/>
  </head>
  <body class="cover">
    <img src="images/cover.jpg" alt="Cover"/>
  </body>
</html>`);
    manifest.push('    <item id="cover-image" href="images/cover.jpg" media-type="image/jpeg" properties="cover-image"/>');
    manifest.push('    <item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>');
    spine.push('    <itemref idref="cover"/>');
  }
  chapters.forEach((ch, i) => {
    const name = `chapter${i + 1}.xhtml`;
    zip.file(`OEBPS/${name}`, chapterXhtml(ch));
    manifest.push(`    <item id="ch${i + 1}" href="${name}" media-type="application/xhtml+xml"/>`);
    spine.push(`    <itemref idref="ch${i + 1}"/>`);
    const sections = ch.blocks
      .map((b, j) => (b.heading ? `          <li><a href="${name}#s${j}">${escapeXml(b.text)}</a></li>` : null))
      .filter(Boolean);
    const sub = sections.length ? `\n          <ol>\n${sections.join('\n')}\n          </ol>\n        ` : '';
    navItems.push(`        <li><a href="${name}">${escapeXml(ch.title)}</a>${sub}</li>`);
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
    <dc:language>en</dc:language>
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

// Read a PDF into a book: chapters, images and cover, ready for buildEpub.
// `name` is used as the title when the PDF has none.
async function analyzePdf(pdfBuffer, { title, author, name = 'Untitled', onProgress, ocrLanguage } = {}) {
  const extracted = await extractPdf(pdfBuffer, onProgress, { ocrLanguage });
  const pages = cleanPages(extracted.pages);
  const paragraphs = pages.reduce((n, p) => n + p.filter(b => !b.heading && !b.image).length, 0);
  if (paragraphs === 0) {
    throw new Error('No text found, even with OCR. The PDF may contain only pictures.');
  }
  return {
    title: title || extracted.title || name,
    author: author || extracted.author || 'Unknown',
    chapters: buildChapters(pages, extracted.startsLow),
    images: extracted.images,
    cover: extracted.cover,
    stats: { pages: pages.length, paragraphs, images: extracted.images.length },
  };
}

// Convert PDF bytes to EPUB bytes in one go.
async function convertPdfToEpub(pdfBuffer, { font, ...options } = {}) {
  const book = await analyzePdf(pdfBuffer, options);
  const epub = await buildEpub(book, { font });
  return { epub, ...book.stats, chapters: book.chapters.length };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const [input, output] = opts.positional;
  if (!input) {
    console.error(
      'Usage: node index.js input.pdf [output.epub] [--title "Title"] [--author "Author"] [--font id] [--ocr-lang code]'
    );
    console.error('Fonts: ' + FONTS.map(f => f.id).join(', '));
    console.error(
      'OCR languages (for scanned pages; detected when not given): ' +
        Object.entries(LANGUAGES).map(([code, name]) => `${code} (${name})`).join(', ')
    );
    process.exit(1);
  }
  const outFile = output || input.replace(/\.pdf$/i, '') + '.epub';

  const { epub, pages, paragraphs, chapters, images } = await convertPdfToEpub(fs.readFileSync(input), {
    title: opts.title,
    author: opts.author,
    font: opts.font,
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

module.exports = { convertPdfToEpub, analyzePdf, buildEpub, extractPdf, cleanPages, buildChapters };

if (require.main === module) {
  main().catch(err => {
    console.error(err.message || err);
    process.exit(1);
  });
}
