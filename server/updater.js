import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { constants, createBrotliCompress, createGzip } from 'node:zlib';
import { appDir, prune, readCurrent, versionDir, VERSION_RE, writeCurrent } from './store.js';

const run = promisify(execFile);

const CHECK_TTL_MS = 5 * 60_000;
const CHECK_TIMEOUT_MS = 3_000;
// With nothing installed there is no fallback, so wait for slow container networks.
const FIRST_CHECK_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const KEEP_VERSIONS = 2;
const COMPRESSIBLE = new Set(['.wasm', '.js', '.html', '.css', '.json', '.txt', '.svg']);

const jobs = new Map();

// Joins the running job for a tool or starts one; never rejects.
export function launch(id, tool) {
  const running = jobs.get(id);
  if (running) return running;

  const job = { state: 'checking', version: null, error: null, listeners: new Set() };
  job.set = (state, extra = {}) => {
    Object.assign(job, { state }, extra);
    for (const l of [...job.listeners]) l(job);
  };
  jobs.set(id, job);

  update(id, tool, job)
    .catch((err) => {
      console.error(`[${id}] unexpected error:`, err);
      job.set('failed', { error: err.message });
    })
    .finally(() => jobs.delete(id));
  return job;
}

async function update(id, tool, job) {
  const cur = await readCurrent(id);
  // Any failure after this point falls back to the installed version.
  const fallback = (err) => {
    console.warn(`[${id}] update failed: ${err.message}`);
    if (cur) job.set('ready', { version: cur.version });
    else job.set('failed', { error: err.message });
  };

  if (cur && Date.now() - cur.checkedAt < CHECK_TTL_MS) {
    return job.set('ready', { version: cur.version });
  }

  let latest;
  try {
    latest = await fetchLatest(tool, cur ? CHECK_TIMEOUT_MS : FIRST_CHECK_TIMEOUT_MS);
  } catch (err) {
    return fallback(err);
  }

  if (cur?.version === latest.version) {
    await writeCurrent(id, { ...cur, checkedAt: Date.now() });
    return job.set('ready', { version: cur.version });
  }

  job.set('updating', { version: latest.version });
  try {
    await install(id, latest);
    job.set('ready', { version: latest.version });
  } catch (err) {
    fallback(err);
  }
}

async function fetchLatest(tool, timeoutMs) {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'everycraft' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

  const res = await fetch(`https://api.github.com/repos/${tool.repo}/releases/latest`, {
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`GitHub API responded ${res.status}`);
  const rel = await res.json();

  if (!VERSION_RE.test(rel.tag_name ?? '')) throw new Error(`unusable release tag ${rel.tag_name}`);
  const pattern = new RegExp(tool.asset);
  const asset = rel.assets?.find((a) => pattern.test(a.name));
  if (!asset) throw new Error(`release ${rel.tag_name} has no asset matching ${tool.asset}`);
  const sums = rel.assets.find((a) => a.name === 'SHA256SUMS.txt');

  return {
    version: rel.tag_name,
    assetName: asset.name,
    url: asset.browser_download_url,
    sumsUrl: sums?.browser_download_url ?? null,
  };
}

async function install(id, latest) {
  const tmp = join(appDir(id), `.tmp-${randomBytes(4).toString('hex')}`);
  await mkdir(tmp, { recursive: true });
  try {
    const zip = join(tmp, 'asset.zip');
    await download(latest.url, zip);
    if (latest.sumsUrl) await verify(zip, latest);

    const out = join(tmp, 'out');
    await mkdir(out);
    await run('unzip', ['-q', zip, '-d', out]);

    const root = await siteRoot(out);
    await precompress(root);

    const dest = versionDir(id, latest.version);
    await rm(dest, { recursive: true, force: true });
    await rename(root, dest);
    const now = Date.now();
    await writeCurrent(id, { version: latest.version, installedAt: now, checkedAt: now });
    await prune(id, KEEP_VERSIONS);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function download(url, file) {
  const res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!res.ok || !res.body) throw new Error(`download responded ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(file));
}

async function verify(file, latest) {
  const res = await fetch(latest.sumsUrl, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`SHA256SUMS.txt responded ${res.status}`);
  const line = (await res.text())
    .split('\n')
    .map((l) => l.trim().split(/\s+/))
    .find(([, name]) => name?.replace(/^\*/, '') === latest.assetName);
  if (!line) throw new Error(`SHA256SUMS.txt has no entry for ${latest.assetName}`);

  const hash = createHash('sha256');
  await pipeline(createReadStream(file), hash);
  if (hash.digest('hex') !== line[0].toLowerCase()) throw new Error('checksum mismatch');
}

// The zip holds either the site directly or a single wrapper folder.
async function siteRoot(dir) {
  const has = (d) => stat(join(d, 'index.html')).then(() => true, () => false);
  if (await has(dir)) return dir;
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.isDirectory() && (await has(join(dir, e.name)))) return join(dir, e.name);
  }
  throw new Error('archive contains no index.html');
}

async function precompress(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const file = join(dir, e.name);
    if (e.isDirectory()) {
      await precompress(file);
      continue;
    }
    const ext = e.name.slice(e.name.lastIndexOf('.'));
    const { size } = await stat(file);
    if (!COMPRESSIBLE.has(ext) || size < 1024) continue;

    const brotli = createBrotliCompress({
      params: { [constants.BROTLI_PARAM_QUALITY]: 9, [constants.BROTLI_PARAM_SIZE_HINT]: size },
    });
    await pipeline(createReadStream(file), brotli, createWriteStream(`${file}.br`));
    await pipeline(createReadStream(file), createGzip({ level: 9 }), createWriteStream(`${file}.gz`));
  }
}
