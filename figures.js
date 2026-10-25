// Find pictures on PDF pages. Scanned books bake pictures into full-page scans,
// so instead of extracting embedded images we look for gaps in the body text,
// render just those pages, and crop any ink in the gaps that isn't text.

const { createCanvas, loadImage } = require('@napi-rs/canvas');
const { screenImage } = require('./eink');

const SCALE = 2; // render resolution: 2 pixels per PDF point (144 dpi)
const INK = 225; // pixel luminance below this counts as ink
const MIN_GAP = 45; // points; smaller gaps between text lines are just spacing
// a picture at least this share of its page's height is a full-page picture
const FULL_PAGE = 0.6;

const median = arr => {
  const s = [...arr].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};

// Text block edges and line spacing shared by all pages of the book.
function measureLayout(pageLines, bodySize) {
  const fullWidth = median(pageLines.flat().filter(l => Math.abs(l.size - bodySize) <= 1).map(l => l.xEnd - l.x));
  const { isLong } = layoutFrom({ bodySize, fullWidth });

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
  return layoutFrom({
    bodySize,
    fullWidth,
    blockTop: median(tops),
    blockBottom: median(bottoms),
    lineGap: median(gaps) || bodySize * 1.4,
  });
}

// The layout from its measures (as measureLayout makes them), with the tests of
// lines that go with them. A worker thread gets the measures and makes its own.
function layoutFrom(measures) {
  const { bodySize, fullWidth } = measures;
  // body text, plus the smaller text used for notes and captions. Some PDFs
  // (machine-translated ones) set each block of text in its own size, so text up
  // to 30% smaller or larger counts too; headings start at 40% larger.
  const isText = l =>
    l.size >= Math.min(bodySize - 2.5, bodySize * 0.7) && l.size <= Math.max(bodySize + 1, bodySize * 1.3);
  const isLong = l => isText(l) && l.xEnd - l.x >= fullWidth * 0.6;
  // a line of real sentences, as opposed to a short label inside a picture
  const isProse = l => isText(l) && (l.text.match(/\p{L}/gu) || []).length >= 15;
  return { ...measures, isText, isLong, isProse };
}

// The measures of a layout, without its tests, to send to a worker thread.
const layoutMeasures = ({ isText, isLong, isProse, ...measures }) => measures;

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

// The lines that are prose: real sentences, plus the short last line of a
// paragraph ("ini sendiri?'") right under one, which is no label of a picture.
function proseLines(lines, layout) {
  const prose = new Set(lines.filter(layout.isProse));
  const byHeight = lines.filter(l => !l.image).sort((a, b) => b.y - a.y);
  for (let i = 1; i < byHeight.length; i++) {
    const l = byHeight[i], above = byHeight[i - 1];
    if (prose.has(above) && layout.isText(l) && above.y - l.y <= layout.lineGap * 1.6 && Math.abs(l.x - above.x) <= 30) {
      prose.add(l);
    }
  }
  return prose;
}

// Render the page and crop the pictures that sit in its text gaps. Prose lines
// never count as part of a picture, so a caption or the end of a paragraph next
// to the picture stays text instead of being cropped into the image.
async function detectFigures(page, lines, gaps, layout, screen) {
  const canvas = await renderPage(page, SCALE);
  const { width, height } = canvas;
  const pageHeight = page.view[3] - page.view[1];
  const pixels = canvas.getContext('2d').getImageData(0, 0, width, height).data;
  const ink = new Uint8Array(width * height);
  for (let i = 0, p = 0; p < ink.length; i += 4, p++) {
    ink[p] = 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2] < INK ? 1 : 0;
  }

  // mark text lines: 1 = any text, 2 = prose, which is ignored entirely
  const prose = proseLines(lines, layout);
  const text = new Uint8Array(width * height);
  for (const l of lines) {
    const size = l.size || 10;
    const isProse = prose.has(l);
    const x0 = Math.max(0, Math.floor((l.x - 2) * SCALE));
    const x1 = Math.min(width, Math.ceil((l.xEnd + 2) * SCALE));
    const top = l.top !== undefined ? l.top + 1 : l.y + size * (isProse ? 1.1 : 1);
    const y0 = Math.max(0, Math.floor((pageHeight - top) * SCALE));
    const y1 = Math.min(height, Math.ceil((pageHeight - l.y + size * (isProse ? 0.5 : 0.35)) * SCALE));
    for (let y = y0; y < y1; y++) {
      for (let p = y * width + x0; p < y * width + x1; p++) text[p] = Math.max(text[p], isProse ? 2 : 1);
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
      data: screenImage(crop, screen),
      crop, // the picture itself, for cutting it into parts (sidewaysParts)
    });
  }
  return figures;
}

