// The text of a PDF's pages as pdf.js gives it (getTextContent), repaired where the
// PDF maps its characters to the wrong letters, and the decorations drawn on its pages.
//
// A PDF's text is codes in a font; the font's ToUnicode table says which letters they
// are. Some PDFs come with a table that's wrong in ways that are easy to spot once each
// code's glyph is looked at, and not at all from the text alone:
//   - capitals given as small letters: code 0x41, the "A" of a font with no encoding of its
//     own, mapped to "a" (and B, C, E… alike), so "CATATAN" reads "catataN" and a sentence
//     starts "yakinkan"
//   - ligatures given as their last letter: the "fi" glyph mapped to "i", so "filsuf" reads
//     "ilsuf" and "fleksibel" "leksibel"
// pdf.js's operator list has each glyph with its code, its letter and its width, which
// tell those apart: a capital is wider than its small letter, a ligature about as wide as
// its letters together. The letters found are put back in the text of getTextContent.
//
// Decorations are pictures drawn at the same place on many pages with text over them,
// like a frame around a quotation: they are not pictures of the book, and the text in
// them is the book's text (see decorationBoxes).

const { pdfOps } = require('./pdf');

// a font is known once this many of its glyphs, or its glyphs on this many pages, were
// looked at; later pages using only known fonts with nothing to repair aren't looked at
const KNOWN_GLYPHS = 400;
const KNOWN_PAGES = 3;
// how far ahead in a font's glyphs a letter of the text is looked for
const LOOKAHEAD = 12;

// Each font's glyphs on a page, in the order they're drawn: font name → [[code, letter]],
// and what is learned of each code of the font (its letter and width) into `fonts`.
function pageGlyphs(ops, OPS, fonts) {
  const runs = new Map();
  let font = null;
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    if (fn === OPS.setFont) font = ops.argsArray[i][0];
    else if (fn === OPS.showText && font) {
      let run = runs.get(font);
      if (!run) runs.set(font, (run = []));
      const known = fontEntry(fonts, font);
      for (const g of ops.argsArray[i][0]) {
        if (!g || typeof g !== 'object' || typeof g.originalCharCode !== 'number') continue;
        const letter = typeof g.unicode === 'string' ? g.unicode : '';
        run.push([g.originalCharCode, letter]);
        known.glyphs++;
        if (!known.codes.has(g.originalCharCode) && g.width > 0) known.codes.set(g.originalCharCode, { letter, width: g.width });
      }
    }
  }
  return runs;
}

const fontEntry = (fonts, name) => {
  if (!fonts.has(name)) fonts.set(name, { codes: new Map(), glyphs: 0, pages: 0, fixes: null });
  return fonts.get(name);
};

// The codes of a font whose letters are wrong, with the right ones: code → text.
function findFixes(codes) {
  const fixes = new Map();

  // Capitals mapped to their small letter. Only in a font that does it to two letters or
  // more (one could be a coincidence of a font with an encoding of its own), and only where
  // the code's glyph is wider than the small letter's, when the font has that one too.
  const capitals = [];
  for (const [code, { letter, width }] of codes) {
    if (code < 0x41 || code > 0x5a || letter !== String.fromCharCode(code + 0x20)) continue;
    const small = codes.get(code + 0x20);
    if (small && small.letter === letter && !(width > small.width * 1.05)) continue;
    capitals.push(code);
  }
  if (capitals.length >= 2) for (const code of capitals) fixes.set(code, String.fromCharCode(code));

  // Ligatures mapped to their last letter: a second glyph for "i", "l" or "f", much wider
  // than the plain one and about as wide as "f" and that letter together (a ligature is a
  // little narrower than its letters side by side).
  const narrowest = letter => {
    let w = Infinity;
    for (const [code, c] of codes) if (c.letter === letter && !fixes.has(code)) w = Math.min(w, c.width);
    return Number.isFinite(w) ? w : 0;
  };
  const wf = narrowest('f');
  if (wf) {
    for (const [code, { letter, width }] of codes) {
      if (fixes.has(code) || !['f', 'i', 'l'].includes(letter)) continue;
      const wl = narrowest(letter);
      if (!wl || width < wl * 1.4) continue;
      const near = w => width >= w * 0.78 && width <= w * 1.08;
      if (letter === 'f' && near(2 * wf)) fixes.set(code, 'ff');
      else if (letter !== 'f' && near(wf + wl)) fixes.set(code, 'f' + letter);
      else if (letter !== 'f' && near(2 * wf + wl)) fixes.set(code, 'ff' + letter);
    }
  }
  return fixes;
}

