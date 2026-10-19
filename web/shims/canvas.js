// The parts of @napi-rs/canvas the converter uses, made from the browser's own canvas.

function createCanvas(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  // the converter reads pixels back often (finding pictures, dithering)
  const getContext = canvas.getContext.bind(canvas);
  canvas.getContext = (type, options) => getContext(type, { willReadFrequently: true, ...options });
  // canvas.encode('jpeg', 90) → the image file's bytes
  canvas.encode = (format, quality = 92) =>
    new Promise((resolve, reject) => {
      canvas.toBlob(
        blob => (blob ? blob.arrayBuffer().then(b => resolve(Buffer.from(b)), reject) : reject(new Error('Could not encode the image.'))),
        `image/${format}`,
        quality / 100
      );
    });
  return canvas;
}

// A picture file's bytes as something drawImage can draw.
async function loadImage(data) {
  return createImageBitmap(new Blob([data]));
}

module.exports = { createCanvas, loadImage };
