import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const DATA_DIR = process.env.DATA_DIR ?? '/data';

// Versions become directory names and URL segments, so keep them boring.
export const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const appDir = (tool) => join(DATA_DIR, 'apps', tool);
export const versionDir = (tool, version) => join(appDir(tool), version);

export async function readCurrent(tool) {
  try {
    const cur = JSON.parse(await readFile(join(appDir(tool), 'current.json'), 'utf8'));
    if (!VERSION_RE.test(cur.version)) return null;
    if (!(await stat(versionDir(tool, cur.version))).isDirectory()) return null;
    return cur;
  } catch {
    return null;
  }
}

export async function writeCurrent(tool, cur) {
  const dir = appDir(tool);
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, 'current.json.tmp');
  await writeFile(tmp, JSON.stringify(cur));
  await rename(tmp, join(dir, 'current.json'));
}

export async function prune(tool, keep) {
  const cur = await readCurrent(tool);
  const entries = await readdir(appDir(tool), { withFileTypes: true });
  const old = [];
  for (const e of entries) {
    if (!e.isDirectory() || !VERSION_RE.test(e.name) || e.name === cur?.version) continue;
    old.push({ name: e.name, mtime: (await stat(versionDir(tool, e.name))).mtimeMs });
  }
  old.sort((a, b) => b.mtime - a.mtime);
  for (const { name } of old.slice(Math.max(keep - 1, 0))) {
    await rm(versionDir(tool, name), { recursive: true, force: true });
  }
}

// Installed versions other than the current one, newest first.
export async function listOldVersions(tool) {
  const cur = await readCurrent(tool);
  const entries = await readdir(appDir(tool), { withFileTypes: true }).catch(() => []);
  const old = [];
  for (const e of entries) {
    if (!e.isDirectory() || !VERSION_RE.test(e.name) || e.name === cur?.version) continue;
    old.push({ version: e.name, mtime: (await stat(versionDir(tool, e.name))).mtimeMs });
  }
  return old.sort((a, b) => b.mtime - a.mtime).map((o) => o.version);
}