// Put the right letters in a page's text items. The items of each font hold its glyphs'
// letters in the order they're drawn (with spaces pdf.js adds between words), so each
// letter of an item is matched to the next glyph of its font that gives it.
function repairItems(items, runs, fonts) {
  const at = new Map();
  let repaired = 0;
  for (const item of items) {
    const fixes = fonts.get(item.fontName)?.fixes;
    const run = runs.get(item.fontName);
    if (!fixes?.size || !run || typeof item.str !== 'string' || !item.str || item.dir === 'rtl') continue;
    const s = item.str;
    let i = at.get(item.fontName) || 0;
    let out = '';
    let changed = false;
    for (let pos = 0; pos < s.length; ) {
      if (/\s/.test(s[pos])) {
        out += s[pos++];
        continue;
      }
      let hit = -1;
      let text = '';
      for (let k = i; k < run.length && k < i + LOOKAHEAD; k++) {
        const letter = run[k][1];
        if (!letter.trim()) continue;
        // pdf.js may have written a ligature character out as its letters
        const plain = letter.normalize('NFKC');
        text = s.startsWith(letter, pos) ? letter : s.startsWith(plain, pos) ? plain : '';
        if (text) {
          hit = k;
          break;
        }
      }
      if (hit < 0) {
        out += s[pos++];
        continue;
      }
      const fixed = fixes.get(run[hit][0]);
      if (fixed !== undefined && fixed !== text) {
        changed = true;
        repaired++;
      }
      out += fixed ?? text;
      pos += text.length;
      i = hit + 1;
    }
    at.set(item.fontName, i);
    if (changed) item.str = out;
  }
  return repaired;
}

// Every page's text items, repaired: { pages: [items of page 1, items of page 2, …],
// views: each page's view box (page.view), repaired: how many glyphs were given their
// right letters }.
// `onPage(n, total)` is called as each page is read.
async function readTextLayer(doc, onPage = () => {}) {
  const OPS = await pdfOps();
  const fonts = new Map();
  const pages = [];
  const views = [];
  const looked = new Map(); // page number → its glyph runs, for the pages looked at
  const settle = font => {
    if (!font.fixes && (font.glyphs >= KNOWN_GLYPHS || font.pages >= KNOWN_PAGES)) font.fixes = findFixes(font.codes);
  };
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const { items } = await page.getTextContent();
    pages.push(items);
    views.push(page.view);
    const names = [...new Set(items.filter(i => i.str && i.str.trim()).map(i => i.fontName))];
    // a page is looked at while one of its fonts isn't known yet, or has letters to repair
    if (names.some(name => !fonts.get(name)?.fixes || fonts.get(name).fixes.size)) {
      looked.set(n, pageGlyphs(await page.getOperatorList(), OPS, fonts));
      for (const name of names) {
        const font = fontEntry(fonts, name);
        font.pages++;
        settle(font);
      }
    }
    onPage(n, doc.numPages);
  }
  // fonts used too little to be known yet are judged on what there is of them
  for (const font of fonts.values()) if (!font.fixes) font.fixes = findFixes(font.codes);
  let repaired = 0;
  for (const [n, runs] of looked) repaired += repairItems(pages[n - 1], runs, fonts);
  return { pages, views, repaired };
}

// ---------------------------------------------------------------- decorations

const multiply = (m, n) => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
];

