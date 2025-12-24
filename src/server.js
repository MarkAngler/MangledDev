const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const { PtyManager } = require('./pty-manager.js');

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
      const { name, cols, rows, cwd } = req.body;
      try {
        const session = ptyManager.createSession(name, cols, rows, cwd);
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
