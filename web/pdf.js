// Open PDF bytes as a pdf.js document, in the browser (the website's version of pdf.js).
// pdf.js's worker and data files are copied next to the page by web/build.js.

import * as pdfjs from 'pdfjs-dist/build/pdf.mjs';

const asset = file => new URL(`vendor/pdfjs/${file}`, document.baseURI).href;

pdfjs.GlobalWorkerOptions.workerSrc = asset('pdf.worker.min.mjs');

export async function openPdf(buffer) {
  return pdfjs.getDocument({
    data: new Uint8Array(buffer),
    verbosity: 0,
    wasmUrl: asset('wasm/'),
    standardFontDataUrl: asset('standard_fonts/'),
    cMapUrl: asset('cmaps/'),
  }).promise;
}
