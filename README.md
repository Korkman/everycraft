# EveryCraft

Unofficial container launcher for the ArtCraft Crafting Apps. It serves their web builds and keeps them up to date from GitHub releases.

> EveryCraft is an unofficial community project. It is not affiliated with or endorsed by the ArtCraft team. The Crafting Apps and the ArtCraft name belong to their respective owners. Updates are checked only when a tool is started; if the check or download fails, the installed version is used.

## Run (Podman)

```sh
podman compose up --build
# or
podman build -t everycraft -f Containerfile .
podman run --rm -p 8080:8080 -v everycraft-data:/data everycraft
```

Open <http://localhost:8080/>. Installed tools live in the `everycraft-data` volume. Set `GITHUB_TOKEN` to raise the GitHub API rate limit. Docker works the same way (`docker compose up --build`).

## HTTPS

Serve EveryCraft over HTTPS (or from `http://localhost`, which browsers treat as secure). The tools and the offline install depend on a secure context:

- The service worker, and with it offline use, is only available in a secure context.
- WebGPU and the clipboard need one; over plain HTTP the tools fall back to WebGL2 and lose clipboard access.
- Browser storage such as OPFS (used by LightCraft) needs one, and it is tied to the origin. Moving to another scheme, host or port starts with empty tool data.

The container speaks plain HTTP on port 8080, so put a TLS-terminating reverse proxy in front of it for anything other than local use. Do not reach it over `http://` via a LAN IP or hostname.

## Add a tool

Add an entry to [server/tools.json](server/tools.json) with the repo and a regex for the web-build release asset.