const MIN_MARK = 30; // pixels; smaller marks left once the words are taken out are specks, dots and commas
const CELL = 12; // pixels (6 points): marks this close together belong to one picture

// Pictures anywhere on a scanned page, beside the text as well as between
// paragraphs. The words OCR read clearly are taken out of the page's ink, and
// what is left, in groups of marks close to each other, is pictures. Words read
// inside a picture (a sign, a speech bubble) are part of it, so they go with
// it. `lines` are the page's OCR lines, with the boxes of their words.
async function findPictures(page, lines, layout, screen) {
  const canvas = await renderPage(page, SCALE);
  const { width, height } = canvas;
  const pageHeight = page.view[3] - page.view[1];
  const pixels = canvas.getContext('2d').getImageData(0, 0, width, height).data;

  // ink is what is clearly darker than the paper, so a grey or yellowed scan isn't all ink
  const lum = new Uint8Array(width * height);
  const levels = new Uint32Array(256);
  for (let i = 0, p = 0; p < lum.length; i += 4, p++) {
    lum[p] = 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2];
    levels[lum[p]]++;
  }
  let paper = 255;
  for (let v = 128; v < 256; v++) if (levels[v] > levels[paper]) paper = v;
  const below = Math.min(INK, paper - 35);
  const ink = new Uint8Array(width * height);
  for (let p = 0; p < ink.length; p++) ink[p] = lum[p] < below ? 1 : 0;

  // take out the words read clearly; a line with no word boxes goes whole
  const row = y => Math.round((pageHeight - y) * SCALE);
  const clear = (x0, x1, top, bottom) => {
    const c0 = Math.max(0, Math.floor(x0 * SCALE) - 2);
    const c1 = Math.min(width, Math.ceil(x1 * SCALE) + 2);
    for (let y = Math.max(0, row(top) - 2); y < Math.min(height, row(bottom) + 2); y++) ink.fill(0, y * width + c0, y * width + c1);
  };
  const isWord = (w, size) => {
    const letters = (w.text.match(/[\p{L}\d]/gu) || []).length;
    return w.confidence >= 60 && (letters >= 2 || (letters && w.confidence >= 85)) && w.top - w.bottom <= size * 2.5;
  };
  for (const l of lines) {
    if (!l.words) clear(l.x, l.xEnd, l.top ?? l.y + l.size, l.y - l.size * 0.35);
    else for (const w of l.words) if (isWord(w, l.size)) clear(w.x, w.xEnd, w.top, w.bottom);
  }

  // marks: ink that touches; tiny ones are specks
  const mark = new Int32Array(width * height).fill(-1);
  const sizes = [];
  const stack = new Int32Array(width * height);
  for (let start = 0; start < ink.length; start++) {
    if (!ink[start] || mark[start] >= 0) continue;
    const id = sizes.length;
    let n = 0, top = 0;
    stack[top++] = start;
    mark[start] = id;
    while (top) {
      const p = stack[--top];
      n++;
      const x = p % width;
      for (const q of [x > 0 ? p - 1 : -1, x < width - 1 ? p + 1 : -1, p - width, p + width]) {
        if (q >= 0 && q < ink.length && ink[q] && mark[q] < 0) {
          mark[q] = id;
          stack[top++] = q;
        }
      }
    }
    sizes.push(n);
  }
  const keep = p => mark[p] >= 0 && sizes[mark[p]] >= MIN_MARK;

  // marks close together make one group: cells of the page with marks in them, touching
  const gw = Math.ceil(width / CELL), gh = Math.ceil(height / CELL);
  const cellInk = new Uint32Array(gw * gh);
  for (let p = 0; p < ink.length; p++) if (keep(p)) cellInk[Math.floor(p / width / CELL) * gw + Math.floor((p % width) / CELL)]++;
  const seen = new Uint8Array(gw * gh);
  let boxes = [];
  for (let c = 0; c < cellInk.length; c++) {
    if (cellInk[c] < 3 || seen[c]) continue;
    const box = { x0: gw, x1: -1, y0: gh, y1: -1 };
    let top = 0;
    stack[top++] = c;
    seen[c] = 1;
    while (top) {
      const k = stack[--top];
      const cx = k % gw, cy = Math.floor(k / gw);
      box.x0 = Math.min(box.x0, cx); box.x1 = Math.max(box.x1, cx);
      box.y0 = Math.min(box.y0, cy); box.y1 = Math.max(box.y1, cy);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = cx + dx, ny = cy + dy, q = ny * gw + nx;
          if (nx >= 0 && nx < gw && ny >= 0 && ny < gh && cellInk[q] >= 3 && !seen[q]) {
            seen[q] = 1;
            stack[top++] = q;
          }
        }
      }
    }
    boxes.push({ left: box.x0 * CELL, right: Math.min(width, (box.x1 + 1) * CELL) - 1, top: box.y0 * CELL, bottom: Math.min(height, (box.y1 + 1) * CELL) - 1 });
  }

  // prose lines in a box mean it's text with something beside it, not one picture
  const prose = lines.filter(layout.isProse);
  const proseIn = b => prose.filter(l => {
    const x = ((l.x + l.xEnd) / 2) * SCALE, y = row(l.y + l.size / 2);
    return x > b.left && x < b.right && y > b.top && y < b.bottom;
  }).length;
  // groups a little apart are one picture (a drawing's house and its tree), unless text runs between them
  const near = 10 * SCALE;
  for (let merged = true; merged; ) {
    merged = false;
    for (let i = 0; i < boxes.length && !merged; i++) {
      for (let j = i + 1; j < boxes.length && !merged; j++) {
        const a = boxes[i], b = boxes[j];
        if (a.left - near > b.right || b.left - near > a.right || a.top - near > b.bottom || b.top - near > a.bottom) continue;
        const both = { left: Math.min(a.left, b.left), right: Math.max(a.right, b.right), top: Math.min(a.top, b.top), bottom: Math.max(a.bottom, b.bottom) };
        if (proseIn(both) > proseIn(a) + proseIn(b)) continue;
        boxes.splice(j, 1);
        boxes[i] = both;
        merged = true;
      }
    }
  }

  const figures = [];
  for (const b of boxes) {
    // the box tight around its marks, and how much of it is marks
    let top = -1, bottom = -1, left = width, right = -1, amount = 0, inner = 0;
    const edge = 8 * SCALE;
    for (let y = b.top; y <= b.bottom; y++) {
      for (let x = b.left, p = y * width + x; x <= b.right; x++, p++) {
        if (!keep(p)) continue;
        amount++;
        if (top < 0) top = y;
        bottom = y;
        left = Math.min(left, x);
        right = Math.max(right, x);
      }
    }
    // needs a real amount of picture (about 25 x 25 points) and to be more than a line
    if (amount < 600 * SCALE * SCALE || bottom - top < 30 * SCALE || right - left < 30 * SCALE) continue;
    // a dark strip along the edge of the page is the scanner's shadow
    const w = right - left, h = bottom - top;
    if ((left < 3 * SCALE || right > width - 3 * SCALE) && w < width * 0.15) continue;
    if ((top < 3 * SCALE || bottom > height - 3 * SCALE) && h < height * 0.15) continue;
    // a frame around text is a box of text, not a picture
    if (proseIn({ left, right, top, bottom }) >= 2) {
      for (let y = top + edge; y < bottom - edge; y++) {
        for (let x = left + edge, p = y * width + x; x < right - edge; x++, p++) if (keep(p)) inner++;
      }
      if (inner < 600 * SCALE * SCALE) continue;
    }

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
      data: screenImage(crop, screen),
      crop,
    });
  }
  return figures.sort((a, b) => b.top - a.top);
}

