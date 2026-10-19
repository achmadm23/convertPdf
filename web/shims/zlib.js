// The parts of Node's zlib the converter uses (to write PNG files).

const { zlibSync } = require('fflate');

function deflateSync(data, { level = 6 } = {}) {
  return Buffer.from(zlibSync(data, { level }));
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

// CRC-32, continuing from `previous` as Node's zlib.crc32 does
function crc32(data, previous = 0) {
  const bytes = typeof data === 'string' ? Buffer.from(data, 'latin1') : data;
  let c = (previous ^ 0xffffffff) >>> 0;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

module.exports = { deflateSync, crc32 };
