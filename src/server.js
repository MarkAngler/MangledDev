const express = require('express');
const http = require('http');
const fs = require('fs');
const { WebSocketServer } = require('ws');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { PtyManager } = require('./pty-manager.js');
const { loadTasks, saveTasks } = require('./task-store.js');
const { scanExtensions } = require('./extension-scanner.js');

const ptyManager = new PtyManager();

function startServer(port) {
  return new Promise((resolve, reject) => {
    const app = express();
    app.use(express.json());
    app.use(express.static(path.join(__dirname, '../public')));

    // REST API
    app.get('/api/sessions', (req, res) => {
      res.json(ptyManager.getSessions());
    });

    app.post('/api/sessions', (req, res) => {
      const { name, cols, rows, cwd, skipPermissions } = req.body;
      try {
        const session = ptyManager.createSession(name, cols, rows, cwd, skipPermissions);
        res.status(201).json(session);
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    app.delete('/api/sessions/:id', (req, res) => {
      const success = ptyManager.removeSession(req.params.id);
      if (success) {
        res.status(204).end();
      } else {
        res.status(404).json({ error: 'Session not found' });
      }
    });

    app.post('/api/sessions/:id/restart', (req, res) => {
      const result = ptyManager.restartSession(req.params.id);
      if (result) {
        res.json(result);
      } else {
        res.status(404).json({ error: 'Session not found' });
      }
    });

    app.post('/api/sessions/:id/stop', (req, res) => {
      const success = ptyManager.killSession(req.params.id);
      if (success) {
        res.json({ success: true });
      } else {
        res.status(404).json({ error: 'Session not found' });
      }
    });

    app.post('/api/sessions/:id/resize', (req, res) => {
      const { cols, rows } = req.body;
      const success = ptyManager.resizeSession(req.params.id, cols, rows);
      if (success) {
        res.json({ success: true });
      } else {
        res.status(404).json({ error: 'Session not found or not running' });
      }
    });

    // Task API endpoints
    let tasks = loadTasks();

    app.get('/api/tasks', (req, res) => {
      res.json(tasks);
    });

    app.post('/api/tasks', (req, res) => {
      const { title, priority, dueDate } = req.body;
      if (!title || !title.trim()) {
        return res.status(400).json({ error: 'Title is required' });
      }

      const task = {
        id: uuidv4(),
        title: title.trim(),
        completed: false,
        priority: priority || 'medium',
        dueDate: dueDate || null,
        order: tasks.length,
        createdAt: new Date().toISOString()
      };

      tasks.push(task);
      saveTasks(tasks);
      res.status(201).json(task);
    });

    app.put('/api/tasks/:id', (req, res) => {
      const task = tasks.find(t => t.id === req.params.id);
      if (!task) {
        return res.status(404).json({ error: 'Task not found' });
      }

      const { title, completed, priority, dueDate } = req.body;
      if (title !== undefined) task.title = title.trim();
      if (completed !== undefined) task.completed = completed;
      if (priority !== undefined) task.priority = priority;
      if (dueDate !== undefined) task.dueDate = dueDate;

      saveTasks(tasks);
      res.json(task);
    });

    app.delete('/api/tasks/:id', (req, res) => {
      const index = tasks.findIndex(t => t.id === req.params.id);
      if (index === -1) {
        return res.status(404).json({ error: 'Task not found' });
      }

      tasks.splice(index, 1);
      tasks.forEach((t, i) => t.order = i);
      saveTasks(tasks);
      res.status(204).end();
    });

    app.post('/api/tasks/reorder', (req, res) => {
      const { taskIds } = req.body;
      if (!Array.isArray(taskIds)) {
        return res.status(400).json({ error: 'taskIds array required' });
      }

      const reordered = [];
      for (const id of taskIds) {
        const task = tasks.find(t => t.id === id);
        if (task) {
          task.order = reordered.length;
          reordered.push(task);
        }
      }

      for (const task of tasks) {
        if (!reordered.includes(task)) {
          task.order = reordered.length;
          reordered.push(task);
        }
      }

      tasks = reordered;
      saveTasks(tasks);
      res.json(tasks);
    });

    // Extensions API endpoint
    app.get('/api/extensions', (req, res) => {
      try {
        const cwd = req.query.cwd || process.cwd();
        const extensions = scanExtensions(cwd);
        res.json(extensions);
      } catch (err) {
        console.error('Error scanning extensions:', err);
        res.status(500).json({ error: err.message });
      }
    });

    // Config file API endpoints
    const isValidConfigPath = (filePath, cwd) => {
      const resolved = path.resolve(cwd, filePath);
      const claudeDir = path.join(cwd, '.claude');
      const claudeMd = path.join(cwd, 'CLAUDE.md');

      // Must be CLAUDE.md at root or within .claude directory
      if (resolved === claudeMd) return true;
      if (resolved.startsWith(claudeDir + path.sep)) return true;
      return false;
    };

    const scanConfigFiles = (cwd) => {
      const files = [];

      // Check for CLAUDE.md
      const claudeMd = path.join(cwd, 'CLAUDE.md');
      files.push({
        path: 'CLAUDE.md',
        type: 'markdown',
        exists: fs.existsSync(claudeMd)
      });

      // Check .claude directory
      const claudeDir = path.join(cwd, '.claude');
      if (fs.existsSync(claudeDir)) {
        // Known config files
        const knownFiles = ['settings.json', 'settings.local.json'];
        for (const file of knownFiles) {
          const filePath = path.join(claudeDir, file);
          files.push({
            path: `.claude/${file}`,
            type: 'json',
            exists: fs.existsSync(filePath)
          });
        }

        // Scan for .md files in .claude root
        try {
          const entries = fs.readdirSync(claudeDir, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.isFile() && entry.name.endsWith('.md')) {
              files.push({
                path: `.claude/${entry.name}`,
                type: 'markdown',
                exists: true
              });
            }
          }
        } catch (err) {
          console.error('Error reading .claude directory:', err);
        }

        // Scan .claude/rules directory
        const rulesDir = path.join(claudeDir, 'rules');
        if (fs.existsSync(rulesDir)) {
          try {
            const entries = fs.readdirSync(rulesDir, { withFileTypes: true });
            for (const entry of entries) {
              if (entry.isFile() && entry.name.endsWith('.md')) {
                files.push({
                  path: `.claude/rules/${entry.name}`,
                  type: 'markdown',
                  exists: true
                });
              }
            }
          } catch (err) {
            console.error('Error reading .claude/rules directory:', err);
          }
        }

        // Scan .claude/commands directory
        const commandsDir = path.join(claudeDir, 'commands');
        if (fs.existsSync(commandsDir)) {
          try {
            const entries = fs.readdirSync(commandsDir, { withFileTypes: true });
            for (const entry of entries) {
              if (entry.isFile() && entry.name.endsWith('.md')) {
                files.push({
                  path: `.claude/commands/${entry.name}`,
                  type: 'markdown',
                  exists: true
                });
              }
            }
          } catch (err) {
            console.error('Error reading .claude/commands directory:', err);
          }
        }
      }

      return files;
    };

    app.get('/api/config/files', (req, res) => {
      try {
        const cwd = process.cwd();
        const files = scanConfigFiles(cwd);
        res.json({ cwd, files });
      } catch (err) {
        console.error('Error scanning config files:', err);
        res.status(500).json({ error: err.message });
      }
    });

    app.get('/api/config/file', (req, res) => {
      try {
        const cwd = process.cwd();
        const filePath = req.query.path;

        if (!filePath) {
          return res.status(400).json({ error: 'path query parameter required' });
        }

        if (!isValidConfigPath(filePath, cwd)) {
          return res.status(403).json({ error: 'Access denied: invalid config path' });
        }

        const fullPath = path.resolve(cwd, filePath);
        if (!fs.existsSync(fullPath)) {
          return res.status(404).json({ error: 'File not found' });
        }

        const content = fs.readFileSync(fullPath, 'utf-8');
        res.json({ path: filePath, content });
      } catch (err) {
        console.error('Error reading config file:', err);
        res.status(500).json({ error: err.message });
      }
    });

    app.put('/api/config/file', (req, res) => {
      try {
        const cwd = process.cwd();
        const { path: filePath, content } = req.body;

        if (!filePath) {
          return res.status(400).json({ error: 'path is required' });
        }

        if (content === undefined) {
          return res.status(400).json({ error: 'content is required' });
        }

        if (!isValidConfigPath(filePath, cwd)) {
          return res.status(403).json({ error: 'Access denied: invalid config path' });
        }

        const fullPath = path.resolve(cwd, filePath);
        fs.writeFileSync(fullPath, content, 'utf-8');
        res.json({ success: true });
      } catch (err) {
        console.error('Error writing config file:', err);
        res.status(500).json({ error: err.message });
      }
    });

    const server = http.createServer(app);
    const wss = new WebSocketServer({ server });

    wss.on('connection', (ws, req) => {
      // URL: /terminals/:sessionId
      const match = req.url.match(/^\/terminals\/([^/]+)/);
      if (!match) {
        ws.close(1008, 'Invalid path');
        return;
      }

      const sessionId = match[1];
      const session = ptyManager.getSession(sessionId);
      if (!session) {
        ws.close(1008, 'Session not found');
        return;
      }

      ptyManager.addClient(sessionId, ws);

      // Send current status
      ws.send(JSON.stringify({ type: 'status', status: session.status }));

      ws.on('message', (msg) => {
        try {
          const parsed = JSON.parse(msg.toString());
          if (parsed.type === 'input') {
            ptyManager.writeToSession(sessionId, parsed.data);
          } else if (parsed.type === 'resize') {
            ptyManager.resizeSession(sessionId, parsed.cols, parsed.rows);
          }
        } catch (err) {
          // Ignore malformed messages
        }
      });

      ws.on('close', () => {
        ptyManager.removeClient(sessionId, ws);
      });
    });

    // Graceful shutdown
    process.on('SIGINT', () => {
      console.log('\nShutting down...');
      ptyManager.shutdown();
      server.close(() => {
        process.exit(0);
      });
    });

    process.on('SIGTERM', () => {
      ptyManager.shutdown();
      server.close(() => {
        process.exit(0);
      });
    });

    // Load persisted sessions
    ptyManager.loadPersistedSessions();

    server.listen(port, (err) => {
      if (err) {
        reject(err);
      } else {
        resolve(server);
      }
    });
  });
}

module.exports = { startServer };
