// Entry point of ConvertPdf.exe. The app's files are packed inside the exe as
// one asset; on first run they're unpacked to the user's app-data folder,
// then the web server starts from there and the browser opens.
// Only Node built-ins are available here, so the pack format is kept simple:
// gzip( [4-byte header length][JSON header][file bytes...] ).

const sea = require('node:sea');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');

function appDataRoot() {
  const base =
    process.env.LOCALAPPDATA ||
    (process.platform === 'darwin'
      ? path.join(process.env.HOME, 'Library', 'Application Support')
      : path.join(process.env.HOME || '.', '.local', 'share'));
  return path.join(base, 'ConvertPdf');
}

function unpack() {
  const packed = Buffer.from(sea.getAsset('app.bin'));
  const version = crypto.createHash('sha256').update(packed).digest('hex').slice(0, 12);
  const root = appDataRoot();
  const dir = path.join(root, `app-${version}`);
  if (fs.existsSync(path.join(dir, '.complete'))) return dir;

  console.log('Setting up ConvertPdf for the first time…');
  const data = zlib.gunzipSync(packed);
  const headerLength = data.readUInt32LE(0);
  const { files } = JSON.parse(data.subarray(4, 4 + headerLength).toString('utf8'));
  let offset = 4 + headerLength;

  // unpack into a temporary folder and rename it at the end, so an interrupted
  // first run never leaves a half-unpacked app behind
  const tmp = `${dir}.tmp-${process.pid}`;
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const file of files) {
    const target = path.join(tmp, file.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data.subarray(offset, offset + file.size));
    offset += file.size;
  }
  fs.writeFileSync(path.join(tmp, '.complete'), version);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.renameSync(tmp, dir);

  // remove versions left behind by older copies of the exe
  for (const name of fs.readdirSync(root)) {
    if (name.startsWith('app-') && name !== `app-${version}`) {
      try {
        fs.rmSync(path.join(root, name), { recursive: true, force: true });
      } catch {}
    }
  }
  return dir;
}

try {
  const dir = unpack();
  process.env.CONVERTPDF_OPEN_BROWSER ??= '1'; // set it to 0 to start without opening the browser
  createRequire(path.join(dir, 'server.js'))('./server.js');
} catch (err) {
  console.error('ConvertPdf could not start:', err.message || err);
  console.error('Press Enter to close this window.');
  process.stdin.resume();
  process.stdin.on('data', () => process.exit(1));
}
