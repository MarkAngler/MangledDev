let terminal = null;
let fitAddon = null;
let currentWs = null;
let currentSessionId = null;
let taskPanelCollapsed = false;
let editingTaskId = null;
let currentView = 'sessions';
let extensionsData = null;
let configFilesData = null;
let currentConfigFile = null;
let originalConfigContent = null;
let configModified = false;

async function fetchSessions() {
  const res = await fetch('/api/sessions');
  return res.json();
}

async function createSession(name, skipPermissions = false) {
  const res = await fetch('/api/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      cols: terminal ? terminal.cols : 80,
      rows: terminal ? terminal.rows : 24,
      skipPermissions
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

// Task API
async function fetchTasks() {
  const res = await fetch('/api/tasks');
  return res.json();
}

async function createTask(title, priority, dueDate) {
  const res = await fetch('/api/tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, priority, dueDate: dueDate || null })
  });
  return res.json();
}

async function updateTask(id, updates) {
  const res = await fetch(`/api/tasks/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates)
  });
  return res.json();
}

async function deleteTask(id) {
  await fetch(`/api/tasks/${id}`, { method: 'DELETE' });
}

async function reorderTasks(taskIds) {
  const res = await fetch('/api/tasks/reorder', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ taskIds })
  });
  return res.json();
}

function formatDueDate(dateStr) {
  const date = new Date(dateStr + 'T00:00:00');
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const taskDate = new Date(dateStr + 'T00:00:00');
  taskDate.setHours(0, 0, 0, 0);

  if (taskDate.getTime() === today.getTime()) return 'Today';
  if (taskDate.getTime() === tomorrow.getTime()) return 'Tomorrow';

  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function renderTaskList(tasks) {
  const list = document.getElementById('task-list');
  list.innerHTML = '';

  const sorted = [...tasks].sort((a, b) => a.order - b.order);

  for (let i = 0; i < sorted.length; i++) {
    const task = sorted[i];
    const item = document.createElement('div');
    item.className = 'task-item' + (task.completed ? ' completed' : '');
    item.dataset.id = task.id;

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const isOverdue = task.dueDate && new Date(task.dueDate + 'T00:00:00') < today && !task.completed;
    const dueDateStr = task.dueDate ? formatDueDate(task.dueDate) : '';

    item.innerHTML = `
      <input type="checkbox" class="task-checkbox" ${task.completed ? 'checked' : ''}>
      <span class="task-title">${escapeHtml(task.title)}</span>
      <span class="task-priority priority-${task.priority}">${task.priority}</span>
      ${dueDateStr ? `<span class="task-due ${isOverdue ? 'overdue' : ''}">${dueDateStr}</span>` : ''}
      <div class="task-controls">
        <button class="task-move-btn" data-dir="up" title="Move Up" ${i === 0 ? 'disabled' : ''}>&#9650;</button>
        <button class="task-move-btn" data-dir="down" title="Move Down" ${i === sorted.length - 1 ? 'disabled' : ''}>&#9660;</button>
        <button class="task-delete-btn" title="Delete">&times;</button>
      </div>
    `;

    item.querySelector('.task-checkbox').addEventListener('change', async (e) => {
      await updateTask(task.id, { completed: e.target.checked });
      refreshTasks();
    });

    item.querySelector('.task-title').addEventListener('click', () => {
      openTaskDialog(task);
    });

    item.querySelectorAll('.task-move-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const dir = btn.dataset.dir;
        await moveTask(task.id, dir, sorted);
      });
    });

    item.querySelector('.task-delete-btn').addEventListener('click', async (e) => {
      e.stopPropagation();
      await deleteTask(task.id);
      refreshTasks();
    });

    list.appendChild(item);
  }
}

async function moveTask(taskId, direction, sortedTasks) {
  const currentIndex = sortedTasks.findIndex(t => t.id === taskId);
  const newIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1;

  if (newIndex < 0 || newIndex >= sortedTasks.length) return;

  const ids = sortedTasks.map(t => t.id);
  [ids[currentIndex], ids[newIndex]] = [ids[newIndex], ids[currentIndex]];

  await reorderTasks(ids);
  refreshTasks();
}

function openTaskDialog(task = null) {
  editingTaskId = task ? task.id : null;
  document.getElementById('task-dialog-title').textContent = task ? 'Edit Task' : 'New Task';
  document.getElementById('task-title-input').value = task ? task.title : '';
  document.getElementById('task-priority-input').value = task ? task.priority : 'medium';
  document.getElementById('task-due-input').value = task && task.dueDate ? task.dueDate : '';
  document.getElementById('task-dialog').showModal();
}

async function refreshTasks() {
  const tasks = await fetchTasks();
  renderTaskList(tasks);
}

// Extensions API and rendering
async function fetchExtensions() {
  const res = await fetch('/api/extensions');
  return res.json();
}

function renderExtensions(data) {
  const grid = document.getElementById('extensions-grid');
  const loading = document.getElementById('extensions-loading');

  loading.style.display = 'none';
  grid.innerHTML = '';

  const scopes = [
    { key: 'personal', title: 'Personal (~/.claude/)' },
    { key: 'project', title: 'Project (.claude/)' }
  ];

  const categories = [
    { key: 'plugins', name: 'Plugins' },
    { key: 'skills', name: 'Skills' },
    { key: 'agents', name: 'Agents' },
    { key: 'commands', name: 'Commands' },
    { key: 'mcpServers', name: 'MCP Servers' },
    { key: 'hooks', name: 'Hooks' }
  ];

  let hasAnyData = false;

  for (const scope of scopes) {
    const scopeData = data[scope.key];
    const hasAny = categories.some(c => scopeData[c.key]?.length > 0);
    if (!hasAny) continue;

    hasAnyData = true;

    const scopeEl = document.createElement('div');
    scopeEl.className = 'extensions-scope';
    scopeEl.innerHTML = `<div class="scope-title">${escapeHtml(scope.title)}</div>`;

    for (const cat of categories) {
      const items = scopeData[cat.key] || [];
      if (items.length === 0) continue;
      const catEl = renderCategory(cat, items);
      scopeEl.appendChild(catEl);
    }

    grid.appendChild(scopeEl);
  }

  if (!hasAnyData) {
    grid.innerHTML = '<div class="empty-category">No Claude Code extensions found</div>';
  }
}

function renderCategory(category, items) {
  const catEl = document.createElement('div');
  catEl.className = 'extensions-category';

  const header = document.createElement('div');
  header.className = 'category-header';
  header.innerHTML = `
    <span class="category-name">${escapeHtml(category.name)}</span>
    <span class="category-count">${items.length}</span>
    <span class="category-chevron">&#9662;</span>
  `;

  const list = document.createElement('div');
  list.className = 'extensions-list';

  for (const item of items) {
    list.appendChild(renderExtensionItem(category.key, item));
  }

  header.addEventListener('click', () => {
    header.classList.toggle('collapsed');
    list.classList.toggle('collapsed');
  });

  catEl.appendChild(header);
  catEl.appendChild(list);
  return catEl;
}

function renderExtensionItem(type, item) {
  const el = document.createElement('div');
  el.className = 'extension-item';

  let html = `<div class="extension-name">${escapeHtml(item.name || 'Unnamed')}</div>`;

  if (item.version) {
    html += `<div class="extension-meta">v${escapeHtml(item.version)}</div>`;
  }
  if (item.marketplace) {
    html += `<div class="extension-meta">${escapeHtml(item.marketplace)}</div>`;
  }
  if (item.source && item.source !== 'project' && item.source !== 'personal') {
    html += `<div class="extension-meta">From: ${escapeHtml(item.source)}</div>`;
  }
  if (item.type) {
    html += `<div class="extension-meta">Type: ${escapeHtml(item.type)}</div>`;
  }
  if (item.event) {
    html += `<div class="extension-meta">Event: ${escapeHtml(item.event)}</div>`;
  }
  if (item.description) {
    html += `<div class="extension-description">${escapeHtml(item.description)}</div>`;
  }

  el.innerHTML = html;
  return el;
}

// Config API and rendering
async function fetchConfigFiles() {
  const res = await fetch('/api/config/files');
  return res.json();
}

async function fetchConfigFile(filePath) {
  const res = await fetch(`/api/config/file?path=${encodeURIComponent(filePath)}`);
  if (!res.ok) {
    throw new Error('Failed to load file');
  }
  return res.json();
}

async function saveConfigFile(filePath, content) {
  const res = await fetch('/api/config/file', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: filePath, content })
  });
  if (!res.ok) {
    throw new Error('Failed to save file');
  }
  return res.json();
}

function renderConfigFiles(data) {
  const list = document.getElementById('config-file-list');
  list.innerHTML = '';

  if (!data.files || data.files.length === 0) {
    list.innerHTML = '<div class="config-empty-message">No config files found</div>';
    return;
  }

  for (const file of data.files) {
    const item = document.createElement('div');
    const isDisabled = !file.exists;
    item.className = 'config-file-item' + (currentConfigFile === file.path ? ' active' : '') + (isDisabled ? ' disabled' : '');
    item.dataset.path = file.path;

    item.innerHTML = `
      <span class="config-file-icon ${file.exists ? 'exists' : 'missing'}"></span>
      <span class="config-file-path">${escapeHtml(file.path)}</span>
    `;

    if (!isDisabled) {
      item.addEventListener('click', () => selectConfigFile(file.path));
    }

    list.appendChild(item);
  }
}

async function selectConfigFile(filePath) {
  if (configModified && currentConfigFile !== filePath) {
    const discard = confirm('You have unsaved changes. Discard them?');
    if (!discard) return;
  }

  try {
    const data = await fetchConfigFile(filePath);
    currentConfigFile = filePath;
    originalConfigContent = data.content;
    configModified = false;

    document.getElementById('config-file-name').textContent = filePath;
    document.getElementById('config-file-name').classList.remove('modified');
    document.getElementById('config-editor').value = data.content;
    document.getElementById('config-controls').style.display = 'flex';

    document.querySelectorAll('.config-file-item').forEach(el => {
      el.classList.toggle('active', el.dataset.path === filePath);
    });
  } catch (err) {
    console.error('Error loading config file:', err);
    alert('Failed to load file: ' + err.message);
  }
}

function handleConfigInput() {
  const editor = document.getElementById('config-editor');
  const wasModified = configModified;
  configModified = editor.value !== originalConfigContent;

  if (configModified !== wasModified) {
    document.getElementById('config-file-name').classList.toggle('modified', configModified);
  }
}

async function handleConfigSave() {
  if (!currentConfigFile) return;

  try {
    const content = document.getElementById('config-editor').value;
    await saveConfigFile(currentConfigFile, content);
    originalConfigContent = content;
    configModified = false;
    document.getElementById('config-file-name').classList.remove('modified');
  } catch (err) {
    console.error('Error saving config file:', err);
    alert('Failed to save file: ' + err.message);
  }
}

function handleConfigDiscard() {
  if (!currentConfigFile) return;

  document.getElementById('config-editor').value = originalConfigContent;
  configModified = false;
  document.getElementById('config-file-name').classList.remove('modified');
}

async function loadConfigFiles() {
  try {
    configFilesData = await fetchConfigFiles();
    renderConfigFiles(configFilesData);
  } catch (err) {
    console.error('Error loading config files:', err);
    document.getElementById('config-file-list').innerHTML = '<div class="config-empty-message">Failed to load config files</div>';
  }
}

function switchView(view) {
  if (currentView === 'config' && configModified && view !== 'config') {
    const discard = confirm('You have unsaved changes. Discard them?');
    if (!discard) return;
    configModified = false;
  }

  currentView = view;

  document.querySelectorAll('.view-tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.view === view);
  });

  document.getElementById('terminal-area').style.display = view === 'sessions' ? 'flex' : 'none';
  document.getElementById('extensions-area').style.display = view === 'extensions' ? 'flex' : 'none';
  document.getElementById('config-area').style.display = view === 'config' ? 'flex' : 'none';

  if (view === 'extensions' && !extensionsData) {
    loadExtensions();
  }

  if (view === 'config' && !configFilesData) {
    loadConfigFiles();
  }
}

async function loadExtensions() {
  document.getElementById('extensions-loading').style.display = 'block';
  document.getElementById('extensions-grid').innerHTML = '';

  try {
    extensionsData = await fetchExtensions();
    renderExtensions(extensionsData);
  } catch (err) {
    document.getElementById('extensions-loading').textContent = 'Failed to load extensions';
    console.error('Error loading extensions:', err);
  }
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
  document.getElementById('skip-permissions-input').checked = false;
  document.getElementById('new-session-dialog').showModal();
});

document.getElementById('cancel-dialog-btn').addEventListener('click', () => {
  document.getElementById('new-session-dialog').close('cancel');
});

document.getElementById('new-session-dialog').addEventListener('close', async () => {
  if (document.getElementById('new-session-dialog').returnValue === 'cancel') return;

  const name = document.getElementById('session-name-input').value.trim();
  const skipPermissions = document.getElementById('skip-permissions-input').checked;
  const session = await createSession(name || undefined, skipPermissions);
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

// Task event listeners
document.getElementById('task-toggle-btn').addEventListener('click', () => {
  taskPanelCollapsed = !taskPanelCollapsed;
  document.getElementById('task-list').classList.toggle('collapsed', taskPanelCollapsed);
  document.getElementById('task-toggle-icon').classList.toggle('collapsed', taskPanelCollapsed);
});

document.getElementById('new-task-btn').addEventListener('click', () => {
  openTaskDialog();
});

document.getElementById('cancel-task-btn').addEventListener('click', () => {
  document.getElementById('task-dialog').close('cancel');
});

document.getElementById('task-dialog').addEventListener('close', async () => {
  if (document.getElementById('task-dialog').returnValue === 'cancel') return;

  const title = document.getElementById('task-title-input').value.trim();
  const priority = document.getElementById('task-priority-input').value;
  const dueDate = document.getElementById('task-due-input').value || null;

  if (!title) return;

  if (editingTaskId) {
    await updateTask(editingTaskId, { title, priority, dueDate });
  } else {
    await createTask(title, priority, dueDate);
  }

  editingTaskId = null;
  refreshTasks();
});

window.addEventListener('resize', () => {
  if (fitAddon) {
    fitAddon.fit();
  }
});

// View tab event listeners
document.querySelectorAll('.view-tab').forEach(tab => {
  tab.addEventListener('click', () => switchView(tab.dataset.view));
});

document.getElementById('refresh-extensions-btn').addEventListener('click', () => {
  extensionsData = null;
  loadExtensions();
});

// Config event listeners
document.getElementById('config-editor').addEventListener('input', handleConfigInput);
document.getElementById('save-config-btn').addEventListener('click', handleConfigSave);
document.getElementById('discard-config-btn').addEventListener('click', handleConfigDiscard);

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  initTerminal();
  refreshSessions();
  refreshTasks();
});
