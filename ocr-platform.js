// Where OCR finds its language data and how many pages it reads at once, for
// Node (the app and the command line). web/ocr-platform.js is the website's version.

const os = require('os');
const path = require('path');

// tesseract.js worker settings for a language
function workerOptions(code) {
  return {
    langPath: path.join(path.dirname(require.resolve(`@tesseract.js-data/${code}/package.json`)), '4.0.0_best_int'),
    cacheMethod: 'none', // read the bundled data, never write a copy into the working folder
  };
}

const cpuCount = () => (os.availableParallelism ? os.availableParallelism() : os.cpus().length);

// each worker reads one page at a time on its own CPU core, using up to ~150 MB
const MAX_WORKERS = 8;

module.exports = { workerOptions, cpuCount, MAX_WORKERS };
