// The XTC e-book format of Xteink readers (X3, X4, X4 Pro): pages stored as
// ready-made pictures of the screen. XTC holds black and white pages (XTG),
// XTCH pages in 4 shades of gray (XTH). Layout as read by the CrossPoint Reader
// firmware (lib/Xtc/Xtc/XtcTypes.h) and written by XTC.js (MIT License).
//
// File: 56-byte header, title (128 bytes), author (112), chapter list header (16),
// chapters (96 bytes each), page table (16 bytes per page), then the pages.
// All numbers are little-endian; page numbers in chapters count from 1.

const crypto = require('crypto');

const HEADER_SIZE = 56;
const TITLE_SIZE = 128;
const AUTHOR_SIZE = 112;
const AUTHOR_READ = 64; // CrossPoint reads at most this much of the author
const TOC_HEADER_SIZE = 16;
const CHAPTER_SIZE = 96;
const CHAPTER_NAME_SIZE = 80;
const PAGE_ENTRY_SIZE = 16;
const PAGE_HEADER_SIZE = 22;
const MAX_PAGES = 0xffff;

// Gray (0 black … 255 white) to an XTH pixel value: 0 white, 1 dark gray, 2 light gray, 3 black
function grayLevel(v) {
  if (v >= 212) return 0;
  if (v >= 127) return 2;
  if (v >= 42) return 1;
  return 3;
}
const LEVEL_GRAY = [255, 85, 170, 0];

function pageBuffer(magic, width, height, pixels) {
  const page = Buffer.alloc(PAGE_HEADER_SIZE + pixels.length);
  page.write(magic, 0, 'latin1'); // the 4th byte stays 0
  page.writeUInt16LE(width, 4);
  page.writeUInt16LE(height, 6);
  // byte 8: color mode 0, byte 9: no compression
  page.writeUInt32LE(pixels.length, 10);
  crypto.createHash('md5').update(pixels).digest().copy(page, 14, 0, 8);
  pixels.copy(page, PAGE_HEADER_SIZE);
  return page;
}

// Black and white page: rows top to bottom, 8 pixels a byte, leftmost pixel in
// the highest bit, 1 = white. `gray` holds one byte per pixel, 0 or 255.
function encodeXtg(gray, width, height) {
  const rowBytes = Math.ceil(width / 8);
  const pixels = Buffer.alloc(rowBytes * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (gray[y * width + x] >= 128) pixels[y * rowBytes + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return pageBuffer('XTG', width, height, pixels);
}

// 4-gray page: two bit planes (high bits, then low bits), each stored in columns
// from the right edge to the left, 8 pixels down a byte, top pixel in the highest bit.
function encodeXth(gray, width, height) {
  const colBytes = Math.ceil(height / 8);
  const planeSize = colBytes * width;
  const pixels = Buffer.alloc(planeSize * 2);
  for (let x = 0; x < width; x++) {
    const column = (width - 1 - x) * colBytes;
    for (let y = 0; y < height; y++) {
      const level = grayLevel(gray[y * width + x]);
      const at = column + (y >> 3);
      const bit = 0x80 >> (y & 7);
      if (level & 2) pixels[at] |= bit;
      if (level & 1) pixels[planeSize + at] |= bit;
    }
  }
  return pageBuffer('XTH', width, height, pixels);
}

// A page back to one gray byte per pixel, for previews.
function decodePage(page) {
  const magic = page.toString('latin1', 0, 3);
  const width = page.readUInt16LE(4);
  const height = page.readUInt16LE(6);
  const pixels = page.subarray(PAGE_HEADER_SIZE);
  const gray = new Uint8Array(width * height);
  if (magic === 'XTG') {
    const rowBytes = Math.ceil(width / 8);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        gray[y * width + x] = pixels[y * rowBytes + (x >> 3)] & (0x80 >> (x & 7)) ? 255 : 0;
      }
    }
  } else if (magic === 'XTH') {
    const colBytes = Math.ceil(height / 8);
    const planeSize = colBytes * width;
    for (let x = 0; x < width; x++) {
      const column = (width - 1 - x) * colBytes;
      for (let y = 0; y < height; y++) {
        const at = column + (y >> 3);
        const bit = 0x80 >> (y & 7);
        const level = (pixels[at] & bit ? 2 : 0) | (pixels[planeSize + at] & bit ? 1 : 0);
        gray[y * width + x] = LEVEL_GRAY[level];
      }
    }
  } else {
    throw new Error('Not an XTC page.');
  }
  return { width, height, gray };
}

