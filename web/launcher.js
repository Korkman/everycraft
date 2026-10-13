const grid = document.getElementById('tools');
const overlay = document.getElementById('overlay');
const message = document.getElementById('message');
const spinner = document.getElementById('spinner');
const dismiss = document.getElementById('dismiss');
const skip = document.getElementById('skip');

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js');

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
    const btn = document.createElement('button');
    btn.className = 'tool';
    btn.innerHTML = '<strong></strong><span></span>';
    btn.querySelector('strong').textContent = tool.name;
    btn.querySelector('span').textContent = tool.description;
    btn.addEventListener('click', () => launch(tool));
    grid.append(btn);
  }
} catch {
  grid.textContent = 'The launcher server is unreachable.';
}

const oldSection = document.getElementById('old');
const oldList = document.getElementById('old-list');
let oldLoaded = false;

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
      const a = document.createElement('a');
      a.href = v.url;
      if (v.installed) {
        a.textContent = v.version;
      } else {
        a.textContent = `\u2193 ${v.version}`;
        a.title = 'Downloaded when opened';
        a.addEventListener('click', (e) => {
          e.preventDefault();
          show(`Starting ${tool.name} ${v.version}…`);
          follow(`/api/install/${encodeURIComponent(tool.id)}/${encodeURIComponent(v.version)}`,
            { id: tool.id, name: `${tool.name} ${v.version}` }, { remember: false, verb: 'downloaded' });
        });
      }
      row.append(a);
    }
    oldList.append(row);
  }
}

// Release lists come from GitHub, so they load only when the section is opened.
oldSection.addEventListener('toggle', async () => {
  if (!oldSection.open || oldLoaded) return;
  oldList.innerHTML = '<p class="empty">Loading previous versions…</p>';
  try {
    renderOld(await (await fetch('/api/versions?remote=1')).json());
    oldLoaded = true;
  } catch {
    oldList.innerHTML = '<p class="empty">The launcher server is unreachable.</p>';
  }
});
