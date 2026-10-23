// Build the website (npm run build:web): the converter running in the browser,
// as static files in site/ for GitHub Pages. The page is public/index.html, the
// same one the app serves; here it gets web/api.js, which does the server's work.

const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');
const { LANGUAGES } = require('../ocr');

const root = path.resolve(__dirname, '..');
const site = path.join(root, 'site');
const { version } = require(path.join(root, 'package.json'));
const pkg = name => path.dirname(require.resolve(`${name}/package.json`));

// Node-only modules of the shared code, and their browser versions
const SWAPS = {
  [path.join(root, 'pdf.js')]: path.join(__dirname, 'pdf.js'),
  [path.join(root, 'ocr-platform.js')]: path.join(__dirname, 'ocr-platform.js'),
  [path.join(root, 'picture-pages.js')]: path.join(__dirname, 'picture-pages.js'),
};
const swapPlatform = {
  name: 'swap-platform',
  setup(build) {
    build.onResolve({ filter: /^\.\.?\// }, args => {
      const target = path.resolve(args.resolveDir, args.path);
      const swap = SWAPS[target] || SWAPS[target + '.js'];
      return swap ? { path: swap } : undefined;
    });
  },
};

function copy(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, { recursive: true });
}

async function main() {
  fs.rmSync(site, { recursive: true, force: true });
  fs.mkdirSync(site, { recursive: true });

  await esbuild.build({
    entryPoints: [path.join(__dirname, 'api.js')],
    outfile: path.join(site, 'app.js'),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['chrome110', 'firefox115', 'safari16'],
    minify: true,
    legalComments: 'none',
    inject: [path.join(__dirname, 'shims', 'buffer.js')],
    define: { __VERSION__: JSON.stringify(version), 'process.env.NODE_ENV': '"production"' },
    alias: {
      '@napi-rs/canvas': './web/shims/canvas.js',
      zlib: './web/shims/zlib.js',
      crypto: './web/shims/crypto.js',
      path: './web/shims/path.js',
      fs: './web/shims/empty.js',
      os: './web/shims/empty.js',
    },
    absWorkingDir: root,
    plugins: [swapPlatform],
    logLevel: 'warning',
  });

  // the page, with the in-browser converter loaded before its own script
  const page = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  const marker = '<script src="vendor/jszip.min.js"></script>';
  if (!page.includes(marker)) throw new Error('index.html: could not find where to load app.js');
  fs.writeFileSync(path.join(site, 'index.html'), page.replace(marker, `<script src="app.js"></script>\n${marker}`));

  copy(require.resolve('jszip/dist/jszip.min.js'), path.join(site, 'vendor', 'jszip.min.js'));
  copy(require.resolve('epubjs/dist/epub.min.js'), path.join(site, 'vendor', 'epub.min.js'));

  const pdfjs = pkg('pdfjs-dist');
  copy(path.join(pdfjs, 'build', 'pdf.worker.min.mjs'), path.join(site, 'vendor', 'pdfjs', 'pdf.worker.min.mjs'));
  for (const dir of ['wasm', 'cmaps', 'standard_fonts']) copy(path.join(pdfjs, dir), path.join(site, 'vendor', 'pdfjs', dir));

  // OCR: the worker, the engine (only the LSTM builds, the kind the converter uses), and the language data
  copy(path.join(pkg('tesseract.js'), 'dist', 'worker.min.js'), path.join(site, 'vendor', 'tesseract', 'worker.min.js'));
  const core = pkg('tesseract.js-core');
  for (const f of fs.readdirSync(core).filter(f => /^tesseract-core.*-lstm\.(wasm\.js|wasm|js)$/.test(f))) {
    copy(path.join(core, f), path.join(site, 'vendor', 'tesseract', f));
  }
  for (const code of Object.keys(LANGUAGES)) {
    const file = `${code}.traineddata.gz`;
    copy(path.join(pkg(`@tesseract.js-data/${code}`), '4.0.0_best_int', file), path.join(site, 'ocr', file));
  }

  for (const family of ['sans', 'mono']) {
    for (const weight of [400, 500, 600]) {
      const file = `ibm-plex-${family}-latin-${weight}-normal.woff2`;
      copy(path.join(pkg(`@fontsource/ibm-plex-${family}`), 'files', file), path.join(site, 'uifonts', file));
    }
  }

  fs.writeFileSync(path.join(site, '.nojekyll'), ''); // serve every file as it is
  console.log(`Built the website in site/ (convertPdf v${version})`);
}

main().catch(err => {
  console.error(err.message || err);
  process.exit(1);
});
