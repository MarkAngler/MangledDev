let terminal = null;
let fitAddon = null;
let currentWs = null;
let currentSessionId = null;

async function fetchSessions() {
  const res = await fetch('/api/sessions');
  return res.json();
}

async function createSession(name) {
  const res = await fetch('/api/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      cols: terminal ? terminal.cols : 80,
      rows: terminal ? terminal.rows : 24
    })
  });
  return res.json();
}

async function deleteSession(id) {
  await fetch(`/api/sessions/${id}`, { method: 'DELETE' });
}

async function restartSession(id) {
  const res = await fetch(`/api/sessions/${id}/restart`, { method: 'POST' });
  return res.json();
}

function renderSessionList(sessions) {
  const list = document.getElementById('session-list');
  list.innerHTML = '';

  for (const session of sessions) {
    const item = document.createElement('div');
    item.className = 'session-item' + (session.id === currentSessionId ? ' active' : '');
    item.dataset.id = session.id;

    const statusClass = session.status === 'running' ? 'status-running' : 'status-stopped';
    item.innerHTML = `
      <span class="session-status ${statusClass}"></span>
      <span class="session-name">${escapeHtml(session.name)}</span>
      <button class="delete-btn" title="Delete">&times;</button>
    `;

    item.querySelector('.session-name').addEventListener('click', () => {
      connectToSession(session.id, session.name);
    });

    item.querySelector('.delete-btn').addEventListener('click', async (e) => {
      e.stopPropagation();
      await deleteSession(session.id);
      if (session.id === currentSessionId) {
        disconnectCurrent();
      }
      refreshSessions();
    });

    list.appendChild(item);
  }
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function initTerminal() {
  const container = document.getElementById('terminal-container');
  container.innerHTML = '';

  terminal = new Terminal({
    cursorBlink: true,
    fontSize: 14,
    fontFamily: 'Menlo, Monaco, "Courier New", monospace',
    theme: {
      background: '#1e1e1e',
      foreground: '#d4d4d4'
    }
  });

  fitAddon = new FitAddon.FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.open(container);
  fitAddon.fit();

  terminal.onData((data) => {
    if (currentWs && currentWs.readyState === WebSocket.OPEN) {
      currentWs.send(JSON.stringify({ type: 'input', data }));
    }
  });

  terminal.onResize(({ cols, rows }) => {
    if (currentWs && currentWs.readyState === WebSocket.OPEN) {
      currentWs.send(JSON.stringify({ type: 'resize', cols, rows }));
    }
  });
}

function disconnectCurrent() {
  if (currentWs) {
    currentWs.close();
    currentWs = null;
  }
  currentSessionId = null;
  document.getElementById('current-session-name').textContent = 'Select a session';
  document.getElementById('session-controls').style.display = 'none';

  if (terminal) {
    terminal.clear();
  }

  document.querySelectorAll('.session-item').forEach(el => el.classList.remove('active'));
}

function connectToSession(sessionId, sessionName) {
  if (currentSessionId === sessionId) return;

  disconnectCurrent();
  currentSessionId = sessionId;

  if (!terminal) {
    initTerminal();
  } else {
    terminal.clear();
  }

  document.getElementById('current-session-name').textContent = sessionName;
  document.getElementById('session-controls').style.display = 'flex';

  document.querySelectorAll('.session-item').forEach(el => {
    el.classList.toggle('active', el.dataset.id === sessionId);
  });

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/terminals/${sessionId}`;
  currentWs = new WebSocket(wsUrl);

  currentWs.onopen = () => {
    fitAddon.fit();
    currentWs.send(JSON.stringify({
      type: 'resize',
      cols: terminal.cols,
      rows: terminal.rows
    }));
  };

  currentWs.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === 'output' || msg.type === 'history') {
        terminal.write(msg.data);
      } else if (msg.type === 'status') {
        refreshSessions();
      }
    } catch (err) {
      // Ignore malformed messages
    }
  };

  currentWs.onclose = () => {
    if (currentSessionId === sessionId) {
      refreshSessions();
    }
  };
}

async function refreshSessions() {
  const sessions = await fetchSessions();
  renderSessionList(sessions);
}

// Event listeners
document.getElementById('new-session-btn').addEventListener('click', () => {
  document.getElementById('session-name-input').value = '';
  document.getElementById('new-session-dialog').showModal();
});

document.getElementById('cancel-dialog-btn').addEventListener('click', () => {
  document.getElementById('new-session-dialog').close('cancel');
});

document.getElementById('new-session-dialog').addEventListener('close', async () => {
  if (document.getElementById('new-session-dialog').returnValue === 'cancel') return;

  const name = document.getElementById('session-name-input').value.trim();
  const session = await createSession(name || undefined);
  await refreshSessions();
  connectToSession(session.id, session.name);
});

document.getElementById('restart-btn').addEventListener('click', async () => {
  if (!currentSessionId) return;
  terminal.clear();
  await restartSession(currentSessionId);
  refreshSessions();
});

document.getElementById('stop-btn').addEventListener('click', async () => {
  if (!currentSessionId) return;
  await fetch(`/api/sessions/${currentSessionId}/stop`, { method: 'POST' });
  refreshSessions();
});

window.addEventListener('resize', () => {
  if (fitAddon) {
    fitAddon.fit();
  }
});

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  initTerminal();
  refreshSessions();
});
