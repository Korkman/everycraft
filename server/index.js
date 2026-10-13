import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { basename, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installVersion, launch, previousVersions } from './updater.js';
import { readCurrent, versionDir, VERSION_RE } from './store.js';

const PORT = Number(process.env.PORT ?? 8080);
const WEB_ROOT = fileURLToPath(new URL('../web', import.meta.url));
const tools = JSON.parse(await readFile(new URL('./tools.json', import.meta.url), 'utf8'));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.ttc': 'font/collection',
};

const NO_CACHE = 'no-cache';
const IMMUTABLE = 'public, max-age=31536000, immutable';
// Not content-hashed upstream, so these must revalidate even inside a versioned path.
const REVALIDATE_NAMES = new Set(['index.html', 'manifest.txt']);

const server = createServer(async (req, res) => {
  try {
    await route(req, res);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) text(res, 500, 'Internal error');
    else res.destroy();
  }
});

async function route(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return text(res, 405, 'Method not allowed');
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;

  if (path === '/healthz') return text(res, 200, 'ok');
  if (path === '/api/tools') {
    const list = Object.entries(tools).map(([id, t]) => ({ id, name: t.name, description: t.description }));
    return json(res, list, 'no-store');
  }
  if (path === '/api/versions') {
    const remote = url.searchParams.has('remote');
    const rows = await Promise.all(
      Object.entries(tools).map(async ([id, t]) => ({
        id,
        name: t.name,
        versions: (await previousVersions(id, t, remote)).map((v) => ({ ...v, url: `/apps/${id}/${v.version}/` })),
      })),
    );
    return json(res, rows.filter((r) => r.versions.length), 'no-store');
  }
  if (path.startsWith('/api/install/')) {
    const [id, version] = path.slice(13).split('/').map(decodeURIComponent);
    if (!Object.hasOwn(tools, id) || !VERSION_RE.test(version ?? '')) return text(res, 404, 'Not found');
    return stream(req, res, installVersion(id, tools[id], version), id);
  }
  if (path.startsWith('/api/launch/')) {
    const id = decodeURIComponent(path.slice(12));
    if (!Object.hasOwn(tools, id)) return text(res, 404, 'Unknown tool');
    return stream(req, res, launch(id, tools[id]), id);
  }
  if (path.startsWith('/apps/')) return app(req, res, url);
  return serve(req, res, WEB_ROOT, path === '/' ? 'index.html' : path, () => NO_CACHE);
}

function stream(req, res, job, id) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    'X-Accel-Buffering': 'no',
  });
  const send = (j) => {
    const body = { state: j.state, version: j.version, previousVersion: j.previousVersion, error: j.error };
    if (j.state === 'ready') body.url = `/apps/${id}/${j.version}/`;
    if (j.state === 'updating' && j.previousVersion) body.previousUrl = `/apps/${id}/${j.previousVersion}/`;
    res.write(`data: ${JSON.stringify(body)}\n\n`);
    if (j.state === 'ready' || j.state === 'failed') {
      j.listeners.delete(send);
      res.end();
    }
  };
  job.listeners.add(send);
  req.on('close', () => job.listeners.delete(send));
  send(job);
}

async function app(req, res, url) {
  const [, , id, version, ...rest] = url.pathname.split('/');
  if (!Object.hasOwn(tools, id)) return text(res, 404, 'Unknown tool');

  if (!version) {
    const cur = await readCurrent(id);
    if (!cur) return text(res, 404, 'Not installed');
    return redirect(res, `/apps/${id}/${cur.version}/${url.search}`);
  }
  if (!VERSION_RE.test(version)) return text(res, 404, 'Not found');
  // Relative asset URLs need the trailing slash.
  if (rest.length === 0) return redirect(res, `${url.pathname}/${url.search}`);

  const rel = rest.join('/') || 'index.html';
  return serve(req, res, versionDir(id, version), rel, (file) =>
    REVALIDATE_NAMES.has(basename(file)) ? NO_CACHE : IMMUTABLE, true);
}

async function serve(req, res, root, rel, cachePolicy, precompressed = false) {
  let decoded;
  try {
    decoded = decodeURIComponent(rel);
  } catch {
    return text(res, 400, 'Bad request');
  }
  if (decoded.includes('\0')) return text(res, 400, 'Bad request');

  let file = normalize(join(root, decoded));
  if (file !== root && !file.startsWith(root + sep)) return text(res, 404, 'Not found');

  let st = await stat(file).catch(() => null);
  if (st?.isDirectory()) {
    file = join(file, 'index.html');
    st = await stat(file).catch(() => null);
  }
  if (!st?.isFile()) return text(res, 404, 'Not found');

  const headers = {
    'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
    'Cache-Control': cachePolicy(file),
    ETag: `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`,
  };
  if (req.headers['if-none-match'] === headers.ETag) {
    res.writeHead(304, headers);
    return res.end();
  }

  let send = file;
  if (precompressed) {
    headers.Vary = 'Accept-Encoding';
    const accept = req.headers['accept-encoding'] ?? '';
    for (const [enc, ext] of [['br', '.br'], ['gzip', '.gz']]) {
      if (!accept.includes(enc)) continue;
      const cst = await stat(file + ext).catch(() => null);
      if (cst?.isFile()) {
        send = file + ext;
        headers['Content-Encoding'] = enc;
        headers['Content-Length'] = cst.size;
        break;
      }
    }
  }
  if (send === file) headers['Content-Length'] = st.size;

  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();
  createReadStream(send).on('error', () => res.destroy()).pipe(res);
}

function text(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function json(res, body, cache) {
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': cache });
  res.end(JSON.stringify(body));
}

function redirect(res, location) {
  res.writeHead(302, { Location: location, 'Cache-Control': NO_CACHE });
  res.end();
}

server.listen(PORT, () => console.log(`launcher listening on :${PORT}`));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
