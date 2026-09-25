// Local web UI: upload a PDF, preview the EPUB, pick a font, download.
// Usage: node server.js  then open http://localhost:3000

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { analyzePdf, buildEpub } = require('./index');
const { FONTS, findFont, fontFaces, fontFaceCss } = require('./fonts');

const PORT = process.env.PORT || 3000;
const MAX_BYTES = 300 * 1024 * 1024;
const MAX_BOOKS = 5; // converted books kept in memory so fonts can be switched quickly

const page = path.join(__dirname, 'public', 'index.html');
const vendor = {
  'epub.min.js': require.resolve('epubjs/dist/epub.min.js'),
  'jszip.min.js': require.resolve('jszip/dist/jszip.min.js'),
};
const fontFiles = new Map(FONTS.flatMap(f => fontFaces(f).map(face => [face.file, face.path])));

const books = new Map();

function remember(book) {
  const id = crypto.randomUUID();
  books.set(id, book);
  while (books.size > MAX_BOOKS) books.delete(books.keys().next().value);
  return id;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BYTES) {
        reject(new Error('File is too large (max 300 MB).'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function header(req, name) {
  const value = req.headers[name];
  return value ? decodeURIComponent(value) : undefined;
}

function sendError(res, status, message) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(message);
}

function sendFile(res, file, type, cache = 'max-age=86400') {
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': cache });
  fs.createReadStream(file).pipe(res);
}

// POST /convert: read the PDF (the slow part) and keep the result. The response
// is a stream of JSON lines: progress updates, then {result} or {error}.
async function handleConvert(req, res) {
  let pdf;
  try {
    pdf = await readBody(req);
    if (pdf.subarray(0, 5).toString() !== '%PDF-') throw new Error('That file is not a PDF.');
  } catch (err) {
    return sendError(res, 400, err.message);
  }

  res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-cache' });
  const send = obj => res.write(JSON.stringify(obj) + '\n');
  let lastSent = 0;
  let lastStage = null;
  const onProgress = ({ stage, done, total }) => {
    // at most a few updates a second, but always the first and last of each stage
    const now = Date.now();
    if (stage === lastStage && done !== total && now - lastSent < 200) return;
    lastSent = now;
    lastStage = stage;
    send({ progress: { stage, done, total } });
  };

  try {
    const fileName = header(req, 'x-filename') || 'book.pdf';
    const name = path.basename(fileName, path.extname(fileName));
    const started = Date.now();
    const book = await analyzePdf(pdf, {
      title: header(req, 'x-title'),
      author: header(req, 'x-author'),
      name,
      onProgress,
    });
    book.fileName = name + '.epub';
    const id = remember(book);
    console.log(
      `Converted ${fileName}: ${book.stats.pages} pages, ${book.chapters.length} chapters, ` +
        `${book.stats.images} images in ${Math.round((Date.now() - started) / 1000)} s`
    );

    send({
      result: {
        id,
        title: book.title,
        author: book.author,
        fileName: book.fileName,
        chapters: book.chapters.length,
        ...book.stats,
      },
    });
  } catch (err) {
    console.error(err);
    send({ error: err.message || 'Conversion failed.' });
  }
  res.end();
}

// GET /book/<id>.epub?font=<id>[&download=1]: package the book with a font.
async function handleBook(req, res, id, query) {
  const book = books.get(id);
  if (!book) return sendError(res, 404, 'This book has expired. Please convert the PDF again.');
  const font = findFont(query.get('font'));
  const epub = await buildEpub(book, { font: font.id });
  const headers = { 'Content-Type': 'application/epub+zip', 'Content-Length': epub.length };
  if (query.get('download')) {
    headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(book.fileName)}`;
  }
  res.writeHead(200, headers);
  res.end(epub);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const route = url.pathname;
  let match;

  if (req.method === 'GET' && (route === '/' || route === '/index.html')) {
    sendFile(res, page, 'text/html; charset=utf-8', 'no-cache');
  } else if (req.method === 'POST' && route === '/convert') {
    handleConvert(req, res);
  } else if (req.method === 'GET' && (match = route.match(/^\/book\/([\w-]+)\.epub$/))) {
    handleBook(req, res, match[1], url.searchParams).catch(err => {
      console.error(err);
      sendError(res, 500, 'Could not build the EPUB.');
    });
  } else if (req.method === 'GET' && route === '/fonts.json') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(FONTS.map(f => ({ id: f.id, name: f.name, fallback: f.fallback, embedded: !!f.pkg }))));
  } else if (req.method === 'GET' && route === '/fonts.css') {
    // lets the upload page show each font option in its own typeface
    res.writeHead(200, { 'Content-Type': 'text/css' });
    res.end(FONTS.map(f => fontFaceCss(f, '/fontfiles/')).join('\n'));
  } else if (req.method === 'GET' && (match = route.match(/^\/fontfiles\/([\w.-]+)$/)) && fontFiles.has(match[1])) {
    sendFile(res, fontFiles.get(match[1]), 'font/woff');
  } else if (req.method === 'GET' && (match = route.match(/^\/vendor\/([\w.-]+)$/)) && vendor[match[1]]) {
    sendFile(res, vendor[match[1]], 'text/javascript');
  } else {
    sendError(res, 404, 'Not found');
  }
});

// scanned books with pictures can take a few minutes to convert
server.requestTimeout = 0;

server.listen(PORT, '127.0.0.1', () => {
  console.log(`PDF to EPUB converter running at http://localhost:${PORT}`);
});
