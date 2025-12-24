const fs = require('fs');
const path = require('path');

const SESSIONS_FILE = path.join(process.cwd(), 'sessions.json');

function loadSessions() {
  try {
    if (fs.existsSync(SESSIONS_FILE)) {
      const data = fs.readFileSync(SESSIONS_FILE, 'utf8');
      const parsed = JSON.parse(data);
      return parsed.sessions || [];
    }
  } catch (err) {
    console.error('Error loading sessions:', err.message);
  }
  return [];
}

function saveSessions(sessions) {
  const data = {
    sessions: sessions.map(s => ({
      id: s.id,
      name: s.name,
      createdAt: s.createdAt,
      status: s.status,
      cols: s.cols,
      rows: s.rows,
      cwd: s.cwd
    })),
    lastUpdated: new Date().toISOString()
  };

  try {
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('Error saving sessions:', err.message);
  }
}

module.exports = { loadSessions, saveSessions };
