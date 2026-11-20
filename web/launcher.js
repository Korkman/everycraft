const grid = document.getElementById('tools');
const overlay = document.getElementById('overlay');
const message = document.getElementById('message');
const spinner = document.getElementById('spinner');
const dismiss = document.getElementById('dismiss');
const skip = document.getElementById('skip');

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js');

// Only orders the download menu, so a wrong guess just leaves the default order.
function detectPlatform() {
  const ua = navigator.userAgent;
  const hint = navigator.userAgentData?.platform ?? '';
  let os = null;
  if (/windows/i.test(hint) || /Windows/.test(ua)) os = 'windows';
  else if (/mac/i.test(hint) || /Macintosh/.test(ua)) os = 'macos';
  else if ((/linux/i.test(hint) || /Linux/.test(ua)) && !/Android/.test(ua)) os = 'linux';
  return { os, arch: /aarch64|arm64/i.test(ua) ? 'arm64' : 'x64' };
}

const platform = detectPlatform();
// Windows user agents always say x64, so ask for the real architecture where supported.
navigator.userAgentData?.getHighEntropyValues(['architecture'])
  .then(({ architecture }) => {
    if (architecture) platform.arch = architecture.startsWith('arm') ? 'arm64' : 'x64';
  })
  .catch(() => {});

// Current-OS downloads come first, matching architecture ahead of the rest; other platforms follow alphabetically.
function sortForPlatform(list) {
  const archRank = (p) => (p.arch === platform.arch || p.arch === 'universal' ? 0 : 1);
  const own = list.filter((p) => p.os === platform.os).sort((a, b) => archRank(a) - archRank(b));
  const rest = list.filter((p) => p.os !== platform.os).sort((a, b) => a.label.localeCompare(b.label));
  return [...own, ...rest];
}

function closeMenus() {
  for (const menu of document.querySelectorAll('.tool-menu')) menu.hidden = true;
  for (const toggle of document.querySelectorAll('[aria-expanded]')) toggle.setAttribute('aria-expanded', 'false');
}

function bindMenu(toggle, menu, onOpen) {
  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    const wasOpen = !menu.hidden;
    closeMenus();
    if (!wasOpen) {
      menu.hidden = false;
      toggle.setAttribute('aria-expanded', 'true');
      onOpen?.();
    }
  });
}

function menuLink(href, text, { external = false } = {}) {
  const a = document.createElement('a');
  a.setAttribute('role', 'menuitem');
  a.href = href;
  a.textContent = text;
  if (external) {
    a.target = '_blank';
    a.rel = 'noopener';
  }
  return a;
}

function menuNote(text) {
  const p = document.createElement('p');
  p.className = 'menu-note';
  p.textContent = text;
  return p;
}

// Lazily fetches per-platform links from `endpoint` on each load(); falls back to `fallbackUrl` on error.
function downloadMenu(endpoint, fallbackUrl) {
  const list = document.createElement('div');
  list.className = 'menu-downloads';
  let links = null;
  let request = null;
  const fetchLinks = () => {
    request ??= fetch(endpoint)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((data) => (links = data))
      .catch((err) => {
        request = null;
        throw err;
      });
    return request;
  };
  const load = async () => {
    list.replaceChildren(menuNote('Loading downloads…'));
    try {
      const data = links ?? (await fetchLinks());
      list.replaceChildren(
        ...sortForPlatform(data.platforms).map((p) => menuLink(p.url, p.label, { external: true })),
        menuLink(data.other, 'Other platforms', { external: true }),
      );
    } catch {
      list.replaceChildren(menuLink(fallbackUrl, 'Download from GitHub', { external: true }));
    }
  };
  return { list, load };
}

document.addEventListener('click', closeMenus);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeMenus();
});

function show(text) {
  overlay.hidden = false;
  spinner.hidden = false;
  dismiss.hidden = true;
  skip.hidden = true;
  message.textContent = text;
}

function fail(text) {
  spinner.hidden = true;
  dismiss.hidden = false;
  skip.hidden = true;
  message.textContent = text;
}

dismiss.addEventListener('click', () => {
  overlay.hidden = true;
});

// Back navigation restores this page from the bfcache with the overlay still showing.
window.addEventListener('pageshow', (e) => {
  if (e.persisted) overlay.hidden = true;
});

// Last known URL lets a tool open from the service worker cache when the server is unreachable.
function open(id, url) {
  localStorage.setItem(`last:${id}`, url);
  const prefix = `/apps/${id}/`;
  navigator.serviceWorker?.controller?.postMessage({ type: 'prune', prefix, keep: url });
  location.assign(url);
}

function launch(tool) {
  show(`Starting ${tool.name}…`);
  follow(`/api/launch/${encodeURIComponent(tool.id)}`, tool, { remember: true, verb: 'updated' });
}

