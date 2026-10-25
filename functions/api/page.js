// GET /api/page?url=…: a web page or picture fetched for the website (a Cloudflare
// Pages Function), since news sites don't let other websites read their pages. The
// page in the browser reads the article from it (web.js); this only fetches it, for
// the website's own pages (Sec-Fetch-Site), as a web page or a picture, up to 20 MB.
// The address it ends at (after redirects) is in X-Final-Url, for the article's links.

const MAX_BYTES = 20 * 1024 * 1024;
const TIMEOUT = 30 * 1000;
// some news sites turn away requests that don't look like they come from a browser
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36',
  'Accept-Language': 'id,en;q=0.8',
};
// the kinds of files it passes on: web pages and pictures, nothing else
const PASSED = /^(text\/html|application\/xhtml\+xml|application\/xml|text\/xml|image\/)/i;

const answer = (status, text) =>
  new Response(text, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-Convertpdf-Proxy': '1' } });

// a name that is this computer, the local network or an address written as numbers: not fetched
const isPrivate = host =>
  /^(localhost|.*\.local|.*\.internal|.*\.localhost)$/i.test(host) || /^\[|^\d+\.\d+\.\d+\.\d+$/.test(host);

export async function onRequestGet({ request }) {
  // only for the website's own pages, not a proxy for anyone
  const from = request.headers.get('Sec-Fetch-Site');
  if (from && from !== 'same-origin') return answer(403, 'Only for this website.');
  let url;
  try {
    url = new URL(new URL(request.url).searchParams.get('url') || '');
  } catch {
    return answer(400, 'Not a link.');
  }
  if (!/^https?:$/.test(url.protocol) || isPrivate(url.hostname)) return answer(400, 'Not a web page link.');
  let res;
  try {
    res = await fetch(url.href, {
      headers: { ...HEADERS, Accept: request.headers.get('Accept') || '*/*' },
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT),
    });
  } catch (err) {
    return answer(504, err && err.name === 'TimeoutError' ? 'the site took too long to answer' : 'the site could not be reached');
  }
  const type = res.headers.get('Content-Type') || '';
  const headers = {
    'Content-Type': type || 'application/octet-stream',
    'X-Final-Url': res.url || url.href,
    'X-Convertpdf-Proxy': '1',
    'Cache-Control': 'private, max-age=300',
  };
  // the site's own answer when it isn't the page (refused, not found): its status alone
  if (!res.ok) return new Response(null, { status: res.status, headers });
  if (!PASSED.test(type)) return answer(415, 'Only web pages and pictures.');
  if (Number(res.headers.get('Content-Length')) > MAX_BYTES) return answer(413, 'it is too large');
  return new Response(res.body, { status: 200, headers });
}
