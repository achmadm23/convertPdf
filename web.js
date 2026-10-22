// Web pages (news articles) into a book: each link is downloaded, its article
// found the way Firefox's Reader View does it (Mozilla Readability), and turned
// into a chapter of paragraphs, headings and pictures, ready for buildEpub.
// Only the app uses this: a website can't read other sites' pages.

const { parseHTML } = require('linkedom');
const { Readability } = require('@mozilla/readability');
const { loadImage, createCanvas } = require('@napi-rs/canvas');
const { screenImage } = require('./eink');
const { imageCover } = require('./figures');
const { readerScreen } = require('./index');

const MAX_LINKS = 50;
const MAX_PAGE_BYTES = 10 * 1024 * 1024;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_PICTURES = 30; // per article
const MIN_PICTURE = 120; // pixels: smaller ones are icons, logos and tracking pixels
const TIMEOUT = 30 * 1000;
const DOWNLOADS = 4; // pictures downloaded at once
// some news sites turn away requests that don't look like they come from a browser
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36',
  'Accept-Language': 'id,en;q=0.8',
};

// The links in a piece of text: one per line, or separated by commas or spaces.
// A comma only separates links when another one starts after it (http://, www. or
// a site's name and a slash), since a link can have commas of its own.
function splitLinks(text) {
  const words = String(text).split(/\s+/).flatMap(word => word.split(/,(?=https?:\/\/|www\.|[\w-]+(?:\.[\w-]+)+\/)/i));
  return [...new Set(words.map(word => word.replace(/^,+|,+$/g, '')).filter(Boolean))];
}

function parseLinks(text) {
  const links = splitLinks(text);
  if (!links.length) throw new Error('Paste the link of a web page.');
  if (links.length > MAX_LINKS) throw new Error(`Up to ${MAX_LINKS} links at once.`);
  return links.map(link => {
    let url;
    try {
      url = new URL(/^[a-z][\w+.-]*:/i.test(link) ? link : `https://${link}`);
    } catch {
      throw new Error(`"${link}" is not a link.`);
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`"${link}" is not a web page link.`);
    return url.href;
  });
}

async function download(url, maxBytes, accept) {
  let res;
  try {
    res = await fetch(url, { headers: { ...HEADERS, Accept: accept }, redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT) });
  } catch (err) {
    throw new Error(err.name === 'TimeoutError' ? 'the site took too long to answer' : 'the site could not be reached');
  }
  if (!res.ok) throw new Error(res.status === 403 || res.status === 401 ? 'the site refused to send it' : `the site answered ${res.status}`);
  if (Number(res.headers.get('content-length')) > maxBytes) throw new Error('it is too large');
  const data = Buffer.from(await res.arrayBuffer());
  if (data.length > maxBytes) throw new Error('it is too large');
  return { data, type: res.headers.get('content-type') || '', url: res.url || url };
}

function decodeHtml({ data, type }) {
  const charset = /charset=["']?([\w-]+)/i.exec(type)?.[1];
  try {
    return new TextDecoder(charset || 'utf-8').decode(data);
  } catch {
    return new TextDecoder('utf-8').decode(data);
  }
}

// The best file of a picture for the reader's screen: in a srcset, the smallest
// one at least as wide as the screen is tall (so a turned picture still fills it).
function pictureSource(img, base, screen) {
  const candidates = [img, ...(img.parentNode?.nodeName === 'PICTURE' ? img.parentNode.querySelectorAll('source') : [])]
    .flatMap(el => [el.getAttribute('srcset'), el.getAttribute('data-srcset')])
    .filter(Boolean)
    .flatMap(set => set.split(/,\s+/))
    .map(c => {
      const [src, size = ''] = c.trim().split(/\s+/);
      return { src, width: parseInt(size, 10) || 0 };
    })
    .filter(c => c.src && !c.src.startsWith('data:'));
  let src;
  if (candidates.length) {
    candidates.sort((a, b) => a.width - b.width);
    src = (candidates.find(c => c.width >= screen.height) || candidates[candidates.length - 1]).src;
  } else {
    // lazy-loaded pictures keep the real file in data-src, and a placeholder in src
    src = [img.getAttribute('data-src'), img.getAttribute('src')].find(s => s && !s.startsWith('data:'));
  }
  if (!src) return null;
  try {
    return new URL(src, base).href;
  } catch {
    return null;
  }
}

const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'BUTTON', 'FORM', 'INPUT', 'SELECT', 'TEXTAREA', 'IFRAME', 'VIDEO', 'AUDIO', 'NAV']);
const INLINE = new Set(['A', 'ABBR', 'B', 'BDI', 'BDO', 'CITE', 'CODE', 'DATA', 'DFN', 'EM', 'I', 'KBD', 'MARK', 'Q', 'S', 'SAMP', 'SMALL', 'SPAN', 'STRONG', 'SUB', 'SUP', 'TIME', 'U', 'VAR', 'WBR', 'FONT', 'BR']);
const clean = s => s.replace(/\s+/g, ' ').trim();