const MAX_BOXES = 20; // pictures drawn on one page

// Boxes drawn around pictures on a page by the user, checked: each { x, y, w, h }
// as shares of the page's width and height from its top left corner, inside the page.
function cleanBoxes(boxes) {
  if (!Array.isArray(boxes)) throw new Error('The picture boxes could not be read.');
  if (boxes.length > MAX_BOXES) throw new Error(`A page can have up to ${MAX_BOXES} pictures.`);
  return boxes.map(b => {
    const [x, y, w, h] = [b?.x, b?.y, b?.w, b?.h].map(Number);
    if (![x, y, w, h].every(Number.isFinite)) throw new Error('A picture box could not be read.');
    const left = Math.max(0, x), top = Math.max(0, y);
    const right = Math.min(1, x + w), bottom = Math.min(1, y + h);
    if (right - left < 0.02 || bottom - top < 0.02) throw new Error('A picture box is too small.');
    const round = v => Math.round(v * 10000) / 10000;
    return { x: round(left), y: round(top), w: round(right - left), h: round(bottom - top) };
  });
}

// The pictures in boxes drawn by the user (see cleanBoxes), cropped like found ones.
async function cropBoxes(page, boxes, screen) {
  const canvas = await renderPage(page, SCALE);
  const pageWidth = page.view[2] - page.view[0];
  const pageHeight = page.view[3] - page.view[1];
  return boxes
    .map(b => {
      const left = Math.round(b.x * canvas.width), top = Math.round(b.y * canvas.height);
      const crop = createCanvas(
        Math.max(1, Math.min(canvas.width, Math.round((b.x + b.w) * canvas.width)) - left),
        Math.max(1, Math.min(canvas.height, Math.round((b.y + b.h) * canvas.height)) - top)
      );
      crop.getContext('2d').drawImage(canvas, left, top, crop.width, crop.height, 0, 0, crop.width, crop.height);
      return {
        top: pageHeight * (1 - b.y),
        bottom: pageHeight * (1 - b.y - b.h),
        left: pageWidth * b.x,
        right: pageWidth * (b.x + b.w),
        data: screenImage(crop, screen),
        crop,
      };
    })
    .sort((a, b) => b.top - a.top);
}

