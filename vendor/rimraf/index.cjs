'use strict';

const fs = require('node:fs');

function rimraf(target, options, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = undefined;
  }

  const removeOptions = {
    recursive: true,
    force: true,
    ...(options || {})
  };

  if (typeof callback === 'function') {
    fs.rm(target, removeOptions, callback);
    return;
  }

  return fs.promises.rm(target, removeOptions);
}

rimraf.sync = function rimrafSync(target, options) {
  fs.rmSync(target, {
    recursive: true,
    force: true,
    ...(options || {})
  });
};

module.exports = rimraf;
