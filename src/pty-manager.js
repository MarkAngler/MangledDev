const pty = require('node-pty');
const { v4: uuidv4 } = require('uuid');
const { loadSessions, saveSessions } = require('./session-store.js');

const OUTPUT_BUFFER_SIZE = 100000;

class PtyManager {
  constructor() {
    this.sessions = new Map();
    this.clients = new Map(); // sessionId -> Set<WebSocket>
    this.onSessionChange = null;
  }

  loadPersistedSessions() {
    const saved = loadSessions();
    for (const s of saved) {
      // Mark old sessions as stopped (PTY process is gone after restart)
      this.sessions.set(s.id, {
        ...s,
        status: 'stopped',
        pty: null,
        outputBuffer: ''
      });
    }
  }

  getSessions() {
    return Array.from(this.sessions.values()).map(s => ({
      id: s.id,
      name: s.name,
      createdAt: s.createdAt,
      status: s.status,
      cols: s.cols,
      rows: s.rows,
      cwd: s.cwd
    }));
  }

  getSession(id) {
    return this.sessions.get(id);
  }

  createSession(name, cols = 80, rows = 24, cwd = null) {
    const id = uuidv4();
    const workingDir = cwd || process.cwd();

    const term = pty.spawn('claude', [], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: workingDir,
      env: { ...process.env, COLORTERM: 'truecolor' }
    });

    const session = {
      id,
      name: name || `claude-${id.slice(0, 8)}`,
      createdAt: new Date().toISOString(),
      status: 'running',
      cols,
      rows,
      cwd: workingDir,
      pty: term,
      outputBuffer: ''
    };

    term.onData((data) => {
      session.outputBuffer += data;
      if (session.outputBuffer.length > OUTPUT_BUFFER_SIZE) {
        session.outputBuffer = session.outputBuffer.slice(-OUTPUT_BUFFER_SIZE);
      }
      this.broadcast(id, { type: 'output', data });
    });

    term.onExit(({ exitCode }) => {
      session.status = 'stopped';
      session.pty = null;
      this.broadcast(id, { type: 'status', status: 'stopped', exitCode });
      this.persist();
    });

    this.sessions.set(id, session);
    this.persist();

    return {
      id: session.id,
      name: session.name,
      createdAt: session.createdAt,
      status: session.status,
      cols: session.cols,
      rows: session.rows,
      cwd: session.cwd
    };
  }

  killSession(id) {
    const session = this.sessions.get(id);
    if (!session) return false;

    if (session.pty) {
      session.pty.kill();
      session.pty = null;
    }
    session.status = 'stopped';
    this.broadcast(id, { type: 'status', status: 'stopped' });
    this.persist();
    return true;
  }

  removeSession(id) {
    const session = this.sessions.get(id);
    if (!session) return false;

    if (session.pty) {
      session.pty.kill();
    }
    this.sessions.delete(id);
    this.clients.delete(id);
    this.persist();
    return true;
  }

  restartSession(id) {
    const session = this.sessions.get(id);
    if (!session) return null;

    if (session.pty) {
      session.pty.kill();
    }

    const term = pty.spawn('claude', [], {
      name: 'xterm-256color',
      cols: session.cols,
      rows: session.rows,
      cwd: session.cwd,
      env: { ...process.env, COLORTERM: 'truecolor' }
    });

    session.pty = term;
    session.status = 'running';
    session.outputBuffer = '';

    term.onData((data) => {
      session.outputBuffer += data;
      if (session.outputBuffer.length > OUTPUT_BUFFER_SIZE) {
        session.outputBuffer = session.outputBuffer.slice(-OUTPUT_BUFFER_SIZE);
      }
      this.broadcast(id, { type: 'output', data });
    });

    term.onExit(({ exitCode }) => {
      session.status = 'stopped';
      session.pty = null;
      this.broadcast(id, { type: 'status', status: 'stopped', exitCode });
      this.persist();
    });

    this.broadcast(id, { type: 'status', status: 'running' });
    this.persist();

    return {
      id: session.id,
      name: session.name,
      status: session.status
    };
  }

  resizeSession(id, cols, rows) {
    const session = this.sessions.get(id);
    if (!session || !session.pty) return false;

    session.cols = cols;
    session.rows = rows;
    session.pty.resize(cols, rows);
    this.persist();
    return true;
  }

  writeToSession(id, data) {
    const session = this.sessions.get(id);
    if (!session || !session.pty) return false;

    session.pty.write(data);
    return true;
  }

  addClient(sessionId, ws) {
    if (!this.clients.has(sessionId)) {
      this.clients.set(sessionId, new Set());
    }
    this.clients.get(sessionId).add(ws);

    // Send buffered history
    const session = this.sessions.get(sessionId);
    if (session && session.outputBuffer) {
      ws.send(JSON.stringify({ type: 'history', data: session.outputBuffer }));
    }
  }

  removeClient(sessionId, ws) {
    const clients = this.clients.get(sessionId);
    if (clients) {
      clients.delete(ws);
    }
  }

  broadcast(sessionId, message) {
    const clients = this.clients.get(sessionId);
    if (!clients) return;

    const data = JSON.stringify(message);
    for (const ws of clients) {
      if (ws.readyState === 1) { // WebSocket.OPEN
        ws.send(data);
      }
    }
  }

  persist() {
    saveSessions(this.getSessions());
  }

  shutdown() {
    for (const session of this.sessions.values()) {
      if (session.pty) {
        session.pty.kill();
      }
    }
  }
}

module.exports = { PtyManager };