// A picture turned by `degrees` (90, 180 or 270, clockwise), as the user turned it;
// 0 leaves it as it is.
function turned(canvas, degrees = 0) {
  const d = ((degrees % 360) + 360) % 360;
  if (!d) return canvas;
  const across = d === 90 || d === 270;
  const out = createCanvas(across ? canvas.height : canvas.width, across ? canvas.width : canvas.height);
  const ctx = out.getContext('2d');
  ctx.translate(out.width / 2, out.height / 2);
  ctx.rotate((d * Math.PI) / 180);
  ctx.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
  return out;
}

// A tall picture (a whole page kept as a picture) turned on its side and cut
// into parts, each a picture of its own that fills the e-reader's screen, so its
// text comes out bigger. As in an XTC book: 2 parts are halves, 3 parts are
// thirds that overlap a little, so no line is only ever seen cut in two.
// Read with the e-reader turned on its side; the top of the page is on the right.
function sidewaysParts(canvas, parts, screen) {
  const { width, height } = canvas;
  const partHeight = parts === 2 ? Math.ceil(height / 2) : Math.ceil(height * 0.37);
  const step = parts > 1 ? (height - partHeight) / (parts - 1) : 0;
  return Array.from({ length: parts }, (_, i) => {
    const top = Math.round(step * i);
    const h = Math.min(partHeight, height - top);
    const turned = createCanvas(h, width);
    const ctx = turned.getContext('2d');
    ctx.translate(h, 0);
    ctx.rotate(Math.PI / 2);
    ctx.drawImage(canvas, 0, top, width, h, 0, 0, width, h);
    return screenImage(turned, screen);
  });
}

// The pictures on one page (a pdf.js page), found as `find` says: in the boxes the
// user drew ('drawn', with `boxes`), anywhere beside the words OCR read ('words'),
// or in the gaps between paragraphs ('gaps', with `gaps`). `lines` are the page's.
// A picture filling most of its page also comes turned sideways in 2 and 3 parts
// (`split`, for buildEpub's pictureParts), so switching between them later needs
// no converting again. The page is cleaned up after.
// `turns`: the pictures the user turned, by their number on the page ({ 1: 90 }).
async function pagePictures(page, { find, lines, gaps, boxes, turns = {} }, layout, screen) {
  const figures =
    find === 'drawn'
      ? await cropBoxes(page, boxes, screen)
      : find === 'words'
        ? await findPictures(page, lines, layout, screen)
        : await detectFigures(page, lines, gaps, layout, screen);
  const pageWidth = page.view[2] - page.view[0];
  const pageHeight = page.view[3] - page.view[1];
  page.cleanup();
  return {
    pageWidth,
    pageHeight,
    figures: figures.map(({ crop, ...fig }, j) => {
      // turned as the user turned it (its place on the page stays where it was found)
      if (turns[j]) {
        crop = turned(crop, turns[j]);
        fig = { ...fig, data: screenImage(crop, screen) };
      }
      const high = fig.top - fig.bottom;
      const fullPage = high >= pageHeight * FULL_PAGE && crop.height > crop.width;
      return fullPage ? { ...fig, split: { 2: sidewaysParts(crop, 2, screen), 3: sidewaysParts(crop, 3, screen) } } : fig;
    }),
  };
}