// How much of an element's text is links (0 to 1).
function linkShare(el) {
  const text = clean(el.textContent);
  const linked = [...el.querySelectorAll('a')].reduce((n, a) => n + clean(a.textContent).length, 0);
  return text ? linked / text.length : 0;
}

// Lists of links and lines like "Read also: <link>" between paragraphs aren't part of the article.
function isLinkList(list) {
  const items = [...list.children].filter(li => li.nodeName === 'LI');
  return items.length > 0 && items.every(li => !clean(li.textContent) || linkShare(li) >= 0.8);
}

// Boxes such as "Most read" start with a link to skip them, to a place at their end.
function isSkippableBox(el) {
  const skip = el.querySelector('a');
  const id = skip?.getAttribute('href')?.startsWith('#') && skip.getAttribute('href').slice(1);
  return !!id && clean(el.textContent).startsWith(clean(skip.textContent)) && !!el.querySelector(`[id="${id.replace(/["\\]/g, '\\$&')}"]`);
}

// The article's content (HTML from Readability) as blocks: { text }, { heading, text }
// and { picture: url, caption }. Its own title and byline are left out, since the
// chapter has them.
function contentBlocks(html, title, base, screen) {
  const { document } = parseHTML(`<!DOCTYPE html><html><body>${html}</body></html>`);
  const blocks = [];
  let text = '';
  const flush = () => {
    const t = clean(text);
    if (t) blocks.push({ text: t });
    text = '';
  };
  const picture = img => {
    const url = pictureSource(img, base, screen);
    if (url && !blocks.some(b => b.picture === url)) blocks.push({ picture: url });
  };

  const walk = node => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        text += child.textContent;
        continue;
      }
      if (child.nodeType !== 1) continue;
      const tag = child.nodeName;
      const label = `${child.getAttribute('class') || ''} ${child.getAttribute('data-testid') || ''} ${child.getAttribute('aria-labelledby') || ''}`;
      if (SKIP.has(tag) || /byline|share|social/i.test(label) || isSkippableBox(child)) continue;
      if (tag === 'BR') {
        text += '\n';
        flush();
      } else if (tag === 'IMG') {
        flush();
        picture(child);
      } else if (/^H[1-6]$/.test(tag)) {
        flush();
        const t = clean(child.textContent);
        if (t && t !== title) blocks.push({ heading: true, text: t });
      } else if (tag === 'FIGURE') {
        // the picture and its caption; credits ("Getty Images") aren't kept
        flush();
        child.querySelectorAll('img').forEach(picture);
        const caption = clean(child.querySelector('figcaption')?.textContent || '');
        if (caption) blocks.push({ text: caption, caption: true });
      } else if (tag === 'UL' || tag === 'OL') {
        flush();
        if (isLinkList(child)) continue;
        [...child.children].forEach((li, i) => {
          const t = clean(li.textContent);
          if (t) blocks.push({ text: `${tag === 'OL' ? `${i + 1}.` : '•'} ${t}` });
        });
      } else if (INLINE.has(tag)) {
        if (child.querySelector('img')) walk(child);
        else text += child.textContent;
      } else if (tag === 'P' && linkShare(child) >= 0.7) {
        flush();
      } else {
        // a paragraph or a box of them: its own blocks
        flush();
        walk(child);
        flush();
      }
    }
  };
  walk(document.body);
  flush();
  return blocks;
}

