// picture-pages.js for the website: the pages are searched for pictures one by
// one, in the page itself (it has no worker threads of Node's).

const { pagePictures } = require('../figures');

async function findPagePictures(pdf, doc, tasks, layout, screen, onPage = () => {}) {
  const results = new Map();
  for (const task of tasks) {
    results.set(task.n, await pagePictures(await doc.getPage(task.n), task, layout, screen));
    onPage();
  }
  return results;
}

module.exports = { findPagePictures };
