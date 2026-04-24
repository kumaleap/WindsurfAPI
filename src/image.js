import http from 'node:http';
import https from 'node:https';
import { lookup as dnsLookup } from 'node:dns';
import { log } from './config.js';

const MAX_SIZE = 5 * 1024 * 1024; // 5 MB
const MAX_BASE64_LEN = Math.ceil((MAX_SIZE * 4) / 3) + 100;
const MAX_REDIRECTS = 3;
const MIME_OK = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const PRIVATE_HOST = /^(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|0\.|::1$|localhost$|0\.0\.0\.0$|\[::)/i;
const PRIVATE_IP = /^(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|0\.|::1$|::$|f[cd][0-9a-f]{2}:|fe80:)/i;

function safeLookup(hostname, options, callback) {
  dnsLookup(hostname, options, (err, address, family) => {
    if (err) return callback(err);
    const addrs = Array.isArray(address) ? address : [{ address, family }];
    for (const addr of addrs) {
      if (PRIVATE_IP.test(addr.address)) {
        return callback(new Error(`Image URL resolves to private address: ${addr.address}`));
      }
    }
    callback(null, address, family);
  });
}

function validateImageUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Invalid image URL');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Image URL must be http or https');
  }
  if (PRIVATE_HOST.test(parsed.hostname)) {
    throw new Error('Image URL targets a private/internal address');
  }
  return parsed;
}

export function parseDataUrl(url) {
  const clean = String(url || '').replace(/\s/g, '');
  const match = clean.match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i);
  if (!match) return null;
  if (match[2].length > MAX_BASE64_LEN) {
    throw new Error(`Image data URL exceeds ${MAX_SIZE} byte limit`);
  }
  return {
    base64_data: match[2],
    mime_type: match[1].toLowerCase(),
  };
}

export function fetchImageUrl(url, timeoutMs = 8000, depth = 0) {
  if (depth > MAX_REDIRECTS) {
    return Promise.reject(new Error('Too many image redirects'));
  }
  validateImageUrl(url);

  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, value) => {
      if (!settled) {
        settled = true;
        fn(value);
      }
    };

    const transport = url.startsWith('https://') ? https : http;
    const req = transport.get(
      url,
      {
        timeout: timeoutMs,
        headers: { Accept: 'image/*' },
        lookup: safeLookup,
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return fetchImageUrl(res.headers.location, timeoutMs, depth + 1).then(
            (value) => done(resolve, value),
            (err) => done(reject, err),
          );
        }
        if (res.statusCode !== 200) {
          res.resume();
          return done(reject, new Error(`Image fetch HTTP ${res.statusCode}`));
        }
        const mime = String(res.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
        if (!MIME_OK.has(mime)) {
          res.resume();
          return done(reject, new Error(`Unsupported image type: ${mime}`));
        }

        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          if (settled) return;
          size += chunk.length;
          if (size > MAX_SIZE) {
            res.destroy();
            done(reject, new Error(`Image exceeds ${MAX_SIZE} bytes`));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => done(resolve, {
          base64_data: Buffer.concat(chunks).toString('base64'),
          mime_type: mime,
        }));
        res.on('error', (err) => done(reject, err));
      },
    );

    req.on('error', (err) => done(reject, err));
    req.on('timeout', () => {
      req.destroy();
      done(reject, new Error('Image fetch timeout'));
    });
  });
}

export async function extractImages(contentBlocks) {
  if (!Array.isArray(contentBlocks)) {
    return { text: String(contentBlocks ?? ''), images: [] };
  }

  let text = '';
  const images = [];

  for (const block of contentBlocks) {
    if (!block || typeof block === 'string') {
      text += block || '';
      continue;
    }

    if (block.type === 'text') {
      text += block.text || '';
      continue;
    }

    if (block.type === 'image') {
      const src = block.source || {};
      try {
        if ((src.type === 'base64' || !src.type) && src.data) {
          if (src.data.length > MAX_BASE64_LEN) {
            log.warn('Image base64 exceeds size limit, skipping');
            continue;
          }
          images.push({
            base64_data: src.data,
            mime_type: src.media_type || 'image/png',
          });
        } else if (src.type === 'url' && src.url) {
          images.push(await fetchImageUrl(src.url));
        }
      } catch (err) {
        log.warn(`Image extraction failed: ${err.message}`);
      }
      continue;
    }

    if (block.type === 'image_url') {
      const url = block.image_url?.url || '';
      try {
        if (url.startsWith('data:')) {
          const parsed = parseDataUrl(url);
          if (parsed) images.push(parsed);
        } else if (url.startsWith('https://') || url.startsWith('http://')) {
          images.push(await fetchImageUrl(url));
        }
      } catch (err) {
        log.warn(`Image fetch failed: ${err.message}`);
      }
    }
  }

  return { text, images };
}
