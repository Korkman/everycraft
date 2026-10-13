# AGENTS.md

EveryCraft is an unofficial container launcher for the ArtCraft Crafting Apps (the `*craft` repos under https://github.com/storytold). It serves their WebAssembly builds and keeps them current from GitHub releases. Never use the ArtCraft name, wordmark or logos as EveryCraft branding; the start page and README carry a non-affiliation notice that must stay.

## Requirements

- The start page shows one button per tool. Clicking it opens the installed version immediately and checks for a newer release in the background on the server; the update applies on the next launch. Failures are only logged.
  - With nothing installed, show "Please wait while your app is installed", then open the tool. Only a failed first install reports an error.
- Behave like a PWA: the start page and any visited tool version must open offline.
- Updates are checked only on click. No background polling.
- Node.js 22, no npm dependencies. The runtime needs the `unzip` binary.
- Local development uses Podman (`podman compose up --build`). The image must stay OCI-standard and also run under Docker.
- `compose.yaml` sets `network_mode: bridge` on purpose: per-project Podman networks need `aardvark-dns`, which may not be installed.

## Structure

```
Containerfile, compose.yaml   Image build and local run (port 8080, volume `everycraft-data` at /data)
server/
  index.js      HTTP server: routing, static serving, caching headers, SSE streams
  updater.js    GitHub release check, download, SHA256 verify, unzip, brotli, jobs
  store.js      Paths and current.json handling under DATA_DIR (default /data)
  tools.json    Tool registry: id -> name, description, repo, asset regex
web/            Start page, launcher.js, service worker (sw.js), manifest, icon
```

Add a tool by adding an entry to `server/tools.json`; its release must publish a `<name>-web-<version>.zip` asset (ideally with `SHA256SUMS.txt`). Nothing else changes.

## Data layout

`/data/apps/<tool>/<version>/` holds an extracted site. `/data/apps/<tool>/current.json` holds `{version, installedAt, checkedAt}`.

- Installs extract to a `.tmp-*` directory and are renamed into place, so a half-finished update never becomes current.
- Compressible files are stored only as `.br`; the plain copy is deleted. The server sends `.br` to clients that accept it and decompresses on the fly for the rest. There is no gzip.
- `KEEP_VERSIONS` (3) versions are kept per tool; older ones are pruned after a real update. On-demand downloads of old versions do not change `current.json` and do not prune.

## HTTP API

- `GET /api/tools`: tool list.
- `GET /api/launch/:tool`: SSE stream of `checking` / `updating` / `ready` / `failed`. `updating` includes `previousUrl` when an older version is installed. `ready` includes `url`.
- `GET /api/install/:tool/:version`: same stream, for downloading one specific release without activating it.
- `GET /api/versions[?remote=1]`: up to three previous versions per installed tool. `remote=1` fills from GitHub releases (cached 1 hour) and marks which are already installed.
- `GET /apps/:tool/` redirects to the current version. `GET /apps/:tool/:version/*` serves files.
- `GET /healthz`.

## Caching rules

- Files under `/apps/<tool>/<version>/` are `public, max-age=31536000, immutable`, except `index.html` and `manifest.txt`, which are `no-cache`.
- Launcher files and the `/apps/<tool>/` redirect are `no-cache`; `/api/*` is `no-store`.
- `.wasm` must be served as `application/wasm`. The tools need no COOP/COEP headers; do not add `X-Frame-Options` or a restrictive `frame-ancestors`.
- `web/sw.js`: tool versions are cache-first (they are immutable). The start page, `/api/tools` and `/api/versions` are network-first with a 3 s timeout when a cached copy exists. `/api/launch` and `/api/install` are never cached.

## Conventions and pitfalls

- Version strings come from release tags and become directory names and URL segments. Always validate with `VERSION_RE` from `store.js`. Block path traversal when serving files.
- Updates for a tool are single-flight: concurrent clicks share one job.
- The first release check waits up to 30 s when nothing is installed (no fallback), 3 s otherwise.
- All tools share one origin, so they share `localStorage`.
- Set `GITHUB_TOKEN` to raise the unauthenticated GitHub API limit (60 requests/hour).
- Bump the `shell-v1` / `apps-v1` cache names in `web/sw.js` only for incompatible cache changes; the activate step deletes other cache names.

## Run and check

```sh
podman compose up --build          # http://localhost:8080/
node --check server/*.js web/*.js  # quick syntax check
DATA_DIR=/tmp/ec PORT=18080 node server/index.js   # run without a container
```

There is no test suite; verify by exercising the endpoints with `curl` (for example `curl -N localhost:18080/api/launch/photocraft`).
