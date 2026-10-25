// linkedom's parseHTML, as web.js uses it, made from the browser's own parser: the
// document it makes is inert (no scripts run, no pictures load).

function parseHTML(html) {
  return { document: new DOMParser().parseFromString(html, 'text/html') };
}

module.exports = { parseHTML };
