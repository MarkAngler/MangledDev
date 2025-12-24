#!/usr/bin/env node

const { startServer } = require('../src/server.js');

// Parse --port or -p argument
function parsePort() {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' || args[i] === '-p') {
      return parseInt(args[i + 1], 10);
    }
    if (args[i].startsWith('--port=')) {
      return parseInt(args[i].split('=')[1], 10);
    }
  }
  return null;
}

const port = parsePort() || parseInt(process.env.PORT || '3000', 10);

startServer(port).then(() => {
  console.log(`MangledDev running at http://localhost:${port}`);
}).catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