// UTF-8 text cut to fit `size` bytes with a closing zero, never inside a character.
function writeText(buffer, offset, text, size) {
  let bytes = Buffer.from(text || '', 'utf8');
  if (bytes.length > size - 1) {
    let end = size - 1;
    while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--; // back to the start of a character
    bytes = bytes.subarray(0, end);
  }
  bytes.copy(buffer, offset);
}

// Pack encoded pages into an XTC (black and white) or XTCH (4 grays) file.
// `chapters`: [{ title, start, end }], page numbers counting from 1.
function buildXtcFile(pages, { title = '', author = '', chapters = [] } = {}) {
  if (!pages.length) throw new Error('The book has no pages.');
  if (pages.length > MAX_PAGES) throw new Error(`Too many pages for an XTC file (max ${MAX_PAGES}).`);
  const grays = pages[0].toString('latin1', 0, 3) === 'XTH';

  const titleAt = HEADER_SIZE;
  const authorAt = titleAt + TITLE_SIZE;
  const tocAt = authorAt + AUTHOR_SIZE;
  const chaptersAt = tocAt + TOC_HEADER_SIZE;
  const tableAt = chaptersAt + chapters.length * CHAPTER_SIZE;
  const dataAt = tableAt + pages.length * PAGE_ENTRY_SIZE;
  const size = dataAt + pages.reduce((n, p) => n + p.length, 0);
  const file = Buffer.alloc(size);

  file.write(grays ? 'XTCH' : 'XTC\0', 0, 'latin1');
  file[4] = 1; // version 1.0
  file.writeUInt16LE(pages.length, 6);
  file[8] = 0; // read left to right
  file[9] = 1; // has title and author
  file[10] = 0; // no thumbnails
  file[11] = chapters.length ? 1 : 0;
  file.writeUInt32LE(1, 12); // open at page 1
  file.writeBigUInt64LE(BigInt(titleAt), 16);
  file.writeBigUInt64LE(BigInt(tableAt), 24);
  file.writeBigUInt64LE(BigInt(dataAt), 32);
  file.writeBigUInt64LE(0n, 40); // thumbnails
  file.writeUInt32LE(chapters.length ? chaptersAt : 0, 48);

  writeText(file, titleAt, title, TITLE_SIZE);
  writeText(file, authorAt, author, AUTHOR_READ);
  file.writeUInt32LE(Math.floor(Date.now() / 1000), tocAt);
  file.writeUInt16LE(chapters.length, tocAt + 6);
  chapters.forEach((ch, i) => {
    const at = chaptersAt + i * CHAPTER_SIZE;
    writeText(file, at, ch.title, CHAPTER_NAME_SIZE);
    file.writeUInt16LE(ch.start, at + CHAPTER_NAME_SIZE);
    file.writeUInt16LE(ch.end, at + CHAPTER_NAME_SIZE + 2);
  });

  let at = dataAt;
  pages.forEach((page, i) => {
    const entry = tableAt + i * PAGE_ENTRY_SIZE;
    file.writeBigUInt64LE(BigInt(at), entry);
    file.writeUInt32LE(page.length, entry + 8);
    page.copy(file, entry + 12, 4, 8); // width and height, as in the page's own header
    page.copy(file, at);
    at += page.length;
  });
  return file;
}

module.exports = { encodeXtg, encodeXth, decodePage, buildXtcFile };