function formatDate(iso, lang) {
  const date = iso && new Date(iso);
  if (!date || isNaN(date)) return '';
  try {
    return new Intl.DateTimeFormat(lang || 'en', { dateStyle: 'long' }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

// One web page's article: its title, byline, site, language, date and blocks.
async function readArticle(link, screen) {
  let page;
  try {
    page = await download(link, MAX_PAGE_BYTES, 'text/html,application/xhtml+xml');
  } catch (err) {
    throw new Error(`${link} could not be opened: ${err.message}.`);
  }
  if (!/html|xml/i.test(page.type)) throw new Error(`${link} is not a web page.`);
  const { document } = parseHTML(decodeHtml(page));
  // pictures' links made whole, since Readability can't work out the page's address here
  for (const img of document.querySelectorAll('img, source')) {
    for (const attr of ['src', 'data-src']) {
      const value = img.getAttribute(attr);
      if (value && !value.startsWith('data:')) {
        try {
          img.setAttribute(attr, new URL(value, page.url).href);
        } catch {}
      }
    }
  }
  const meta = name => document.querySelector(`meta[property="${name}"], meta[name="${name}"]`)?.getAttribute('content') || '';
  let lead = null; // the picture it shares on social media
  try {
    lead = meta('og:image') && new URL(meta('og:image'), page.url).href;
  } catch {}
  const found = new Readability(document).parse();
  if (!found || !clean(found.textContent || '')) throw new Error(`No article was found on ${link}.`);
  const title = clean(found.title || '') || page.url;
  const blocks = contentBlocks(found.content, title, page.url, screen);
  if (!blocks.some(b => b.text && !b.caption)) throw new Error(`No article text was found on ${link}.`);
  const lang = (found.lang || document.documentElement.getAttribute('lang') || '').split(/[-_]/)[0].toLowerCase();
  return {
    url: page.url,
    title,
    byline: clean(found.byline || ''),
    site: clean(found.siteName || '') || new URL(page.url).hostname.replace(/^www\./, ''),
    lang: /^[a-z]{2,3}$/.test(lang) ? lang : '',
    date: formatDate(found.publishedTime || meta('article:published_time'), lang),
    lead,
    blocks,
  };
}

// Download pictures a few at a time. Resolves with each url's file, or null if it couldn't be read.
async function downloadPictures(urls, onDone) {
  const files = new Map();
  const queue = [...urls];
  const worker = async () => {
    while (queue.length) {
      const url = queue.shift();
      try {
        files.set(url, (await download(url, MAX_IMAGE_BYTES, 'image/avif,image/webp,image/png,image/jpeg,image/*')).data);
      } catch {
        files.set(url, null);
      }
      onDone(files.size);
    }
  };
  await Promise.all(Array.from({ length: Math.min(DOWNLOADS, queue.length) }, worker));
  return files;
}

const sameText = (a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }) === 0;

// Where an article's main picture is in its blocks: a picture above its text, or -1.
function leadPicture(blocks) {
  const i = blocks.findIndex(b => b.picture || (b.text && !b.heading));
  return blocks[i]?.picture ? i : -1;
}

// An article's main picture (and its caption) below its first paragraph, so the
// chapter starts with its title and text instead of a page with only the title
// (every picture fills a page of its own). Left out when it's the book's cover.
function moveLeadPicture(blocks, isCover) {
  const at = leadPicture(blocks);
  if (at < 0) return blocks;
  const rest = [...blocks];
  const lead = rest.splice(at, rest[at + 1]?.caption ? 2 : 1);
  if (isCover) return rest;
  const first = rest.findIndex(b => b.text && !b.heading);
  rest.splice(first + 1, 0, ...lead);
  return rest;
}

// Web pages into a book for buildEpub: one chapter per article, with its pictures
// drawn for the reader's screen like a PDF's. The first article's main picture is
// the cover. Links that can't be read are skipped and listed in `skipped`; if none
// can be read, this fails with the first one's reason.
// `onProgress({ stage, done, total })`: 'pages' as pages are read, 'images' as
// pictures are downloaded, then 'finishing'.
async function readWebPages(links, { title, author, device = 'x4', onProgress = () => {} } = {}) {
  const screen = readerScreen(device);
  const articles = [];
  const skipped = [];
  onProgress({ stage: 'pages', done: 0, total: links.length });
  for (const [i, link] of links.entries()) {
    try {
      articles.push(await readArticle(link, screen));
    } catch (err) {
      skipped.push({ link, reason: err.message });
    }
    onProgress({ stage: 'pages', done: i + 1, total: links.length });
  }
  if (!articles.length) throw new Error(skipped[0].reason);

  const wanted = articles.flatMap(a => a.blocks.filter(b => b.picture).slice(0, MAX_PICTURES).map(b => b.picture));
  // the cover is the first article's main picture: the one above its text, or the one it shares on social media
  const firstLead = articles[0].blocks[leadPicture(articles[0].blocks)]?.picture;
  const coverUrl = firstLead || articles[0].lead || wanted[0];
  const urls = [...new Set([...wanted, ...(coverUrl ? [coverUrl] : [])])];
  onProgress({ stage: 'images', done: 0, total: urls.length });
  const files = await downloadPictures(urls, done => onProgress({ stage: 'images', done, total: urls.length }));

  let cover = null;
  if (coverUrl && files.get(coverUrl)) {
    try {
      cover = await imageCover(files.get(coverUrl), screen);
    } catch {}
  }
  const arranged = articles.map((a, i) => moveLeadPicture(a.blocks, i === 0 && !!cover && coverUrl === firstLead));

  onProgress({ stage: 'finishing' });
  const images = [];
  const names = new Map(); // picture url → image name in the book
  for (const b of arranged.flat()) {
    if (!b.picture || names.has(b.picture) || !files.get(b.picture)) continue;
    try {
      const image = await loadImage(files.get(b.picture));
      if (image.width < MIN_PICTURE || image.height < MIN_PICTURE) continue;
      const name = `img${images.length + 1}.png`;
      images.push({ name, data: screenImage(image, screen) });
      names.set(b.picture, name);
    } catch {} // not a picture that can be read: left out
  }
  const chapters = articles.map((a, i) => {
    const about = [a.site, a.byline, a.date].filter((s, k, all) => s && all.findIndex(o => sameText(o, s)) === k).join(' · ');
    const blocks = arranged[i].flatMap(b => {
      if (!b.picture) return [{ text: b.text, ...(b.heading && { heading: true }) }];
      return names.has(b.picture) ? [{ image: names.get(b.picture) }] : [];
    });
    return { title: a.title, blocks: [...(about ? [{ text: about }] : []), ...blocks, { text: a.url }] };
  });

  const sites = [...new Set(articles.map(a => a.site))];
  const today = formatDate(new Date().toISOString(), 'en'); // in the app's language, like 'Articles'
  const one = articles.length === 1 ? articles[0] : null;
  const bookTitle = title || (one ? one.title : `${sites.length === 1 ? sites[0] : 'Articles'} · ${today}`);
  const paragraphs = chapters.reduce((n, ch) => n + ch.blocks.filter(b => !b.heading && !b.image).length, 0);
  return {
    title: bookTitle,
    author: author || (one ? one.byline || one.site : sites.join(', ')),
    language: articles[0].lang || 'en',
    chapters,
    images,
    cover,
    device,
    fileName: bookTitle.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) + '.epub',
    skipped,
    stats: { articles: articles.length, pages: articles.length, paragraphs, images: images.length, fullPagePictures: 0 },
  };
}

// A web page's title, site and main picture, read quickly (not its article), so a
// list of links can show them while the books wait to be made. The picture is a
// small JPEG (`size`, cropped to fill it) as a data: address, or null.
async function previewLink(link, size = { width: 120, height: 180 }) {
  const [url] = parseLinks(link);
  let page;
  try {
    page = await download(url, MAX_PAGE_BYTES, 'text/html,application/xhtml+xml');
  } catch (err) {
    throw new Error(`${url} could not be opened: ${err.message}.`);
  }
  if (!/html|xml/i.test(page.type)) throw new Error(`${url} is not a web page.`);
  const { document } = parseHTML(decodeHtml(page));
  const meta = name => document.querySelector(`meta[property="${name}"], meta[name="${name}"]`)?.getAttribute('content') || '';
  const site = clean(meta('og:site_name')) || new URL(page.url).hostname.replace(/^www\./, '');
  // the title without the site's name after it ("… - BBC News Indonesia")
  const named = clean(meta('og:title') || meta('twitter:title') || document.querySelector('title')?.textContent || '');
  const ending = named.match(/^(.*\S)\s+[-–—|:·]\s+([^-–—|:·]+)$/);
  const title = ending && sameText(ending[2].trim(), site) ? ending[1] : named;
  let image = null;
  const src = meta('og:image') || meta('twitter:image');
  if (src) {
    try {
      const { data } = await download(new URL(src, page.url).href, MAX_IMAGE_BYTES, 'image/avif,image/webp,image/png,image/jpeg,image/*');
      const picture = await loadImage(data);
      const scale = Math.max(size.width / picture.width, size.height / picture.height);
      const canvas = createCanvas(size.width, size.height);
      const w = picture.width * scale, h = picture.height * scale;
      canvas.getContext('2d').drawImage(picture, (size.width - w) / 2, (size.height - h) / 2, w, h);
      image = 'data:image/jpeg;base64,' + canvas.toBuffer('image/jpeg').toString('base64');
    } catch {} // no picture that can be read: the title alone
  }
  return { title, site, image };
}

module.exports = { splitLinks, parseLinks, readWebPages, previewLink };
