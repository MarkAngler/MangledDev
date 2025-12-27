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
let largeFilesData = null;
let workflowsData = null;
let workflowPanelVisible = false;
let expandedWorkflows = new Set();
let editingWorkflowId = null;
let dialogSteps = [];
let evaluationsData = null;
let comparisonsData = null;
let behaviorsData = null;
let currentEvalView = 'list';
let evaluationPollingInterval = null;

// Safe terminal fit that ensures integer dimensions
function safeTerminalFit() {
  if (!fitAddon || !terminal) return;
  try {
    const dims = fitAddon.proposeDimensions();
    if (dims && dims.cols > 0 && dims.rows > 0) {
      terminal.resize(Math.floor(dims.cols), Math.floor(dims.rows));
    }
  } catch (e) {
    // Ignore errors when terminal not ready
  }
}

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

// Large files API and rendering
async function fetchLargeFiles(threshold) {
  const res = await fetch(`/api/large-files?threshold=${threshold}`);
  if (!res.ok) {
    throw new Error('Failed to scan files');
  }
  return res.json();
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function renderLargeFiles(data) {
  const results = document.getElementById('large-files-results');

  if (data.files.length === 0) {
    results.innerHTML = `<div class="large-files-summary">No files found with ${data.threshold}+ lines (scanned ${data.scanned} files in ${data.duration}ms)</div>`;
    return;
  }

  let html = `<div class="large-files-summary">Found ${data.files.length} file${data.files.length === 1 ? '' : 's'} with ${data.threshold}+ lines (scanned ${data.scanned} files in ${data.duration}ms)</div>`;
  html += '<table class="large-files-table"><thead><tr><th>File</th><th>Lines</th><th>Size</th></tr></thead><tbody>';

  for (const file of data.files) {
    html += `<tr>
      <td class="file-path">${escapeHtml(file.path)}</td>
      <td class="file-lines">${file.lines.toLocaleString()}</td>
      <td class="file-size">${formatBytes(file.bytes)}</td>
    </tr>`;
  }

  html += '</tbody></table>';
  results.innerHTML = html;
}

async function loadLargeFiles() {
  const results = document.getElementById('large-files-results');
  const threshold = parseInt(document.getElementById('threshold-input').value) || 500;

  results.innerHTML = '<div class="large-files-loading">Scanning files...</div>';

  try {
    largeFilesData = await fetchLargeFiles(threshold);
    renderLargeFiles(largeFilesData);
  } catch (err) {
    results.innerHTML = '<div class="large-files-error">Failed to scan files</div>';
    console.error('Error scanning large files:', err);
  }
}

// Workflow API
async function fetchWorkflows() {
  const res = await fetch('/api/workflows');
  return res.json();
}

async function createWorkflow(name, steps) {
  const res = await fetch('/api/workflows', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, steps })
  });
  return res.json();
}