async function renderCover(page, screen) {
  return screenImage(await renderPage(page, screen && screen.pictures ? 2.5 : 1.5), screen);
}

// A cover from a picture file (JPEG, PNG, WebP, GIF, ...) chosen by the user,
// drawn for the e-ink screen like the rest of the book's pictures.
async function imageCover(data, screen) {
  let image;
  try {
    image = await loadImage(data);
  } catch {
    throw new Error('That file is not a picture that can be read. Use a JPEG, PNG or WebP image.');
  }
  return screenImage(image, screen);
}

// A cover drawn for a book of web pages: its picture (the file's bytes, or null) at the
// top, then its title and below it `by` (the author or site), on the reader's screen
// (as big as its pictures can be, for a reader whose screen isn't known). The title is
// as big as fits; with no picture it's set lower, under a rule.
async function titleCover({ picture = null, title = '', by = '' }, screen) {
  const width = screen.pictures ? screen.pictures.width : screen.width;
  const height = screen.pictures ? screen.pictures.height : screen.height;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  const margin = Math.round(width * 0.08);
  const inner = width - 2 * margin;
  let image = null;
  if (picture) {
    try {
      image = await loadImage(picture);
    } catch {} // not a picture that can be read: the title alone
  }
  let top = Math.round(height * 0.3);
  if (image) {
    // the picture across the top, up to 55% of the screen's height
    const scale = Math.min(width / image.width, (height * 0.55) / image.height);
    const w = Math.round(image.width * scale), h = Math.round(image.height * scale);
    ctx.drawImage(image, Math.round((width - w) / 2), 0, w, h);
    top = h + Math.round(height * 0.05);
  } else {
    ctx.fillStyle = '#000000';
    ctx.fillRect(margin, top - Math.round(height * 0.04), Math.round(inner * 0.25), Math.max(2, Math.round(height * 0.005)));
  }
  // the title: the biggest size at which it fits in up to 5 lines above the byline
  const room = height - top - margin - (by ? Math.round(width * 0.09) : 0);
  const lines = (text, size) => {
    ctx.font = `bold ${size}px Georgia, "Times New Roman", serif`;
    const out = [];
    let line = '';
    for (const word of text.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (line && ctx.measureText(next).width > inner) {
        out.push(line);
        line = word;
      } else line = next;
    }
    if (line) out.push(line);
    return out;
  };
  let size = Math.round(width * 0.11);
  let set = lines(title, size);
  while (size > Math.round(width * 0.045) && (set.length > 5 || set.length * size * 1.2 > room || set.some(l => ctx.measureText(l).width > inner))) {
    size -= 2;
    set = lines(title, size);
  }
  if (set.length > 5) set = [...set.slice(0, 4), set.slice(4).join(' ')];
  ctx.font = `bold ${size}px Georgia, "Times New Roman", serif`;
  ctx.fillStyle = '#000000';
  ctx.textBaseline = 'top';
  set.forEach((l, i) => {
    let text = l;
    while (ctx.measureText(text).width > inner && text.length > 1) text = text.slice(0, -2) + '…';
    ctx.fillText(text, margin, top + i * size * 1.2);
  });
  if (by) {
    let small = Math.round(width * 0.045);
    ctx.font = `${small}px Georgia, "Times New Roman", serif`;
    let text = by;
    while (ctx.measureText(text).width > inner && text.length > 1) text = text.slice(0, -2) + '…';
    ctx.fillStyle = '#444444';
    ctx.fillText(text, margin, top + set.length * size * 1.2 + Math.round(small * 0.8));
  }
  return screenImage(canvas, screen);
}

module.exports = {
  measureLayout, layoutFrom, layoutMeasures, findGaps, detectFigures, findPictures, pagePictures, cleanBoxes, cropBoxes,
  sidewaysParts, renderCover, imageCover, titleCover, renderPage, turned,
};
