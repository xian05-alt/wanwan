import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, relative, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const port = Number.parseInt(process.env.PORT || '3000', 10);
const geminiOrigin = 'https://generativelanguage.googleapis.com';
const geminiRoutes = new Map([
  ['/api/gemini/models', { method: 'GET', upstreamPath: '/v1beta/openai/models' }],
  ['/api/gemini/chat/completions', { method: 'POST', upstreamPath: '/v1beta/openai/chat/completions' }],
  ['/api/gemini/images/generations', { method: 'POST', upstreamPath: '/v1beta/openai/images/generations' }],
  ['/api/gemini/images/edits', { method: 'POST', upstreamPath: '/v1beta/openai/images/edits' }]
]);
const geminiBodyLimit = 16 * 1024 * 1024;
const geminiActiveByClient = new Map();

const mimeTypes = {
  '.avif': 'image/avif',
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.ogg': 'audio/ogg',
  '.otf': 'font/otf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.wav': 'audio/wav',
  '.webm': 'video/webm',
  '.webmanifest': 'application/manifest+json',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
};

function resolvePublicPath(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }

  const clean = normalize(decoded).replace(/^([/\\])+/, '');
  const candidate = join(root, clean || 'index.html');
  const insideRoot = relative(root, candidate);

  if (insideRoot.startsWith(`..${sep}`) || insideRoot === '..') return null;
  return candidate;
}

async function findFile(urlPath) {
  const candidate = resolvePublicPath(urlPath);
  if (!candidate) return null;

  try {
    const info = await stat(candidate);
    if (info.isFile()) return { path: candidate, size: info.size };
    if (info.isDirectory()) {
      const indexPath = join(candidate, 'index.html');
      const indexInfo = await stat(indexPath);
      if (indexInfo.isFile()) return { path: indexPath, size: indexInfo.size };
    }
  } catch {
    return null;
  }

  return null;
}

function cacheControl(pathname) {
  const name = pathname.split('/').pop();
  if (!name || name === 'index.html' || name === 'manifest.json' || name === 'service.js' || name === 'sw.js') {
    return 'no-cache';
  }
  return 'public, max-age=3600';
}

function sendJson(response, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...headers
  });
  response.end(body);
}

function readRequestBody(request, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    request.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        settled = true;
        const error = new Error('Request body is too large');
        error.status = 413;
        reject(error);
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (!settled) resolve(Buffer.concat(chunks));
    });
    request.on('error', (error) => {
      if (!settled) reject(error);
    });
  });
}

function geminiClientKey(request) {
  return request.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || request.socket.remoteAddress
    || 'unknown';
}

function copyGeminiResponseHeaders(upstreamResponse) {
  const headers = { 'Cache-Control': 'no-store' };
  for (const name of ['content-type', 'retry-after', 'x-request-id', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset']) {
    const value = upstreamResponse.headers.get(name);
    if (value) headers[name] = value;
  }
  return headers;
}

async function proxyGemini(request, response, route) {
  if (request.method !== route.method) {
    response.writeHead(405, { Allow: route.method });
    response.end('Method Not Allowed');
    return;
  }

  const authorization = String(request.headers.authorization || '');
  if (!/^Bearer\s+\S+$/i.test(authorization) || authorization.length > 16384) {
    sendJson(response, 401, { error: { message: 'Gemini API Key is required' } });
    return;
  }

  const clientKey = geminiClientKey(request);
  const active = geminiActiveByClient.get(clientKey) || 0;
  if (active >= 4) {
    sendJson(response, 429, { error: { message: 'Too many concurrent Gemini requests' } }, { 'Retry-After': '2' });
    return;
  }
  geminiActiveByClient.set(clientKey, active + 1);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180000);
  request.on('aborted', () => controller.abort());
  response.on('close', () => {
    if (!response.writableEnded) controller.abort();
  });

  try {
    const body = route.method === 'POST' ? await readRequestBody(request, geminiBodyLimit) : undefined;
    const upstreamResponse = await fetch(geminiOrigin + route.upstreamPath, {
      method: route.method,
      headers: {
        Accept: 'application/json',
        Authorization: authorization,
        ...(route.method === 'POST' && request.headers['content-type']
          ? { 'Content-Type': request.headers['content-type'] }
          : {})
      },
      body,
      signal: controller.signal
    });
    response.writeHead(upstreamResponse.status, copyGeminiResponseHeaders(upstreamResponse));
    if (!upstreamResponse.body) {
      response.end();
      return;
    }
    await pipeline(Readable.fromWeb(upstreamResponse.body), response);
  } catch (error) {
    if (response.headersSent) {
      response.destroy(error);
    } else if (error && error.status === 413) {
      sendJson(response, 413, { error: { message: 'Gemini request body exceeds 16 MB' } });
    } else if (error && error.name === 'AbortError') {
      sendJson(response, 504, { error: { message: 'Gemini upstream request timed out' } });
    } else {
      sendJson(response, 502, { error: { message: 'Gemini upstream request failed' } });
    }
  } finally {
    clearTimeout(timeout);
    const remaining = (geminiActiveByClient.get(clientKey) || 1) - 1;
    if (remaining > 0) geminiActiveByClient.set(clientKey, remaining);
    else geminiActiveByClient.delete(clientKey);
  }
}

const server = createServer(async (request, response) => {
  const requestUrl = new URL(request.url || '/', 'http://localhost');
  const geminiRoute = geminiRoutes.get(requestUrl.pathname);
  if (geminiRoute) {
    await proxyGemini(request, response, geminiRoute);
    return;
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' });
    response.end('Method Not Allowed');
    return;
  }

  let file = await findFile(requestUrl.pathname);

  if (!file && (request.headers.accept || '').includes('text/html')) {
    file = await findFile('/index.html');
  }

  if (!file) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not Found');
    return;
  }

  const contentType = mimeTypes[extname(file.path).toLowerCase()] || 'application/octet-stream';
  const headers = {
    'Accept-Ranges': 'bytes',
    'Cache-Control': cacheControl(requestUrl.pathname),
    'Content-Type': contentType
  };

  const range = request.headers.range;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match) {
      response.writeHead(416, { 'Content-Range': `bytes */${file.size}` });
      response.end();
      return;
    }

    const start = match[1] ? Number(match[1]) : 0;
    const end = match[2] ? Number(match[2]) : file.size - 1;
    if (start > end || end >= file.size) {
      response.writeHead(416, { 'Content-Range': `bytes */${file.size}` });
      response.end();
      return;
    }

    response.writeHead(206, {
      ...headers,
      'Content-Length': end - start + 1,
      'Content-Range': `bytes ${start}-${end}/${file.size}`
    });
    if (request.method === 'HEAD') response.end();
    else createReadStream(file.path, { start, end }).pipe(response);
    return;
  }

  response.writeHead(200, { ...headers, 'Content-Length': file.size });
  if (request.method === 'HEAD') response.end();
  else createReadStream(file.path).pipe(response);
});

server.listen(port, '0.0.0.0', () => {
  console.log(`Static site listening on port ${port}`);
});
