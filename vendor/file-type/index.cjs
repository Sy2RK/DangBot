'use strict';

async function fromBuffer(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);

  if (isPng(buffer)) return { ext: 'png', mime: 'image/png' };
  if (isJpeg(buffer)) return { ext: 'jpg', mime: 'image/jpeg' };
  if (isGif(buffer)) return { ext: 'gif', mime: 'image/gif' };
  if (isWebp(buffer)) return { ext: 'webp', mime: 'image/webp' };
  if (isBmp(buffer)) return { ext: 'bmp', mime: 'image/bmp' };
  if (isTiffLe(buffer)) return { ext: 'tif', mime: 'image/tiff' };
  if (isTiffBe(buffer)) return { ext: 'tif', mime: 'image/tiff' };

  return undefined;
}

module.exports = {
  fromBuffer
};

function isPng(buffer) {
  return (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  );
}

function isJpeg(buffer) {
  return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
}

function isGif(buffer) {
  return (
    buffer.length >= 6 &&
    buffer[0] === 0x47 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x38 &&
    (buffer[4] === 0x37 || buffer[4] === 0x39) &&
    buffer[5] === 0x61
  );
}

function isWebp(buffer) {
  return (
    buffer.length >= 12 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  );
}

function isBmp(buffer) {
  return buffer.length >= 2 && buffer[0] === 0x42 && buffer[1] === 0x4d;
}

function isTiffLe(buffer) {
  return (
    buffer.length >= 4 &&
    buffer[0] === 0x49 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x2a &&
    buffer[3] === 0x00
  );
}

function isTiffBe(buffer) {
  return (
    buffer.length >= 4 &&
    buffer[0] === 0x4d &&
    buffer[1] === 0x4d &&
    buffer[2] === 0x00 &&
    buffer[3] === 0x2a
  );
}
