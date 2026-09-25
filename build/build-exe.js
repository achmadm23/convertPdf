// Builds dist/ConvertPdf.exe: Node.js plus the converter in one file, using
// Node's single executable application (SEA) support.
// Usage: npm run build:exe   (builds for the OS it runs on)

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');
const work = path.join(dist, 'work');

// Files of each runtime package the app actually uses. A package not listed
// here is included whole; `deps` also pulls in its dependencies.
const PACKAGES = {
  'pdfjs-dist': {
    include: [/^package\.json$/, /^legacy\/build\/pdf(\.worker)?\.mjs$/, /^(wasm|cmaps|standard_fonts|iccs)\//],
  },
  '@napi-rs/canvas': { deps: true },
  [`@napi-rs/canvas-${process.platform}-${process.arch}${process.platform === 'win32' ? '-msvc' : ''}`]: {},
  jszip: { deps: true, include: [/^package\.json$/, /^lib\//, /^dist\/jszip\.min\.js$/] },
  epubjs: { include: [/^package\.json$/, /^dist\/epub\.min\.js$/] },
  // OCR: only the engine builds tesseract.js loads in Node, the separate .js + .wasm
  // ones without "-lstm" in the name (tesseract.js 7 passes a boolean where
  // getCore expects an engine mode, so it never picks the "-lstm" builds).
  // Listed before tesseract.js, whose `deps` would otherwise pull in every build.
  'tesseract.js-core': { include: [/^package\.json$/, /^tesseract-core(-simd|-relaxedsimd)?\.(js|wasm)$/] },
  'tesseract.js': { deps: true, include: [/^package\.json$/, /^src\//] },
};
for (const code of Object.keys(require('../ocr').LANGUAGES)) {
  PACKAGES[`@tesseract.js-data/${code}`] = { include: [/^package\.json$/, /^4\.0\.0_best_int\//] };
}
const FONT_FILES = [/^package\.json$/, /^(400|700)\.css$/, /^files\/.*-latin(-ext)?-(400|700)-normal\.woff$/];
for (const pkg of Object.keys(require(path.join(root, 'package.json')).dependencies)) {
  if (pkg.startsWith('@fontsource/')) PACKAGES[pkg] = { include: FONT_FILES };
}

const APP_FILES = ['index.js', 'figures.js', 'fonts.js', 'ocr.js', 'server.js', 'package.json', 'public/index.html'];

function walk(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return walk(full, base);
    return [path.relative(base, full).split(path.sep).join('/')];
  });
}

function packageDir(name, from = root) {
  return path.dirname(require.resolve(`${name}/package.json`, { paths: [from] }));
}

// Collect [{ path in app, source file }]
function collectFiles() {
  const files = APP_FILES.map(f => ({ path: f, source: path.join(root, f) }));
  const seen = new Set();

  const addPackage = (name, from, rules = {}) => {
    const dir = packageDir(name, from);
    if (seen.has(dir)) return;
    seen.add(dir);
    const rel = path.relative(root, dir).split(path.sep).join('/');
    for (const f of walk(dir)) {
      if (f.startsWith('node_modules/')) continue; // nested deps are handled below
      if (/\.(map|md|ts|d\.mts)$/i.test(f) && f !== 'package.json') continue;
      if (rules.include && !rules.include.some(re => re.test(f))) continue;
      files.push({ path: `${rel}/${f}`, source: path.join(dir, f) });
    }
    if (rules.deps) {
      const { dependencies = {} } = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      for (const dep of Object.keys(dependencies)) {
        try {
          addPackage(dep, dir, { deps: true });
        } catch {} // optional platform packages that aren't installed
      }
    }
  };

  for (const [name, rules] of Object.entries(PACKAGES)) addPackage(name, root, rules);
  return files;
}

function pack(files) {
  const header = Buffer.from(
    JSON.stringify({ files: files.map(f => ({ path: f.path, size: fs.statSync(f.source).size })) })
  );
  const length = Buffer.alloc(4);
  length.writeUInt32LE(header.length);
  const raw = Buffer.concat([length, header, ...files.map(f => fs.readFileSync(f.source))]);
  return zlib.gzipSync(raw, { level: 9 });
}

function main() {
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });

  const files = collectFiles();
  const packed = pack(files);
  const appBin = path.join(work, 'app.bin');
  fs.writeFileSync(appBin, packed);
  console.log(`Packed ${files.length} files: ${(packed.length / 1e6).toFixed(1)} MB`);

  const blob = path.join(work, 'sea-prep.blob');
  const config = path.join(work, 'sea-config.json');
  fs.writeFileSync(
    config,
    JSON.stringify({
      main: path.join(__dirname, 'launcher.js'),
      output: blob,
      assets: { 'app.bin': appBin },
      disableExperimentalSEAWarning: true,
    })
  );
  execFileSync(process.execPath, ['--experimental-sea-config', config], { stdio: 'inherit' });

  const exe = path.join(dist, process.platform === 'win32' ? 'ConvertPdf.exe' : 'ConvertPdf');
  fs.copyFileSync(process.execPath, exe);
  const postject = require.resolve('postject/dist/cli.js');
  const args = [postject, exe, 'NODE_SEA_BLOB', blob, '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'];
  if (process.platform === 'darwin') args.push('--macho-segment-name', 'NODE_SEA');
  execFileSync(process.execPath, args, { stdio: 'inherit' });

  fs.rmSync(work, { recursive: true, force: true });
  console.log(`Built ${path.relative(root, exe)} (${(fs.statSync(exe).size / 1e6).toFixed(0)} MB)`);
}

main();