// The pictures (embedded images) drawn on a page: their pixel size and where they're
// drawn, in the PDF's coordinates: { key, left, right, bottom, top }.
function pageImages(ops, OPS) {
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  const images = [];
  const add = (width, height) => {
    if (!width || !height) return;
    const xs = [], ys = [];
    for (const [u, v] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      xs.push(ctm[0] * u + ctm[2] * v + ctm[4]);
      ys.push(ctm[1] * u + ctm[3] * v + ctm[5]);
    }
    const box = { left: Math.min(...xs), right: Math.max(...xs), bottom: Math.min(...ys), top: Math.max(...ys) };
    images.push({ key: `${width}x${height}`, ...box });
  };
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    const args = ops.argsArray[i];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() || ctm;
    else if (fn === OPS.transform) ctm = multiply(ctm, args);
    else if (fn === OPS.paintFormXObjectBegin) {
      stack.push(ctm);
      if (Array.isArray(args[0]) && args[0].length === 6) ctm = multiply(ctm, args[0]);
    } else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() || ctm;
    else if (fn === OPS.paintImageXObject) add(args[1], args[2]);
    else if (fn === OPS.paintInlineImageXObject || fn === OPS.paintImageMaskXObject) add(args[0]?.width, args[0]?.height);
  }
  return images;
}

// Decorations on the given pages: page number → boxes, from the corner of the page's view
// box (as pageToLines's lines). A decoration is a picture of the same size in pixels drawn on
// 5 pages or more (maybe stretched, as a frame is to its text), with text over it on most
// of them, and covering less than half the page (a scanned page's own picture fills it, and
// every page of a scan has one the same size). `lines(n)` gives page n's lines.
async function decorationBoxes(doc, pageNumbers, lines) {
  const OPS = await pdfOps();
  const found = new Map();
  for (const n of pageNumbers) {
    const page = await doc.getPage(n);
    const [x0, y0, x1, y1] = page.view;
    const area = (x1 - x0) * (y1 - y0);
    const images = pageImages(await page.getOperatorList(), OPS)
      .filter(b => (b.right - b.left) * (b.top - b.bottom) < area * 0.5)
      .map(b => ({ ...b, left: b.left - x0, right: b.right - x0, bottom: b.bottom - y0, top: b.top - y0 }));
    found.set(n, images);
  }
  const textInside = (n, b) => (lines(n) || []).some(l =>
    !l.image && l.y >= b.bottom - 2 && l.y <= b.top + 2 && l.x >= b.left - 2 && l.xEnd <= b.right + 2
  );
  const seen = new Map(); // key → { pages, withText }
  for (const [n, images] of found) {
    for (const key of new Set(images.map(b => b.key))) {
      const s = seen.get(key) || { pages: 0, withText: 0 };
      s.pages++;
      if (images.some(b => b.key === key && textInside(n, b))) s.withText++;
      seen.set(key, s);
    }
  }
  const decorative = new Set([...seen].filter(([, s]) => s.pages >= 5 && s.withText >= s.pages * 0.6).map(([key]) => key));
  const boxes = new Map();
  for (const [n, images] of found) {
    const mine = images.filter(b => decorative.has(b.key));
    if (mine.length) boxes.set(n, mine);
  }
  return boxes;
}

// A page's gaps (figures.js findGaps: the heights between its text where pictures are
// looked for) without the heights of its decorations.
function cutGaps(gaps, boxes = [], minGap = 0) {
  let out = gaps;
  for (const b of boxes) {
    const top = b.top + 2, bottom = b.bottom - 2;
    out = out.flatMap(g => (top < g.bottom || bottom > g.top ? [g] : [
      { top: g.top, bottom: Math.max(top, g.bottom) },
      { top: Math.min(bottom, g.top), bottom: g.bottom },
    ].filter(p => p.top - p.bottom >= Math.max(minGap, 1))));
  }
  return out;
}

module.exports = { readTextLayer, decorationBoxes, cutGaps, findFixes, repairItems, pageImages };
