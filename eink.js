// Make pictures look like pages of an XTC book (the Xteink e-reader format):
// scaled to fit its 480 x 800 screen and drawn in the screen's 4 shades of gray,
// dithered so photos and shading keep their tones.

const zlib = require('zlib');
const { createCanvas } = require('@napi-rs/canvas');

// the Xteink X4 and X4 Pro; other readers' screens are passed in (DEVICES in xtc.js)
const SCREEN = { width: 480, height: 800 };
const STEP = 255 / 3; // 4 shades: black, dark gray, light gray, white

// Lightest and darkest tones to stretch to white and black, so the gray paper of a
// scan prints as white instead of a pattern of dots.
function toneRange(gray) {
  const counts = new Uint32Array(256);
  for (const v of gray) counts[Math.round(v)]++;
  const at = share => {
    let seen = 0;
    for (let v = 0; v < 256; v++) if ((seen += counts[v]) >= gray.length * share) return v;
    return 255;
  };
  // a line drawing has almost no dark pixels, so its darkest 5% may still be paper
  const black = Math.min(at(0.05), 80);
  // paper is the commonest light tone, filling much of the picture in a narrow band;
  // a photo has no such band, so only its lightest specks become white. Even a
  // yellowed scan's paper is lighter than 160, so a flat mid-gray (a field in a
  // drawing) isn't taken for paper.
  let paper = 160;
  for (let v = 160; v < 256; v++) if (counts[v] > counts[paper]) paper = v;
  let band = 0;
  for (let v = Math.max(0, paper - 6); v <= Math.min(255, paper + 6); v++) band += counts[v];
  const white = band >= gray.length * 0.2 ? paper - 10 : at(0.99);
  return { black, white: Math.max(white, black + 64) };
}

// Floyd-Steinberg dithering to the 4 shades, scanning rows in alternate directions.
function dither(gray, width, height) {
  const out = new Uint8Array(gray.length);
  for (let y = 0; y < height; y++) {
    const ltr = y % 2 === 0;
    for (let i = 0; i < width; i++) {
      const x = ltr ? i : width - 1 - i;
      const dx = ltr ? 1 : -1;
      const p = y * width + x;
      const v = Math.min(255, Math.max(0, gray[p]));
      const shade = Math.round(v / STEP);
      out[p] = Math.round(shade * STEP);
      const err = v - out[p];
      const spread = (xx, yy, w) => {
        if (xx >= 0 && xx < width && yy < height) gray[yy * width + xx] += err * w;
      };
      spread(x + dx, y, 7 / 16);
      spread(x - dx, y + 1, 3 / 16);
      spread(x, y + 1, 5 / 16);
      spread(x + dx, y + 1, 1 / 16);
    }
  }
  return out;
}

// 8-bit grayscale PNG, which every e-reader can show; with `channels` 3, a color one.
// `up`: each row stored as its change from the row above, which packs smooth pictures
// (photos, not dithered dots) much smaller.
function encodePng(pixels, width, height, { channels = 1, up = false } = {}) {
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(data, zlib.crc32(type)), 0);
    return Buffer.concat([head, data, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bits per pixel
  header[9] = channels === 3 ? 2 : 0; // color or grayscale
  const line = width * channels;
  const rows = Buffer.alloc((line + 1) * height);
  for (let y = 0; y < height; y++) {
    const at = y * (line + 1);
    const row = pixels.subarray(y * line, (y + 1) * line);
    if (!up || y === 0) rows.set(row, at + 1); // no filter
    else {
      rows[at] = 2; // Up
      const above = pixels.subarray((y - 1) * line, y * line);
      for (let x = 0; x < line; x++) rows[at + 1 + x] = (row[x] - above[x]) & 255;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// A canvas (or image) as a PNG that fills the reader's screen. A screen with
// `pictures` (any reader: a Kindle, a Kobo or a phone) gets a full picture instead.
function screenImage(source, screen = SCREEN) {
  if (screen.pictures) return fullImage(source, screen.pictures);
  const scale = Math.min(screen.width / source.width, screen.height / source.height);
  const width = Math.max(1, Math.round(source.width * scale));
  const height = Math.max(1, Math.round(source.height * scale));
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(source, 0, 0, width, height);

  const rgba = ctx.getImageData(0, 0, width, height).data;
  const gray = new Float32Array(width * height);
  for (let i = 0, p = 0; p < gray.length; i += 4, p++) {
    gray[p] = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
  }
  const { black, white } = toneRange(gray);
  for (let p = 0; p < gray.length; p++) {
    gray[p] = Math.min(255, Math.max(0, ((gray[p] - black) * 255) / (white - black)));
  }
  return encodePng(dither(gray, width, height), width, height);
}

// A picture for a reader whose screen isn't known: as large as it is, up to `box`,
// for each reader to shrink to its own screen; in color if it has any, else in
// smooth grays with the paper made white, never dithered.
function fullImage(source, box) {
  const scale = Math.min(1, box.width / source.width, box.height / source.height);
  const width = Math.max(1, Math.round(source.width * scale));
  const height = Math.max(1, Math.round(source.height * scale));
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(source, 0, 0, width, height);

  const rgba = ctx.getImageData(0, 0, width, height).data;
  const count = width * height;
  // colored: enough pixels far from gray (a yellowed scan's paper isn't)
  let colored = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
    if (Math.max(r, g, b) - Math.min(r, g, b) > 48) colored++;
  }
  if (colored > count * 0.01) {
    const rgb = new Uint8Array(count * 3);
    for (let i = 0, p = 0; i < rgba.length; i += 4, p += 3) {
      rgb[p] = rgba[i];
      rgb[p + 1] = rgba[i + 1];
      rgb[p + 2] = rgba[i + 2];
    }
    return encodePng(rgb, width, height, { channels: 3, up: true });
  }
  const gray = new Float32Array(count);
  for (let i = 0, p = 0; p < count; i += 4, p++) {
    gray[p] = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
  }
  const { black, white } = toneRange(gray);
  const pixels = new Uint8Array(count);
  for (let p = 0; p < count; p++) pixels[p] = Math.min(255, Math.max(0, Math.round(((gray[p] - black) * 255) / (white - black))));
  return encodePng(pixels, width, height, { up: true });
}

module.exports = { screenImage, encodePng };
