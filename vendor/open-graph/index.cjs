'use strict';

const http = require('node:http');
const https = require('node:https');

const MAX_HTML_BYTES = 512 * 1024;
const MAX_REDIRECTS = 3;
const DEFAULT_TIMEOUT_MS = 5000;
const BLOCKED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function openGraph(url, cb, options) {
  const userAgent =
    (options || {}).userAgent || 'NodeOpenGraphCrawler (DangBot safe compatibility shim)';
  openGraph.getHTML(url, userAgent, (error, html) => {
    if (error) {
      cb(error);
      return;
    }

    try {
      cb(null, openGraph.parse(html, options));
    } catch (parseError) {
      cb(parseError);
    }
  });
}

openGraph.getHTML = function getHTML(url, userAgent, cb) {
  fetchHtml(normalizeUrl(url), userAgent, 0, cb);
};

openGraph.parse = function parse(html, options) {
  const strict = Boolean(options && options.strict);
  const meta = {};

  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    const property = readAttr(tag, 'property') || readAttr(tag, 'name');
    const content = readAttr(tag, 'content');
    if (!property || content === undefined) continue;

    const normalized = normalizeMetaKey(property);
    if (!normalized) continue;
    assignMeta(meta, normalized, decodeHtml(content));
  }

  if (!Object.prototype.hasOwnProperty.call(meta, 'title')) {
    const title = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
    if (title && title[1]) {
      meta.title = decodeHtml(stripTags(title[1]).trim());
    }
  }

  if (strict && !meta.title && !meta.description && !meta.image) {
    return null;
  }

  return meta;
};

module.exports = openGraph;

function fetchHtml(url, userAgent, redirects, cb) {
  cb = once(cb);
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    cb(new Error('Invalid URL'));
    return;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    cb(new Error('Only http and https URLs are supported'));
    return;
  }

  const client = parsed.protocol === 'https:' ? https : http;
  const request = client.get(
    parsed,
    {
      headers: { 'User-Agent': userAgent },
      timeout: DEFAULT_TIMEOUT_MS
    },
    (response) => {
      const status = response.statusCode || 0;
      const location = response.headers.location;
      if (status >= 300 && status < 400 && location) {
        response.resume();
        if (redirects >= MAX_REDIRECTS) {
          cb(new Error('Too many redirects'));
          return;
        }
        try {
          fetchHtml(new URL(location, parsed).toString(), userAgent, redirects + 1, cb);
        } catch {
          cb(new Error('Invalid redirect URL'));
        }
        return;
      }

      if (status !== 200) {
        response.resume();
        cb(new Error(`Request failed with HTTP status code: ${status}`));
        return;
      }

      response.setEncoding('utf8');
      let size = 0;
      let body = '';
      response.on('data', (chunk) => {
        size += Buffer.byteLength(chunk);
        if (size > MAX_HTML_BYTES) {
          request.destroy(new Error('Open graph response is too large'));
          return;
        }
        body += chunk;
      });
      response.on('end', () => cb(null, body));
    }
  );

  request.on('timeout', () => request.destroy(new Error('Open graph request timed out')));
  request.on('error', cb);
}

function once(callback) {
  let called = false;
  return (...args) => {
    if (called) return;
    called = true;
    callback(...args);
  };
}

function normalizeUrl(url) {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `http://${url}`;
}

function normalizeMetaKey(property) {
  const clean = property.trim().toLowerCase();
  if (clean === 'og:title') return 'title';
  if (clean === 'og:description' || clean === 'description') return 'description';
  if (clean === 'og:image' || clean === 'og:image:url') return 'image';
  if (!clean.startsWith('og:')) return '';
  return clean.slice(3).replace(/:/g, '.');
}

function assignMeta(target, key, value) {
  const parts = key.split('.').filter((part) => part && !BLOCKED_KEYS.has(part));
  if (parts.length === 0) return;

  let cursor = target;
  while (parts.length > 1) {
    const part = parts.shift();
    if (!part) return;
    if (!cursor[part] || typeof cursor[part] !== 'object' || Array.isArray(cursor[part])) {
      cursor[part] = {};
    }
    cursor = cursor[part];
  }

  const last = parts[0];
  if (!last) return;
  if (cursor[last] === undefined) {
    cursor[last] = value;
  } else if (Array.isArray(cursor[last])) {
    cursor[last].push(value);
  } else {
    cursor[last] = [cursor[last], value];
  }
}

function readAttr(tag, name) {
  const pattern = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i');
  const match = tag.match(pattern);
  return match ? (match[1] ?? match[2] ?? match[3] ?? '') : undefined;
}

function stripTags(value) {
  return value.replace(/<[^>]*>/g, '');
}

function decodeHtml(value) {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (match, code) => decodeCodePoint(match, Number(code)))
    .replace(/&#x([a-f0-9]+);/gi, (match, code) =>
      decodeCodePoint(match, Number.parseInt(code, 16))
    );
}

function decodeCodePoint(fallback, codePoint) {
  if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return fallback;
  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return fallback;
  }
}