async function updateWorkflow(id, name, steps) {
  const res = await fetch(`/api/workflows/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, steps })
  });
  return res.json();
}

async function deleteWorkflow(id) {
  await fetch(`/api/workflows/${id}`, { method: 'DELETE' });
}

function renderWorkflowList(workflows) {
  const list = document.getElementById('workflow-list');
  list.innerHTML = '';

  if (!workflows || workflows.length === 0) {
    list.innerHTML = '<div class="workflow-empty">No workflows yet. Click + to create one.</div>';
    return;
  }

  for (const workflow of workflows) {
    const isExpanded = expandedWorkflows.has(workflow.id);
    const item = document.createElement('div');
    item.className = 'workflow-item' + (isExpanded ? ' expanded' : '');
    item.dataset.id = workflow.id;

    const header = document.createElement('div');
    header.className = 'workflow-header';
    header.innerHTML = `
      <span class="workflow-chevron">&#9654;</span>
      <span class="workflow-name">${escapeHtml(workflow.name)}</span>
      <div class="workflow-controls">
        <button class="workflow-edit-btn" title="Edit">&#9998;</button>
        <button class="workflow-delete-btn" title="Delete">&times;</button>
      </div>
    `;

    header.querySelector('.workflow-name').addEventListener('click', (e) => {
      e.stopPropagation();
      toggleWorkflowExpand(workflow.id);
    });

    header.querySelector('.workflow-chevron').addEventListener('click', (e) => {
      e.stopPropagation();
      toggleWorkflowExpand(workflow.id);
    });

    header.querySelector('.workflow-edit-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      openWorkflowDialog(workflow);
    });

    header.querySelector('.workflow-delete-btn').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (confirm(`Delete workflow "${workflow.name}"?`)) {
        await deleteWorkflow(workflow.id);
        expandedWorkflows.delete(workflow.id);
        refreshWorkflows();
      }
    });

    const steps = document.createElement('div');
    steps.className = 'workflow-steps';

    if (workflow.steps && workflow.steps.length > 0) {
      workflow.steps.forEach((step, index) => {
        const stepEl = document.createElement('div');
        stepEl.className = 'workflow-step';
        stepEl.innerHTML = `
          <span class="step-number">${index + 1}.</span>
          <span class="step-label">${escapeHtml(step.label || step.command || 'Unnamed step')}</span>
          <span class="step-insert-icon">&#8629;</span>
        `;
        stepEl.addEventListener('click', () => insertStepCommand(step));
        steps.appendChild(stepEl);
      });
    } else {
      steps.innerHTML = '<div class="workflow-step"><span class="step-label" style="color: #888;">No steps defined</span></div>';
    }

    item.appendChild(header);
    item.appendChild(steps);
    list.appendChild(item);
  }
}

function toggleWorkflowExpand(workflowId) {
  if (expandedWorkflows.has(workflowId)) {
    expandedWorkflows.delete(workflowId);
  } else {
    expandedWorkflows.add(workflowId);
  }
  renderWorkflowList(workflowsData);
}

function insertStepCommand(step) {
  if (!currentWs || currentWs.readyState !== WebSocket.OPEN) {
    alert('No active session. Connect to a session first.');
    return;
  }

  const command = step.command || '';
  if (command) {
    currentWs.send(JSON.stringify({ type: 'input', data: command }));
  }
}

function toggleWorkflowPanel() {
  workflowPanelVisible = !workflowPanelVisible;
  const panel = document.getElementById('workflow-panel');
  const toggleBtn = document.getElementById('workflow-toggle-btn');

  panel.style.display = workflowPanelVisible ? 'flex' : 'none';
  toggleBtn.classList.toggle('active', workflowPanelVisible);

  if (workflowPanelVisible && !workflowsData) {
    refreshWorkflows();
  }

  // Resize terminal when panel toggles
  setTimeout(safeTerminalFit, 50);
}

async function refreshWorkflows() {
  try {
    workflowsData = await fetchWorkflows();
    renderWorkflowList(workflowsData);
  } catch (err) {
    console.error('Error loading workflows:', err);
    document.getElementById('workflow-list').innerHTML = '<div class="workflow-empty">Failed to load workflows</div>';
  }
}

function openWorkflowDialog(workflow = null) {
  editingWorkflowId = workflow ? workflow.id : null;
  document.getElementById('workflow-dialog-title').textContent = workflow ? 'Edit Workflow' : 'New Workflow';
  document.getElementById('workflow-name-input').value = workflow ? workflow.name : '';

  dialogSteps = workflow && workflow.steps ? workflow.steps.map(s => ({ ...s })) : [];
  renderDialogSteps();

  document.getElementById('workflow-dialog').showModal();
}

function renderDialogSteps() {
  const list = document.getElementById('workflow-steps-list');
  list.innerHTML = '';

  dialogSteps.forEach((step, index) => {
    const stepEl = document.createElement('div');
    stepEl.className = 'step-editor';
    stepEl.innerHTML = `
      <div class="step-editor-row">
        <input type="text" placeholder="Step label (e.g., Check status)" value="${escapeHtml(step.label || '')}">
        <button type="button" class="step-remove-btn" title="Remove step">&times;</button>
      </div>
      <textarea placeholder="Command to insert (e.g., /help or a prompt)">${escapeHtml(step.command || '')}</textarea>
    `;

    stepEl.querySelector('input').addEventListener('input', (e) => {
      dialogSteps[index].label = e.target.value;
    });

    stepEl.querySelector('textarea').addEventListener('input', (e) => {
      dialogSteps[index].command = e.target.value;
    });

    stepEl.querySelector('.step-remove-btn').addEventListener('click', () => {
      dialogSteps.splice(index, 1);
      renderDialogSteps();
    });

    list.appendChild(stepEl);
  });
}

function addDialogStep() {
  dialogSteps.push({ label: '', command: '' });
  renderDialogSteps();

  // Scroll to the new step
  const list = document.getElementById('workflow-steps-list');
  list.scrollTop = list.scrollHeight;
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
  document.getElementById('evaluations-area').style.display = view === 'evaluations' ? 'flex' : 'none';
  document.getElementById('extensions-area').style.display = view === 'extensions' ? 'flex' : 'none';
  document.getElementById('config-area').style.display = view === 'config' ? 'flex' : 'none';
  document.getElementById('large-files-area').style.display = view === 'large-files' ? 'flex' : 'none';

  if (view === 'extensions' && !extensionsData) {
    loadExtensions();
  }

  if (view === 'config' && !configFilesData) {
    loadConfigFiles();
  }

  if (view === 'large-files' && !largeFilesData) {
    loadLargeFiles();
  }

  if (view === 'evaluations') {
    loadEvaluations();
    startEvaluationPolling();
  } else {
    stopEvaluationPolling();
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
  safeTerminalFit();

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
    safeTerminalFit();
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

window.addEventListener('resize', safeTerminalFit);

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

// Large files event listeners
document.getElementById('scan-large-files-btn').addEventListener('click', () => {
  largeFilesData = null;
  loadLargeFiles();
});

// Workflow event listeners
document.getElementById('workflow-toggle-btn').addEventListener('click', toggleWorkflowPanel);

document.getElementById('new-workflow-btn').addEventListener('click', () => {
  openWorkflowDialog();
});

document.getElementById('add-step-btn').addEventListener('click', addDialogStep);

document.getElementById('cancel-workflow-btn').addEventListener('click', () => {
  document.getElementById('workflow-dialog').close('cancel');
});

document.getElementById('workflow-dialog').addEventListener('close', async () => {
  if (document.getElementById('workflow-dialog').returnValue === 'cancel') return;

  const name = document.getElementById('workflow-name-input').value.trim();
  if (!name) return;

  // Filter out empty steps
  const steps = dialogSteps.filter(s => s.label.trim() || s.command.trim());

  if (editingWorkflowId) {
    await updateWorkflow(editingWorkflowId, name, steps);
  } else {
    await createWorkflow(name, steps);
  }

  editingWorkflowId = null;
  dialogSteps = [];
  refreshWorkflows();
});

// Evaluation API
async function fetchBehaviors() {
  const res = await fetch('/api/behaviors');
  return res.json();
}

async function fetchEvaluations() {
  const res = await fetch('/api/evaluations');
  return res.json();
}

async function fetchComparisons() {
  const res = await fetch('/api/comparisons');
  return res.json();
}

async function createEvaluation(name, behaviorKey, promptConfig, config) {
  const res = await fetch('/api/evaluations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, behaviorKey, promptConfig, config })
  });
  return res.json();
}

async function deleteEvaluation(id) {
  await fetch(`/api/evaluations/${id}`, { method: 'DELETE' });
}

async function runEvaluation(id) {
  const res = await fetch(`/api/evaluations/${id}/run`, { method: 'POST' });
  return res.json();
}

async function getEvaluationStatus(id) {
  const res = await fetch(`/api/evaluations/${id}/status`);
  return res.json();
}

async function createComparison(name, promptA, promptB, behaviorKey, config) {
  const res = await fetch('/api/comparisons', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, promptA, promptB, behaviorKey, config })
  });
  return res.json();
}

async function runComparison(id) {
  const res = await fetch(`/api/comparisons/${id}/run`, { method: 'POST' });
  return res.json();
}

async function deleteComparison(id) {
  await fetch(`/api/comparisons/${id}`, { method: 'DELETE' });
}

async function loadEvaluations() {
  try {
    [evaluationsData, comparisonsData, behaviorsData] = await Promise.all([
      fetchEvaluations(),
      fetchComparisons(),
      fetchBehaviors()
    ]);
    renderEvaluationsList();
    renderComparisonsList();
  } catch (err) {
    console.error('Error loading evaluations:', err);
  }
}

function startEvaluationPolling() {
  if (evaluationPollingInterval) return;
  evaluationPollingInterval = setInterval(async () => {
    if (currentView === 'evaluations') {
      // Check if viewing detail view of a running evaluation
      const detailView = document.getElementById('evaluation-detail');
      if (detailView && detailView.style.display !== 'none' && currentDetailEvalId) {
        const currentEval = evaluationsData?.find(e => e.id === currentDetailEvalId);
        if (currentEval?.status === 'running') {
          await showEvaluationDetail(currentDetailEvalId);
        }
      } else {
        // List view polling
        const hasRunning = evaluationsData?.some(e => e.status === 'running') ||
                           comparisonsData?.some(c => c.status === 'running');
        if (hasRunning) {
          await loadEvaluations();
        }
      }
    }
  }, 3000);
}

function stopEvaluationPolling() {
  if (evaluationPollingInterval) {
    clearInterval(evaluationPollingInterval);
    evaluationPollingInterval = null;
  }
}

function renderEvaluationsList() {
  const list = document.getElementById('evaluations-list');
  if (!list) return;

  if (!evaluationsData || evaluationsData.length === 0) {
    list.innerHTML = '<div style="color: #888; text-align: center; padding: 40px;">No evaluations yet. Create one to get started.</div>';
    return;
  }

  list.innerHTML = evaluationsData.map(e => {
    const stages = e.stages || {};
    const behavior = behaviorsData?.find(b => b.key === e.behaviorKey);

    return `
      <div class="evaluation-item" data-id="${e.id}">
        <div class="evaluation-item-header">
          <span class="evaluation-name">${escapeHtml(e.name)}</span>
          <div class="evaluation-meta">
            <span class="evaluation-status status-${e.status}">${e.status}</span>
          </div>
        </div>
        <div class="evaluation-behavior">Testing: ${behavior?.description || e.behaviorKey}</div>
        <div class="evaluation-config">Tier: ${e.config?.tier || 'standard'} | Scenarios: ${e.config?.numScenarios || 20}</div>
        <div class="evaluation-stages">
          ${renderStageIndicator('Understanding', stages.understanding)}
          ${renderStageIndicator('Ideation', stages.ideation)}
          ${renderStageIndicator('Rollout', stages.rollout)}
          ${renderStageIndicator('Judgment', stages.judgment)}
        </div>
        ${e.results ? renderEvaluationResults(e.results) : ''}
        <div class="evaluation-actions">
          <button class="run-eval-btn" ${e.status === 'running' || e.status === 'completed' ? 'disabled' : ''}>
            ${e.status === 'running' ? 'Running...' : e.status === 'completed' ? 'Completed' : 'Run'}
          </button>
          <button class="delete-eval-btn">Delete</button>
        </div>
      </div>
    `;
  }).join('');

  // Add event listeners
  list.querySelectorAll('.run-eval-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const item = e.target.closest('.evaluation-item');
      const id = item.dataset.id;
      await runEvaluation(id);
      await loadEvaluations();
    });
  });

  list.querySelectorAll('.delete-eval-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const item = e.target.closest('.evaluation-item');
      const id = item.dataset.id;
      if (confirm('Delete this evaluation?')) {
        await deleteEvaluation(id);
        await loadEvaluations();
      }
    });
  });

  // Add click handler on evaluation names to show detail view
  list.querySelectorAll('.evaluation-name').forEach(name => {
    name.addEventListener('click', (e) => {
      const item = e.target.closest('.evaluation-item');
      const id = item.dataset.id;
      showEvaluationDetail(id);
    });
  });
}

function renderStageIndicator(name, stage) {
  const status = stage?.status || 'pending';
  let progress = 0;
  if (status === 'completed') progress = 100;
  else if (status === 'running' && stage.completed && stage.total) {
    progress = Math.round((stage.completed / stage.total) * 100);
  }

  return `
    <div class="stage-indicator">
      <div class="stage-bar">
        <div class="stage-bar-fill ${status}" style="width: ${progress}%"></div>
      </div>
      <span class="stage-label">${name}</span>
    </div>
  `;
}

function renderEvaluationResults(results) {
  if (!results || results.overallScore === null) return '';

  const score = (results.overallScore * 100).toFixed(0);
  const dist = results.scoreDistribution;

  return `
    <div class="evaluation-results">
      <div class="result-score">${score}%</div>
      ${dist ? `<div class="result-distribution">Range: ${(dist.min * 100).toFixed(0)}% - ${(dist.max * 100).toFixed(0)}% | Std: ${(dist.std * 100).toFixed(1)}%</div>` : ''}
      ${results.keyQuotes?.length ? `
        <div class="result-quotes">
          ${results.keyQuotes.slice(0, 2).map(q => `
            <div class="result-quote">"${escapeHtml(q.quote || q.explanation || JSON.stringify(q))}"</div>
          `).join('')}
        </div>
      ` : ''}
    </div>
  `;
}

// ==================== Evaluation Detail View ====================

let currentDetailEvalId = null;
let currentDetailTab = 'understanding';

async function showEvaluationDetail(id) {
  currentDetailEvalId = id;

  // Fetch full evaluation data
  const res = await fetch(`/api/evaluations/${id}`);
  if (!res.ok) {
    console.error('Failed to fetch evaluation:', res.status);
    return;
  }
  const evaluation = await res.json();

  // Hide list views, show detail
  document.getElementById('evaluations-list').style.display = 'none';
  document.getElementById('comparisons-list').style.display = 'none';
  document.getElementById('evaluation-detail').style.display = 'block';

  // Render detail content
  const content = document.getElementById('evaluation-detail-content');
  const behavior = behaviorsData?.find(b => b.key === evaluation.behaviorKey);

  content.innerHTML = `
    ${renderDetailHeader(evaluation, behavior)}
    <div class="detail-tabs">
      <button class="detail-tab ${currentDetailTab === 'understanding' ? 'active' : ''}" data-tab="understanding">Understanding</button>
      <button class="detail-tab ${currentDetailTab === 'ideation' ? 'active' : ''}" data-tab="ideation">Ideation</button>
      <button class="detail-tab ${currentDetailTab === 'rollout' ? 'active' : ''}" data-tab="rollout">Rollout</button>
      <button class="detail-tab ${currentDetailTab === 'judgment' ? 'active' : ''}" data-tab="judgment">Judgment</button>
      <button class="detail-tab ${currentDetailTab === 'results' ? 'active' : ''}" data-tab="results">Results</button>
    </div>
    <div id="detail-tab-understanding" class="detail-tab-content ${currentDetailTab === 'understanding' ? 'active' : ''}">
      ${renderUnderstandingTab(evaluation.stages?.understanding)}
    </div>
    <div id="detail-tab-ideation" class="detail-tab-content ${currentDetailTab === 'ideation' ? 'active' : ''}">
      ${renderIdeationTab(evaluation.stages?.ideation)}
    </div>
    <div id="detail-tab-rollout" class="detail-tab-content ${currentDetailTab === 'rollout' ? 'active' : ''}">
      ${renderRolloutTab(evaluation.stages?.rollout)}
    </div>
    <div id="detail-tab-judgment" class="detail-tab-content ${currentDetailTab === 'judgment' ? 'active' : ''}">
      ${renderJudgmentTab(evaluation.stages?.judgment)}
    </div>
    <div id="detail-tab-results" class="detail-tab-content ${currentDetailTab === 'results' ? 'active' : ''}">
      ${renderResultsTab(evaluation.results, evaluation.stages?.judgment)}
    </div>
  `;

  // Add tab click handlers
  content.querySelectorAll('.detail-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      switchDetailTab(tab.dataset.tab);
    });
  });

  // Add transcript expand/collapse handlers
  content.querySelectorAll('.transcript-header').forEach(header => {
    header.addEventListener('click', () => {
      const item = header.closest('.transcript-item');
      item.classList.toggle('expanded');
    });
  });
}

function switchDetailTab(tabName) {
  currentDetailTab = tabName;
  document.querySelectorAll('.detail-tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.tab === tabName);
  });
  document.querySelectorAll('.detail-tab-content').forEach(content => {
    content.classList.toggle('active', content.id === `detail-tab-${tabName}`);
  });
}

function renderDetailHeader(evaluation, behavior) {
  const score = evaluation.results?.overallScore;
  const dist = evaluation.results?.scoreDistribution;

  return `
    <div class="detail-header">
      <div class="detail-header-top">
        <div>
          <div class="detail-title">${escapeHtml(evaluation.name)}</div>
          <div class="detail-behavior">${behavior?.description || evaluation.behaviorKey}</div>
        </div>
        ${score !== null && score !== undefined ? `
          <div class="detail-score-large">
            <div class="detail-score-value">${(score * 100).toFixed(0)}%</div>
            <div class="detail-score-label">Overall Score</div>
          </div>
        ` : ''}
      </div>
      <div class="detail-meta">
        <span class="evaluation-status status-${evaluation.status}">${evaluation.status}</span>
        <span>Tier: ${evaluation.config?.tier || 'standard'}</span>
        <span>Scenarios: ${evaluation.config?.numScenarios || 20}</span>
        ${evaluation.createdAt ? `<span>Created: ${new Date(evaluation.createdAt).toLocaleDateString()}</span>` : ''}
      </div>
      ${dist ? `
        <div class="score-distribution-bar">
          <div class="score-distribution-range" style="left: ${dist.min * 100}%; width: ${(dist.max - dist.min) * 100}%"></div>
          <div class="score-distribution-mean" style="left: ${dist.mean * 100}%"></div>
        </div>
        <div class="score-distribution-labels">
          <span>0%</span>
          <span>Min: ${(dist.min * 100).toFixed(0)}%</span>
          <span>Mean: ${(dist.mean * 100).toFixed(0)}%</span>
          <span>Max: ${(dist.max * 100).toFixed(0)}%</span>
          <span>100%</span>
        </div>
      ` : ''}
    </div>
  `;
}

function renderUnderstandingTab(understanding) {
  if (!understanding?.result) {
    return '<div class="detail-empty">Understanding stage not yet completed.</div>';
  }

  const result = understanding.result;

  const renderList = (items) => {
    if (!items || !items.length) return '<p style="color: #666; font-style: italic;">None defined</p>';
    return `<ul class="understanding-list">${items.map(item => `<li>${escapeHtml(typeof item === 'string' ? item : JSON.stringify(item))}</li>`).join('')}</ul>`;
  };

  return `
    ${result.coreDefinition ? `
      <div class="understanding-section">
        <h4>Core Definition</h4>
        <p style="color: #ccc; font-size: 13px; line-height: 1.6;">${escapeHtml(result.coreDefinition)}</p>
      </div>
    ` : ''}
    <div class="understanding-section">
      <h4>Observable Markers</h4>
      ${renderList(result.observableMarkers)}
    </div>
    <div class="understanding-section">
      <h4>Anti-Patterns</h4>
      ${renderList(result.antiPatterns)}
    </div>
    <div class="understanding-section">
      <h4>Success Criteria</h4>
      ${renderList(result.successCriteria)}
    </div>
    <div class="understanding-section">
      <h4>Failure Criteria</h4>
      ${renderList(result.failureCriteria)}
    </div>
    ${result.boundaryConditions ? `
      <div class="understanding-section">
        <h4>Boundary Conditions</h4>
        ${renderList(result.boundaryConditions)}
      </div>
    ` : ''}
  `;
}

function renderIdeationTab(ideation) {
  if (!ideation?.scenarios || ideation.scenarios.length === 0) {
    return '<div class="detail-empty">Ideation stage not yet completed.</div>';
  }

  return `
    <div class="scenario-grid">
      ${ideation.scenarios.map((scenario, idx) => `
        <div class="scenario-card">
          <div class="scenario-card-header">
            <span class="scenario-id">#${idx + 1} ${scenario.id || ''}</span>
            <div class="scenario-badges">
              ${scenario.domain ? `<span class="scenario-badge badge-domain">${escapeHtml(scenario.domain)}</span>` : ''}
              ${scenario.difficulty ? `<span class="scenario-badge badge-difficulty">${escapeHtml(scenario.difficulty)}</span>` : ''}
            </div>
          </div>
          <div class="scenario-prompt">${escapeHtml(scenario.prompt || scenario.description || JSON.stringify(scenario))}</div>
          ${scenario.context ? `<div class="scenario-context">${escapeHtml(scenario.context)}</div>` : ''}
        </div>
      `).join('')}
    </div>
  `;
}

function renderRolloutTab(rollout) {
  if (!rollout?.transcripts || rollout.transcripts.length === 0) {
    return '<div class="detail-empty">Rollout stage not yet completed.</div>';
  }

  return `
    <div class="transcript-list">
      ${rollout.transcripts.map((t, idx) => `
        <div class="transcript-item">
          <div class="transcript-header">
            <div class="transcript-scenario-info">
              <span class="transcript-scenario-id">#${idx + 1} ${t.scenarioId || ''}</span>
              <span class="transcript-turn-count">${t.turnCount || t.transcript?.length || 0} turns</span>
              ${t.completed === false ? '<span style="color: #f44336; font-size: 11px;">incomplete</span>' : ''}
            </div>
            <span class="transcript-chevron">&#9660;</span>
          </div>
          <div class="transcript-content">
            <div class="transcript-messages">
              ${(t.transcript || []).map(msg => `
                <div class="transcript-bubble ${msg.role}">
                  <div class="transcript-bubble-role">${msg.role}</div>
                  ${escapeHtml(msg.content || '')}
                </div>
              `).join('')}
            </div>
          </div>
        </div>
      `).join('')}
    </div>
  `;
}

function renderJudgmentTab(judgment) {
  if (!judgment?.judgments || judgment.judgments.length === 0) {
    return '<div class="detail-empty">Judgment stage not yet completed.</div>';
  }

  return `
    <div class="judgment-grid">
      ${judgment.judgments.map((j, idx) => {
        const scorePercent = (j.score * 100).toFixed(0);
        const scoreClass = j.score >= 0.7 ? 'high' : j.score >= 0.4 ? 'medium' : 'low';

        return `
          <div class="judgment-card">
            <div class="judgment-card-header">
              <span class="judgment-scenario-id">#${idx + 1} ${j.scenarioId || ''}</span>
              <div>
                <span class="judgment-score ${scoreClass}">${scorePercent}%</span>
                ${j.confidence ? `<span class="judgment-confidence">(${(j.confidence * 100).toFixed(0)}% confident)</span>` : ''}
              </div>
            </div>
            ${j.summary ? `<div class="judgment-summary">${escapeHtml(j.summary)}</div>` : ''}
            ${j.positiveEvidence?.length ? `
              <div class="evidence-section">
                <h5 class="positive">Positive Evidence</h5>
                <ul class="evidence-list positive">
                  ${j.positiveEvidence.map(e => `<li>${escapeHtml(typeof e === 'string' ? e : e.explanation || JSON.stringify(e))}</li>`).join('')}
                </ul>
              </div>
            ` : ''}
            ${j.negativeEvidence?.length ? `
              <div class="evidence-section">
                <h5 class="negative">Negative Evidence</h5>
                <ul class="evidence-list negative">
                  ${j.negativeEvidence.map(e => `<li>${escapeHtml(typeof e === 'string' ? e : e.explanation || JSON.stringify(e))}</li>`).join('')}
                </ul>
              </div>
            ` : ''}
          </div>
        `;
      }).join('')}
    </div>
  `;
}

function renderResultsTab(results, judgment) {
  if (!results) {
    return '<div class="detail-empty">Results not yet available.</div>';
  }

  const dist = results.scoreDistribution;
  const validJudgments = judgment?.judgments?.filter(j => j.score !== null && j.score !== undefined) || [];

  return `
    <div class="results-summary">
      <div class="results-stat">
        <div class="results-stat-value">${results.overallScore !== null ? (results.overallScore * 100).toFixed(0) + '%' : 'N/A'}</div>
        <div class="results-stat-label">Overall Score</div>
      </div>
      ${dist ? `
        <div class="results-stat">
          <div class="results-stat-value">${(dist.min * 100).toFixed(0)}% - ${(dist.max * 100).toFixed(0)}%</div>
          <div class="results-stat-label">Score Range</div>
        </div>
        <div class="results-stat">
          <div class="results-stat-value">${(dist.std * 100).toFixed(1)}%</div>
          <div class="results-stat-label">Std Deviation</div>
        </div>
      ` : ''}
      <div class="results-stat">
        <div class="results-stat-value">${validJudgments.length}</div>
        <div class="results-stat-label">Scenarios Judged</div>
      </div>
    </div>

    ${results.keyQuotes?.length ? `
      <div class="results-section">
        <h4>Key Evidence</h4>
        ${results.keyQuotes.map(q => `
          <div class="key-quote-item">
            <div class="key-quote-text">"${escapeHtml(q.quote || q.explanation || JSON.stringify(q))}"</div>
            ${q.scenarioId ? `<div class="key-quote-source">Scenario: ${q.scenarioId}</div>` : ''}
          </div>
        `).join('')}
      </div>
    ` : ''}

    ${results.failurePatterns?.length ? `
      <div class="results-section">
        <h4>Failure Patterns</h4>
        ${results.failurePatterns.map(f => `
          <div class="failure-pattern-item">${escapeHtml(typeof f === 'string' ? f : f.summary || JSON.stringify(f))}</div>
        `).join('')}
      </div>
    ` : ''}
  `;
}

function renderComparisonsList() {
  const list = document.getElementById('comparisons-list');
  if (!list) return;

  if (!comparisonsData || comparisonsData.length === 0) {
    list.innerHTML = '<div style="color: #888; text-align: center; padding: 40px;">No A/B comparisons yet.</div>';
    return;
  }

  list.innerHTML = comparisonsData.map(c => {
    const behavior = behaviorsData?.find(b => b.key === c.behaviorKey);
    const evalA = evaluationsData?.find(e => e.id === c.evaluationA);
    const evalB = evaluationsData?.find(e => e.id === c.evaluationB);

    return `
      <div class="comparison-item" data-id="${c.id}">
        <div class="evaluation-item-header">
          <span class="evaluation-name">${escapeHtml(c.name)}</span>
          <span class="evaluation-status status-${c.status}">${c.status}</span>
        </div>
        <div class="evaluation-behavior">Testing: ${behavior?.description || c.behaviorKey}</div>
        ${c.results ? `
          <div class="comparison-results">
            <div class="comparison-variant ${c.results.winner === 'A' ? 'winner' : ''}">
              <div class="variant-label">Variant A</div>
              <div class="variant-score">${(c.results.scoreA * 100).toFixed(0)}%</div>
            </div>
            <div class="comparison-variant ${c.results.winner === 'B' ? 'winner' : ''}">
              <div class="variant-label">Variant B</div>
              <div class="variant-score">${(c.results.scoreB * 100).toFixed(0)}%</div>
            </div>
          </div>
          <div style="text-align: center; margin-top: 12px; color: #4caf50; font-weight: 600;">
            ${c.results.winner === 'tie' ? 'Tie' : `Winner: Variant ${c.results.winner}`}
          </div>
        ` : ''}
        <div class="evaluation-actions" style="margin-top: 12px;">
          <button class="run-comp-btn" ${c.status === 'running' || c.status === 'completed' ? 'disabled' : ''}>
            ${c.status === 'running' ? 'Running...' : c.status === 'completed' ? 'Completed' : 'Run'}
          </button>
          <button class="delete-eval-btn">Delete</button>
        </div>
      </div>
    `;
  }).join('');

  list.querySelectorAll('.run-comp-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const item = e.target.closest('.comparison-item');
      const id = item.dataset.id;
      await runComparison(id);
      await loadEvaluations();
    });
  });

  list.querySelectorAll('.delete-eval-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const item = e.target.closest('.comparison-item');
      const id = item.dataset.id;
      if (confirm('Delete this comparison?')) {
        await deleteComparison(id);
        await loadEvaluations();
      }
    });
  });
}

function switchEvalView(view) {
  currentEvalView = view;
  document.querySelectorAll('.eval-tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.evalView === view);
  });
  document.getElementById('evaluations-list').style.display = view === 'list' ? 'block' : 'none';
  document.getElementById('comparisons-list').style.display = view === 'comparisons' ? 'block' : 'none';
  document.getElementById('evaluation-detail').style.display = 'none';
}

async function openEvaluationDialog() {
  if (!behaviorsData) {
    behaviorsData = await fetchBehaviors();
  }

  const select = document.getElementById('eval-behavior-input');
  select.innerHTML = behaviorsData.map(b =>
    `<option value="${b.key}">${b.key} - ${b.description.substring(0, 50)}...</option>`
  ).join('');

  document.getElementById('eval-name-input').value = '';
  document.getElementById('eval-prompt-input').value = '';
  document.getElementById('eval-tier-input').value = 'standard';

  document.getElementById('evaluation-dialog').showModal();
}

async function openComparisonDialog() {
  if (!behaviorsData) {
    behaviorsData = await fetchBehaviors();
  }

  const select = document.getElementById('comp-behavior-input');
  select.innerHTML = behaviorsData.map(b =>
    `<option value="${b.key}">${b.key} - ${b.description.substring(0, 50)}...</option>`
  ).join('');

  document.getElementById('comp-name-input').value = '';
  document.getElementById('comp-prompt-a-input').value = '';
  document.getElementById('comp-prompt-b-input').value = '';
  document.getElementById('comp-tier-input').value = 'standard';

  document.getElementById('comparison-dialog').showModal();
}

// Evaluation event listeners
document.getElementById('new-evaluation-btn')?.addEventListener('click', openEvaluationDialog);
document.getElementById('new-comparison-btn')?.addEventListener('click', openComparisonDialog);

document.getElementById('cancel-eval-btn')?.addEventListener('click', () => {
  document.getElementById('evaluation-dialog').close('cancel');
});

document.getElementById('cancel-comp-btn')?.addEventListener('click', () => {
  document.getElementById('comparison-dialog').close('cancel');
});

document.getElementById('evaluation-dialog')?.addEventListener('close', async () => {
  if (document.getElementById('evaluation-dialog').returnValue === 'cancel') return;

  const name = document.getElementById('eval-name-input').value.trim();
  const behaviorKey = document.getElementById('eval-behavior-input').value;
  const systemPrompt = document.getElementById('eval-prompt-input').value.trim();
  const tier = document.getElementById('eval-tier-input').value;

  if (!name) return;

  const promptConfig = systemPrompt ? { systemPrompt } : {};
  await createEvaluation(name, behaviorKey, promptConfig, { tier });
  await loadEvaluations();
});

document.getElementById('comparison-dialog')?.addEventListener('close', async () => {
  if (document.getElementById('comparison-dialog').returnValue === 'cancel') return;

  const name = document.getElementById('comp-name-input').value.trim();
  const behaviorKey = document.getElementById('comp-behavior-input').value;
  const promptA = document.getElementById('comp-prompt-a-input').value.trim();
  const promptB = document.getElementById('comp-prompt-b-input').value.trim();
  const tier = document.getElementById('comp-tier-input').value;

  if (!name || !promptA || !promptB) return;

  const comparison = await createComparison(name, promptA, promptB, behaviorKey, { tier });
  await runComparison(comparison.id);
  await loadEvaluations();
});

document.querySelectorAll('.eval-tab').forEach(tab => {
  tab.addEventListener('click', () => switchEvalView(tab.dataset.evalView));
});

document.getElementById('back-to-list-btn')?.addEventListener('click', () => {
  document.getElementById('evaluation-detail').style.display = 'none';
  document.getElementById('evaluations-list').style.display = currentEvalView === 'list' ? 'block' : 'none';
  document.getElementById('comparisons-list').style.display = currentEvalView === 'comparisons' ? 'block' : 'none';
});

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  initTerminal();
  refreshSessions();
  refreshTasks();
});
