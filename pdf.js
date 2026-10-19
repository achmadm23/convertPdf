// Open PDF bytes as a pdf.js document.

const path = require('path');

async function openPdf(buffer) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  // decoders for scanned images (JBIG2, JPEG 2000) and fonts, needed to render pages
  const pdfjsRoot = path.dirname(require.resolve('pdfjs-dist/package.json'));
  return pdfjs.getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: true,
    verbosity: 0,
    wasmUrl: path.join(pdfjsRoot, 'wasm') + '/',
    standardFontDataUrl: path.join(pdfjsRoot, 'standard_fonts') + '/',
    cMapUrl: path.join(pdfjsRoot, 'cmaps') + '/',
  }).promise;
}

module.exports = { openPdf };
