// Where OCR finds its language data and how many pages it reads at once, in the
// browser (the website). ocr-platform.js is the version for Node.

const asset = file => new URL(file, document.baseURI).href;

// tesseract.js worker settings for a language: everything is served with the page,
// and the language data is kept in the browser's storage after the first time
function workerOptions() {
  return {
    langPath: asset('ocr/'),
    workerPath: asset('vendor/tesseract/worker.min.js'),
    corePath: asset('vendor/tesseract/'),
    cacheMethod: 'write',
  };
}

const cpuCount = () => navigator.hardwareConcurrency || 4;

// each worker uses up to ~150 MB, and a browser tab has less room than the app
const MAX_WORKERS = 4;

module.exports = { workerOptions, cpuCount, MAX_WORKERS };
