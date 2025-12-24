#!/usr/bin/env node

const { startServer } = require('../src/server.js');

const port = parseInt(process.env.PORT || '3000', 10);

startServer(port).then(() => {
  console.log(`MangledDev running at http://localhost:${port}`);
}).catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
