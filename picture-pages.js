// Find the pictures on many pages of a PDF at once, in worker threads. Drawing a
// page and looking through its ink is slow and takes the whole thread, so pages
// side by side only go faster on threads of their own: each worker opens the PDF
// itself and takes the next page as soon as it's done with one. The pages come
// back as they would one by one (figures.js pagePictures), so the book is the same.
// This file is also the worker. The website runs pages one by one (web/picture-pages.js).

const os = require('os');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const { openPdf } = require('./pdf');
const { layoutFrom, layoutMeasures, pagePictures } = require('./figures');

const MIN_PAGES = 30; // fewer pages than this go one by one: starting the workers takes longer than it saves
const PAGES_PER_WORKER = 10; // ...and a worker only for every so many pages
const MAX_WORKERS = 4;
const BIG_PDF = 150 * 1024 * 1024; // each worker holds a copy of the PDF, so a big one gets fewer
const MAX_BIG_PDF_WORKERS = 2;

// How many workers for `pages` pages of a PDF of `bytes` bytes; 0 means one by one.
// CONVERTPDF_WORKERS sets the most there can be (0: always one by one).
function workerCount(pages, bytes) {
  const most = Number.isInteger(Number(process.env.CONVERTPDF_WORKERS)) && process.env.CONVERTPDF_WORKERS !== ''
    ? Math.max(0, Number(process.env.CONVERTPDF_WORKERS))
    : Math.min(MAX_WORKERS, os.availableParallelism() - 1, bytes > BIG_PDF ? MAX_BIG_PDF_WORKERS : MAX_WORKERS);
  if (pages < MIN_PAGES) return 0;
  const count = Math.min(most, Math.ceil(pages / PAGES_PER_WORKER));
  return count >= 2 ? count : 0;
}

// The pictures of the pages in `tasks` ([{ n, find, lines, gaps?, boxes? }], see
// pagePictures), as a Map of page number to { pageWidth, pageHeight, figures }.
// `pdf` is the PDF's bytes and `doc` it opened here. `onPage()` is called as each
// page is done, in whatever order they finish.
async function findPagePictures(pdf, doc, tasks, layout, screen, onPage = () => {}) {
  const results = new Map();
  const here = async task => {
    results.set(task.n, await pagePictures(await doc.getPage(task.n), task, layout, screen));
    onPage();
  };
  const count = workerCount(tasks.length, pdf.length);
  if (!count) {
    for (const task of tasks) await here(task);
    return results;
  }

  const queue = [...tasks];
  const redo = []; // pages a worker couldn't do, done here after
  const run = () =>
    new Promise(resolve => {
      const worker = new Worker(__filename, {
        workerData: { role: 'pictures', pdf, layout: layoutMeasures(layout), screen },
      });
      let task = null;
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        worker.terminate();
        resolve();
      };
      const next = () => {
        task = queue.shift();
        if (!task) return finish();
        try {
          worker.postMessage(task);
        } catch {
          redo.push(task); // a page that can't be sent to a worker is done here
          next();
        }
      };
      worker.on('message', ({ result, error }) => {
        if (error) {
          console.error(`Pictures on page ${task.n}: ${error} (trying it again one by one)`);
          redo.push(task);
        } else {
          results.set(task.n, withBuffers(result));
          onPage();
        }
        next();
      });
      // a worker that fails (out of memory, can't start) leaves its page to be done here
      worker.on('error', err => {
        console.error(`A picture worker stopped: ${err.message || err}`);
        if (task) redo.push(task);
        task = null;
        finish();
      });
      worker.on('exit', () => {
        if (task && !finished) redo.push(task);
        task = null;
        finish();
      });
      worker.once('online', next);
    });
  await Promise.all(Array.from({ length: count }, run));
  // pages no worker got to (they all stopped) and the ones that failed in one
  for (const task of [...redo, ...queue.splice(0)]) await here(task);
  return results;
}

// Pictures come back from a worker as Uint8Arrays: the book wants Buffers.
const toBuffer = data => Buffer.from(data.buffer, data.byteOffset, data.byteLength);
function withBuffers(result) {
  return {
    ...result,
    figures: result.figures.map(fig => ({
      ...fig,
      data: toBuffer(fig.data),
      ...(fig.split && { split: Object.fromEntries(Object.entries(fig.split).map(([k, parts]) => [k, parts.map(toBuffer)])) }),
    })),
  };
}

// The worker: open the PDF, then find the pictures of each page it's sent.
if (!isMainThread && workerData?.role === 'pictures') {
  const { pdf, screen } = workerData;
  const layout = layoutFrom(workerData.layout);
  const opened = openPdf(pdf);
  parentPort.on('message', async task => {
    try {
      const doc = await opened;
      parentPort.postMessage({ result: await pagePictures(await doc.getPage(task.n), task, layout, screen) });
    } catch (err) {
      parentPort.postMessage({ error: err.message || String(err) });
    }
  });
}

module.exports = { findPagePictures, workerCount };
