import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { constants, createBrotliCompress } from 'node:zlib';
import { appDir, listOldVersions, prune, readCurrent, versionDir, VERSION_RE, writeCurrent } from './store.js';

const run = promisify(execFile);

const CHECK_TTL_MS = 5 * 60_000;
const CHECK_TIMEOUT_MS = 3_000;
// With nothing installed there is no fallback, so wait for slow container networks.
const FIRST_CHECK_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const KEEP_VERSIONS = 3;
export const PREVIOUS_COUNT = 3;
const RELEASES_TTL_MS = 60 * 60_000;
const REMOTE_TIMEOUT_MS = 5_000;
const TAG_TIMEOUT_MS = 30_000;
const COMPRESSIBLE = new Set(['.wasm', '.js', '.html', '.css', '.json', '.txt', '.svg']);
const BROTLI_LEVEL = 9;

const jobs = new Map();
const releaseCache = new Map();

// Joins the running job for a key or starts one; never rejects.
function startJob(key, work) {
  const running = jobs.get(key);
  if (running) return running;

  const job = { state: 'checking', version: null, previousVersion: null, error: null, listeners: new Set() };
  job.set = (state, extra = {}) => {
    Object.assign(job, { state }, extra);
    for (const l of [...job.listeners]) l(job);
  };
  jobs.set(key, job);

  work(job)
    .catch((err) => {
      console.error(`[${key}] unexpected error:`, err);
      job.set('failed', { error: err.message });
    })
    .finally(() => jobs.delete(key));
  return job;
}

export const launch = (id, tool) => startJob(id, (job) => update(id, tool, job));

// Downloads one specific release without making it the current version.
export const installVersion = (id, tool, version) =>
  startJob(`${id}@${version}`, (job) => installOld(id, tool, version, job));

async function installOld(id, tool, version, job) {
  if (!VERSION_RE.test(version)) throw new Error('invalid version');
  const cur = await readCurrent(id);
  if (cur?.version === version || (await listOldVersions(id)).includes(version)) {
    return job.set('ready', { version });
  }
  job.set('updating', { version });
  const rel = toRelease(tool, await ghJson(`/repos/${tool.repo}/releases/tags/${encodeURIComponent(version)}`, TAG_TIMEOUT_MS));
  await install(id, rel, { activate: false });
  job.set('ready', { version });
}

// Up to `count` releases older than the installed one; installed ones are marked so the UI can skip the download.
export async function previousVersions(id, tool, remote, count = PREVIOUS_COUNT) {
  const cur = await readCurrent(id);
  if (!cur) return [];
  const old = await listOldVersions(id);
  if (remote) {
    try {
      const tags = await releaseTags(tool);
      const idx = tags.indexOf(cur.version);
      // A current version missing from the list is not comparable, so offer the newest others.
      const older = idx >= 0 ? tags.slice(idx + 1) : tags.filter((t) => t !== cur.version);
      return older.slice(0, count).map((version) => ({ version, installed: old.includes(version) }));
    } catch (err) {
      console.warn(`[${id}] release list failed: ${err.message}`);
    }
  }
  return old.slice(0, count).map((version) => ({ version, installed: true }));
}

async function releaseTags(tool) {
  const hit = releaseCache.get(tool.repo);
  if (hit && Date.now() - hit.at < RELEASES_TTL_MS) return hit.tags;
  const list = await ghJson(`/repos/${tool.repo}/releases?per_page=30`, REMOTE_TIMEOUT_MS);
  const pattern = new RegExp(tool.asset);
  const tags = list
    .filter((r) => !r.draft && !r.prerelease && VERSION_RE.test(r.tag_name ?? '') && r.assets?.some((a) => pattern.test(a.name)))
    .map((r) => r.tag_name);
  releaseCache.set(tool.repo, { at: Date.now(), tags });
  return tags;
}

async function update(id, tool, job) {
  const cur = await readCurrent(id);
  job.previousVersion = cur?.version ?? null;
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

async function ghJson(path, timeoutMs) {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'everycraft' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

  const res = await fetch(`https://api.github.com${path}`, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`GitHub API responded ${res.status}`);
  return res.json();
}

const fetchLatest = async (tool, timeoutMs) =>
  toRelease(tool, await ghJson(`/repos/${tool.repo}/releases/latest`, timeoutMs));

function toRelease(tool, rel) {
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

async function install(id, latest, { activate = true } = {}) {
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
    if (activate) {
      const now = Date.now();
      await writeCurrent(id, { version: latest.version, installedAt: now, checkedAt: now });
      await prune(id, KEEP_VERSIONS);
    }
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
      params: { [constants.BROTLI_PARAM_QUALITY]: BROTLI_LEVEL, [constants.BROTLI_PARAM_SIZE_HINT]: size },
    });
    await pipeline(createReadStream(file), brotli, createWriteStream(`${file}.br`));
    await rm(file);
  }
}
