// Make pictures look like pages of an XTC book (the Xteink e-reader format):
// scaled to fit its 480 x 800 screen and drawn in the screen's 4 shades of gray,
// dithered so photos and shading keep their tones.

const zlib = require('zlib');
const { createCanvas } = require('@napi-rs/canvas');

const WIDTH = 480;
const HEIGHT = 800;
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
  // a photo has no such band, so only its lightest specks become white
  let paper = 128;
  for (let v = 128; v < 256; v++) if (counts[v] > counts[paper]) paper = v;
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

// 8-bit grayscale PNG, which every e-reader can show
function encodePng(pixels, width, height) {
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
  header[9] = 0; // grayscale
  const rows = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++) {
    rows[y * (width + 1)] = 0; // no filter
    rows.set(pixels.subarray(y * width, (y + 1) * width), y * (width + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// A canvas (or image) as a PNG that fills an XTC screen.
function screenImage(source) {
  const scale = Math.min(WIDTH / source.width, HEIGHT / source.height);
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

module.exports = { screenImage, encodePng };
