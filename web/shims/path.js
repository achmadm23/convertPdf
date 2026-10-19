// The parts of Node's path the converter's shared code touches in the browser.

const basename = (p, ext = '') => {
  const base = String(p).split(/[\\/]/).pop();
  return ext && base.endsWith(ext) ? base.slice(0, -ext.length) : base;
};
const extname = p => {
  const m = /\.[^./\\]*$/.exec(basename(p));
  return m ? m[0] : '';
};

module.exports = { basename, extname };
