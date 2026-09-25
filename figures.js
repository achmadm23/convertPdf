// Find pictures on PDF pages. Scanned books bake pictures into full-page scans,
// so instead of extracting embedded images we look for gaps in the body text,
// render just those pages, and crop any ink in the gaps that isn't text.

const { createCanvas } = require('@napi-rs/canvas');

const SCALE = 2; // render resolution: 2 pixels per PDF point (144 dpi)
const INK = 225; // pixel luminance below this counts as ink
const MIN_GAP = 45; // points; smaller gaps between text lines are just spacing

const median = arr => {
  const s = [...arr].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};

// Text block edges and line spacing shared by all pages of the book.
function measureLayout(pageLines, bodySize) {
  // body text, plus the slightly smaller text used for notes and captions
  const isText = l => l.size >= bodySize - 2.5 && l.size <= bodySize + 1;
  const fullWidth = median(pageLines.flat().filter(l => Math.abs(l.size - bodySize) <= 1).map(l => l.xEnd - l.x));
  const isLong = l => isText(l) && l.xEnd - l.x >= fullWidth * 0.6;

  const tops = [];
  const bottoms = [];
  const gaps = [];
  for (const lines of pageLines) {
    const long = lines.filter(isLong).sort((a, b) => b.y - a.y);
    if (long.length < 5) continue;
    tops.push(long[0].y);
    bottoms.push(long[long.length - 1].y);
    for (let i = 1; i < long.length; i++) gaps.push(long[i - 1].y - long[i].y);
  }
  // a line of real sentences, as opposed to a short label inside a picture
  const isProse = l => isText(l) && (l.text.match(/\p{L}/gu) || []).length >= 15;
  return {
    isLong,
    isProse,
    blockTop: median(tops),
    blockBottom: median(bottoms),
    lineGap: median(gaps) || bodySize * 1.4,
  };
}

// Vertical ranges (PDF coordinates, top > bottom) with no body text or headings in them.
function findGaps(lines, layout, bodySize) {
  const isHeading = l => l.size >= bodySize * 1.4 && /\p{L}{3}/u.test(l.text);
  const long = lines.filter(l => layout.isLong(l) || isHeading(l)).sort((a, b) => b.y - a.y);
  const edges = [
    layout.blockTop + bodySize,
    // OCR'd lines know their exact top; for others it's estimated from the font size
    ...long.flatMap(l => [l.top ?? l.y + Math.max(bodySize, l.size), l.y - l.size * 0.3]),
    layout.blockBottom - bodySize * 0.3,
  ];
  const gaps = [];
  for (let i = 0; i + 1 < edges.length; i += 2) {
    const top = edges[i];
    const bottom = edges[i + 1];
    if (top - bottom >= MIN_GAP) gaps.push({ top, bottom });
  }
  return gaps;
}

async function renderPage(page, scale) {
  const viewport = page.getViewport({ scale });
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport, canvas }).promise;
  return canvas;
}

// Render the page and crop the pictures that sit in its text gaps. Prose lines
// never count as part of a picture, so a caption or the end of a paragraph next
// to the picture stays text instead of being cropped into the image.
async function detectFigures(page, lines, gaps, layout) {
  const canvas = await renderPage(page, SCALE);
  const { width, height } = canvas;
  const pageHeight = page.view[3] - page.view[1];
  const pixels = canvas.getContext('2d').getImageData(0, 0, width, height).data;
  const ink = new Uint8Array(width * height);
  for (let i = 0, p = 0; p < ink.length; i += 4, p++) {
    ink[p] = 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2] < INK ? 1 : 0;
  }

  // mark text lines: 1 = any text, 2 = prose, which is ignored entirely
  const text = new Uint8Array(width * height);
  for (const l of lines) {
    const size = l.size || 10;
    const prose = layout.isProse(l);
    const x0 = Math.max(0, Math.floor((l.x - 2) * SCALE));
    const x1 = Math.min(width, Math.ceil((l.xEnd + 2) * SCALE));
    const top = l.top !== undefined ? l.top + 1 : l.y + size * (prose ? 1.1 : 1);
    const y0 = Math.max(0, Math.floor((pageHeight - top) * SCALE));
    const y1 = Math.min(height, Math.ceil((pageHeight - l.y + size * (prose ? 0.5 : 0.35)) * SCALE));
    for (let y = y0; y < y1; y++) {
      for (let p = y * width + x0; p < y * width + x1; p++) text[p] = Math.max(text[p], prose ? 2 : 1);
    }
  }

  const figures = [];
  for (const gap of gaps) {
    const r0 = Math.max(0, Math.floor((pageHeight - gap.top) * SCALE));
    const r1 = Math.min(height, Math.ceil((pageHeight - gap.bottom) * SCALE));

    let pictureInk = 0;
    let top = -1, bottom = -1, left = width, right = -1;
    for (let y = r0; y < r1; y++) {
      let rowInk = 0;
      let rowLeft = -1, rowRight = -1;
      for (let x = 0, p = y * width; x < width; x++, p++) {
        if (!ink[p] || text[p] === 2) continue;
        if (!text[p]) pictureInk++;
        rowInk++;
        if (rowLeft < 0) rowLeft = x;
        rowRight = x;
      }
      if (rowInk < 3) continue; // ignore scanner specks
      if (top < 0) top = y;
      bottom = y;
      left = Math.min(left, rowLeft);
      right = Math.max(right, rowRight);
    }

    // needs a real amount of non-text ink (about 25 x 25 points) to be a picture
    if (pictureInk < 600 * SCALE * SCALE || bottom - top < 30 * SCALE) continue;

    const pad = 4 * SCALE;
    top = Math.max(0, top - pad);
    bottom = Math.min(height - 1, bottom + pad);
    left = Math.max(0, left - pad);
    right = Math.min(width - 1, right + pad);
    const crop = createCanvas(right - left + 1, bottom - top + 1);
    crop.getContext('2d').drawImage(canvas, left, top, crop.width, crop.height, 0, 0, crop.width, crop.height);
    figures.push({
      top: pageHeight - top / SCALE,
      bottom: pageHeight - bottom / SCALE,
      left: left / SCALE,
      right: right / SCALE,
      data: await crop.encode('jpeg', 82),
    });
  }
  return figures;
}

async function renderCover(page) {
  const canvas = await renderPage(page, 1.5);
  return canvas.encode('jpeg', 85);
}

module.exports = { measureLayout, findGaps, detectFigures, renderCover, renderPage };
