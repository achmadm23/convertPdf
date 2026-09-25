// Fonts the reader can choose for the EPUB. Each one (except the reader's
// default) is embedded in the book, so it looks the same in every e-reader.

const fs = require('fs');
const path = require('path');

const FONTS = [
  { id: 'default', name: 'Reader default', fallback: 'serif' },
  { id: 'literata', name: 'Literata', pkg: 'literata', fallback: 'serif' },
  { id: 'merriweather', name: 'Merriweather', pkg: 'merriweather', fallback: 'serif' },
  { id: 'lora', name: 'Lora', pkg: 'lora', fallback: 'serif' },
  { id: 'open-sans', name: 'Open Sans', pkg: 'open-sans', fallback: 'sans-serif' },
  { id: 'atkinson-hyperlegible', name: 'Atkinson Hyperlegible', pkg: 'atkinson-hyperlegible', fallback: 'sans-serif' },
];

const SUBSETS = ['latin', 'latin-ext'];
const WEIGHTS = [400, 700];

// The .woff files for a font's regular and bold weights, with the character
// ranges each file covers (read from the fontsource package's CSS).
function fontFaces(font) {
  if (!font.pkg) return [];
  const dir = path.dirname(require.resolve(`@fontsource/${font.pkg}/package.json`));
  const faces = [];
  for (const weight of WEIGHTS) {
    const css = fs.readFileSync(path.join(dir, `${weight}.css`), 'utf8');
    for (const subset of SUBSETS) {
      const file = `${font.pkg}-${subset}-${weight}-normal.woff`;
      const block = css.split('@font-face').find(b => b.includes(`/${file}2)`));
      const range = block && block.match(/unicode-range:\s*([^;]+);/);
      faces.push({ file, path: path.join(dir, 'files', file), weight, range: range ? range[1].trim() : null });
    }
  }
  return faces;
}

function findFont(id) {
  return FONTS.find(f => f.id === id) || FONTS[0];
}

// @font-face rules pointing at `urlPrefix + file`.
function fontFaceCss(font, urlPrefix) {
  return fontFaces(font)
    .map(
      f => `@font-face {
  font-family: '${font.name}';
  font-style: normal;
  font-weight: ${f.weight};
  src: url(${urlPrefix}${f.file}) format('woff');${f.range ? `\n  unicode-range: ${f.range};` : ''}
}`
    )
    .join('\n');
}

function fontStack(font) {
  return font.pkg ? `'${font.name}', ${font.fallback}` : font.fallback;
}

module.exports = { FONTS, findFont, fontFaces, fontFaceCss, fontStack };