// Remembered launches fall back to the last used URL when the server is unreachable.
function follow(streamUrl, tool, { remember, verb }) {
  let finished = false;
  const es = new EventSource(streamUrl);

  es.onmessage = (e) => {
    const s = JSON.parse(e.data);
    if (s.state === 'checking') show('Checking for updates…');
    else if (s.state === 'updating') {
      show(`Please wait while ${tool.name} is ${verb}…`);
      if (s.previousUrl) {
        skip.textContent = `Skip and open ${s.previousVersion}`;
        skip.onclick = () => {
          finished = true;
          es.close();
          open(tool.id, s.previousUrl);
        };
        skip.hidden = false;
      }
    } else if (s.state === 'ready') {
      finished = true;
      es.close();
      if (remember) open(tool.id, s.url);
      else location.assign(s.url);
    } else if (s.state === 'failed') {
      finished = true;
      es.close();
      fail(`${tool.name} could not be installed: ${s.error}`);
    }
  };

  es.onerror = () => {
    if (finished) return;
    finished = true;
    es.close();
    const last = remember && localStorage.getItem(`last:${tool.id}`);
    if (last) location.assign(last);
    else fail('The launcher server is unreachable and no local copy exists.');
  };
}

try {
  const tools = await (await fetch('/api/tools')).json();
  for (const tool of tools) {
    const split = document.createElement('div');
    split.className = 'tool-split';

    const link = document.createElement('a');
    link.className = 'tool';
    link.href = `/?launch=${encodeURIComponent(tool.id)}`;
    link.innerHTML = '<strong></strong><span></span>';
    const img = document.createElement('img');
    img.className = 'tool-icon';
    img.alt = '';
    img.src = tool.icon ?? '/placeholder.svg';
    link.prepend(img);
    link.querySelector('strong').textContent = tool.name;
    link.querySelector('span').textContent = tool.description;
    split.append(link);

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'tool-more';
    toggle.setAttribute('aria-label', `More options for ${tool.name}`);
    toggle.setAttribute('aria-haspopup', 'menu');
    toggle.setAttribute('aria-expanded', 'false');
    toggle.textContent = '\u25BE';

    const menu = document.createElement('div');
    menu.className = 'tool-menu';
    menu.setAttribute('role', 'menu');
    menu.hidden = true;
    const run = menuLink(link.href, 'Run in browser');
    const label = document.createElement('div');
    label.className = 'menu-label';
    label.textContent = 'Download';
    const downloads = downloadMenu(`/api/downloads/${encodeURIComponent(tool.id)}`, `https://github.com/${tool.repo}`);
    menu.append(run, label, downloads.list);

    bindMenu(toggle, menu, downloads.load);
    split.append(toggle, menu);

    // Modified and middle clicks are left to the browser, which opens the link in a new tab.
    const launchOnClick = (a) => a.addEventListener('click', (e) => {
      if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      closeMenus();
      launch(tool);
    });
    launchOnClick(link);
    launchOnClick(run);

    grid.append(split);
  }

  const requested = new URLSearchParams(location.search).get('launch');
  if (requested) {
    history.replaceState(null, '', '/');
    const tool = tools.find((t) => t.id === requested);
    if (tool) launch(tool);
    else fail(`Unknown tool: ${requested}`);
  }
} catch {
  grid.textContent = 'The launcher server is unreachable.';
}

const oldList = document.getElementById('old-list');

function renderOld(tools) {
  oldList.textContent = '';
  if (!tools.length) {
    oldList.innerHTML = '<p class="empty">No previous versions found.</p>';
    return;
  }
  for (const tool of tools) {
    const row = document.createElement('div');
    row.className = 'row';
    const name = document.createElement('strong');
    name.textContent = tool.name;
    row.append(name);
    for (const v of tool.versions) {
      const wrap = document.createElement('span');
      wrap.className = 'version';

      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'version-chip';
      chip.setAttribute('aria-haspopup', 'menu');
      chip.setAttribute('aria-expanded', 'false');
      chip.textContent = v.installed ? v.version : `\u2193 ${v.version}`;
      if (!v.installed) chip.title = 'Downloaded when opened';

      const menu = document.createElement('div');
      menu.className = 'tool-menu';
      menu.setAttribute('role', 'menu');
      menu.hidden = true;
      const run = menuLink(v.url, 'Run in browser');
      if (!v.installed) {
        run.addEventListener('click', (e) => {
          e.preventDefault();
          closeMenus();
          show(`Starting ${tool.name} ${v.version}…`);
          follow(`/api/install/${encodeURIComponent(tool.id)}/${encodeURIComponent(v.version)}`,
            { id: tool.id, name: `${tool.name} ${v.version}` }, { remember: false, verb: 'downloaded' });
        });
      }
      const label = document.createElement('div');
      label.className = 'menu-label';
      label.textContent = 'Download';
      const downloads = downloadMenu(
        `/api/downloads/${encodeURIComponent(tool.id)}?version=${encodeURIComponent(v.version)}`,
        `https://github.com/${tool.repo}/releases/tag/${encodeURIComponent(v.version)}`,
      );
      menu.append(run, label, downloads.list);

      bindMenu(chip, menu, downloads.load);
      wrap.append(chip, menu);
      row.append(wrap);
    }
    oldList.append(row);
  }
}

// The service worker keeps the last response, so the list is also available offline.
async function loadOld() {
  try {
    renderOld(await (await fetch('/api/versions?remote=1')).json());
  } catch {
    oldList.innerHTML = '<p class="empty">The launcher server is unreachable.</p>';
  }
}

loadOld();
