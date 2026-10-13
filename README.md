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

## Add a tool

Add an entry to [server/tools.json](server/tools.json) with the repo and a regex for the web-build release asset.
