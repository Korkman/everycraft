const grid = document.getElementById('tools');
const overlay = document.getElementById('overlay');
const message = document.getElementById('message');
const spinner = document.getElementById('spinner');
const dismiss = document.getElementById('dismiss');

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js');

function show(text) {
  overlay.hidden = false;
  spinner.hidden = false;
  dismiss.hidden = true;
  message.textContent = text;
}

function fail(text) {
  spinner.hidden = true;
  dismiss.hidden = false;
  message.textContent = text;
}

dismiss.addEventListener('click', () => {
  overlay.hidden = true;
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
  let finished = false;
  const es = new EventSource(`/api/launch/${encodeURIComponent(tool.id)}`);

  es.onmessage = (e) => {
    const s = JSON.parse(e.data);
    if (s.state === 'checking') show('Checking for updates…');
    else if (s.state === 'updating') show(`Please wait while ${tool.name} is updated…`);
    else if (s.state === 'ready') {
      finished = true;
      es.close();
      open(tool.id, s.url);
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
    const last = localStorage.getItem(`last:${tool.id}`);
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
