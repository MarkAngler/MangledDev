const express = require('express');
const http = require('http');
const fs = require('fs');
const readline = require('readline');
const { WebSocketServer } = require('ws');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { PtyManager } = require('./pty-manager.js');
const { loadTasks, saveTasks } = require('./task-store.js');
const { loadWorkflows, saveWorkflows } = require('./workflow-store.js');
const { scanExtensions } = require('./extension-scanner.js');
const evaluationStore = require('./evaluation-store.js');
const { runEvaluation, getEvaluationStatus, getTierConfig } = require('./evaluation-runner.js');

// Large files scanner configuration
const IGNORE_DIRS = ['node_modules', '.git', 'dist', 'build', '.next', 'coverage', '__pycache__', '.venv', '.cache', 'vendor'];
const BINARY_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.ico', '.pdf', '.zip', '.tar', '.gz', '.exe', '.dll', '.so', '.dylib', '.woff', '.woff2', '.ttf', '.eot', '.mp3', '.mp4', '.wav', '.avi', '.mov'];

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

    // Workflow API endpoints
    let workflows = loadWorkflows();

    app.get('/api/workflows', (req, res) => {
      res.json(workflows);
    });

    app.post('/api/workflows', (req, res) => {
      const { name, steps } = req.body;
      if (!name || !name.trim()) {
        return res.status(400).json({ error: 'Name is required' });
      }

      const workflow = {
        id: uuidv4(),
        name: name.trim(),
        steps: (steps || []).map(s => ({
          id: uuidv4(),
          label: s.label || '',
          command: s.command || ''
        })),
        createdAt: new Date().toISOString()
      };

      workflows.push(workflow);
      saveWorkflows(workflows);
      res.status(201).json(workflow);
    });

    app.put('/api/workflows/:id', (req, res) => {
      const workflow = workflows.find(w => w.id === req.params.id);
      if (!workflow) {
        return res.status(404).json({ error: 'Workflow not found' });
      }

      const { name, steps } = req.body;
      if (name !== undefined) workflow.name = name.trim();
      if (steps !== undefined) {
        workflow.steps = steps.map(s => ({
          id: s.id || uuidv4(),
          label: s.label || '',
          command: s.command || ''
        }));
      }

      saveWorkflows(workflows);
      res.json(workflow);
    });

    app.delete('/api/workflows/:id', (req, res) => {
      const index = workflows.findIndex(w => w.id === req.params.id);
      if (index === -1) {
        return res.status(404).json({ error: 'Workflow not found' });
      }

      workflows.splice(index, 1);
      saveWorkflows(workflows);
      res.status(204).end();
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

    // Large files scanner functions
    const countLines = (filePath) => {
      return new Promise((resolve, reject) => {
        let count = 0;
        const stream = fs.createReadStream(filePath);
        const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

        rl.on('line', () => count++);
        rl.on('close', () => resolve(count));
        rl.on('error', reject);
        stream.on('error', reject);
      });
    };

    const scanLargeFiles = async (cwd, threshold) => {
      const startTime = Date.now();
      const largeFiles = [];
      let scannedCount = 0;

      const scan = async (dir) => {
        let entries;
        try {
          entries = await fs.promises.readdir(dir, { withFileTypes: true });
        } catch (err) {
          return; // Skip directories we can't read
        }

        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          const relativePath = path.relative(cwd, fullPath);

          if (entry.isDirectory()) {
            if (!IGNORE_DIRS.includes(entry.name)) {
              await scan(fullPath);
            }
            continue;
          }

          // Skip binary files
          const ext = path.extname(entry.name).toLowerCase();
          if (BINARY_EXTS.includes(ext)) continue;

          // Count lines
          try {
            scannedCount++;
            const stats = await fs.promises.stat(fullPath);
            const lines = await countLines(fullPath);

            if (lines >= threshold) {
              largeFiles.push({
                path: relativePath,
                lines,
                bytes: stats.size
              });
            }
          } catch (err) {
            // Skip files we can't read
          }
        }
      };

      await scan(cwd);

      // Sort by line count descending
      largeFiles.sort((a, b) => b.lines - a.lines);

      return {
        threshold,
        cwd,
        files: largeFiles,
        scanned: scannedCount,
        duration: Date.now() - startTime
      };
    };

    // Large files API endpoint
    app.get('/api/large-files', async (req, res) => {
      const threshold = parseInt(req.query.threshold) || 500;
      try {
        const result = await scanLargeFiles(process.cwd(), threshold);
        res.json(result);
      } catch (err) {
        console.error('Large files scan error:', err);
        res.status(500).json({ error: 'Scan failed' });
      }
    });

    // Behaviors API
    app.get('/api/behaviors', (req, res) => {
      res.json(evaluationStore.getBehaviors());
    });

    app.post('/api/behaviors', (req, res) => {
      const { key, description } = req.body;
      if (!key || !description) {
        return res.status(400).json({ error: 'key and description are required' });
      }
      try {
        const behavior = evaluationStore.addBehavior(key, description);
        res.status(201).json(behavior);
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    });

    // Evaluations API
    app.get('/api/evaluations', (req, res) => {
      res.json(evaluationStore.getEvaluations());
    });

    app.get('/api/evaluations/:id', (req, res) => {
      const evaluation = evaluationStore.getEvaluation(req.params.id);
      if (!evaluation) {
        return res.status(404).json({ error: 'Evaluation not found' });
      }
      res.json(evaluation);
    });

    app.post('/api/evaluations', (req, res) => {
      const { name, behaviorKey, promptConfig, config } = req.body;
      if (!name || !behaviorKey) {
        return res.status(400).json({ error: 'name and behaviorKey are required' });
      }

      // Validate behavior exists
      const behaviors = evaluationStore.getBehaviors();
      if (!behaviors.some(b => b.key === behaviorKey)) {
        return res.status(400).json({ error: `Invalid behaviorKey: ${behaviorKey}` });
      }

      const tierConfig = getTierConfig(config?.tier || 'standard');
      const evaluation = {
        id: uuidv4(),
        name,
        behaviorKey,
        promptConfig: promptConfig || {},
        config: {
          tier: config?.tier || 'standard',
          numScenarios: config?.numScenarios || tierConfig.numScenarios,
          numJudges: config?.numJudges || tierConfig.numJudges,
          maxTurns: config?.maxTurns || tierConfig.maxTurns,
          diversity: config?.diversity || 0.5
        },
        status: 'pending',
        stages: {
          understanding: { status: 'pending' },
          ideation: { status: 'pending' },
          rollout: { status: 'pending' },
          judgment: { status: 'pending' }
        },
        results: null,
        createdAt: new Date().toISOString()
      };

      evaluationStore.createEvaluation(evaluation);
      res.status(201).json(evaluation);
    });

    app.delete('/api/evaluations/:id', (req, res) => {
      const success = evaluationStore.deleteEvaluation(req.params.id);
      if (!success) {
        return res.status(404).json({ error: 'Evaluation not found' });
      }
      res.status(204).end();
    });

    app.post('/api/evaluations/:id/run', async (req, res) => {
      const evaluation = evaluationStore.getEvaluation(req.params.id);
      if (!evaluation) {
        return res.status(404).json({ error: 'Evaluation not found' });
      }
      if (evaluation.status === 'running') {
        return res.status(400).json({ error: 'Evaluation is already running' });
      }

      // Start evaluation asynchronously
      res.json({ message: 'Evaluation started', id: evaluation.id });

      // Run in background (don't await)
      runEvaluation(req.params.id).catch(err => {
        console.error(`Evaluation ${req.params.id} failed:`, err);
      });
    });

    app.get('/api/evaluations/:id/status', (req, res) => {
      const status = getEvaluationStatus(req.params.id);
      if (!status) {
        return res.status(404).json({ error: 'Evaluation not found' });
      }
      res.json(status);
    });

    // Comparisons API
    app.get('/api/comparisons', (req, res) => {
      res.json(evaluationStore.getComparisons());
    });

    app.get('/api/comparisons/:id', (req, res) => {
      const comparison = evaluationStore.getComparison(req.params.id);
      if (!comparison) {
        return res.status(404).json({ error: 'Comparison not found' });
      }
      res.json(comparison);
    });

    app.post('/api/comparisons', async (req, res) => {
      const { name, promptA, promptB, behaviorKey, config } = req.body;
      if (!name || !promptA || !promptB || !behaviorKey) {
        return res.status(400).json({ error: 'name, promptA, promptB, and behaviorKey are required' });
      }

      // Create two evaluations for A/B comparison
      const tierConfig = getTierConfig(config?.tier || 'standard');
      const baseConfig = {
        tier: config?.tier || 'standard',
        numScenarios: config?.numScenarios || tierConfig.numScenarios,
        numJudges: config?.numJudges || tierConfig.numJudges,
        maxTurns: config?.maxTurns || tierConfig.maxTurns,
        diversity: config?.diversity || 0.5
      };

      const evalA = {
        id: uuidv4(),
        name: `${name} - Variant A`,
        behaviorKey,
        promptConfig: { systemPrompt: promptA, name: 'A' },
        config: baseConfig,
        status: 'pending',
        stages: {
          understanding: { status: 'pending' },
          ideation: { status: 'pending' },
          rollout: { status: 'pending' },
          judgment: { status: 'pending' }
        },
        createdAt: new Date().toISOString()
      };

      const evalB = {
        id: uuidv4(),
        name: `${name} - Variant B`,
        behaviorKey,
        promptConfig: { systemPrompt: promptB, name: 'B' },
        config: baseConfig,
        status: 'pending',
        stages: {
          understanding: { status: 'pending' },
          ideation: { status: 'pending' },
          rollout: { status: 'pending' },
          judgment: { status: 'pending' }
        },
        createdAt: new Date().toISOString()
      };

      evaluationStore.createEvaluation(evalA);
      evaluationStore.createEvaluation(evalB);

      const comparison = {
        id: uuidv4(),
        name,
        evaluationA: evalA.id,
        evaluationB: evalB.id,
        behaviorKey,
        status: 'pending',
        results: null,
        createdAt: new Date().toISOString()
      };

      evaluationStore.createComparison(comparison);
      res.status(201).json(comparison);
    });

    app.post('/api/comparisons/:id/run', async (req, res) => {
      const comparison = evaluationStore.getComparison(req.params.id);
      if (!comparison) {
        return res.status(404).json({ error: 'Comparison not found' });
      }
      if (comparison.status === 'running') {
        return res.status(400).json({ error: 'Comparison is already running' });
      }

      evaluationStore.updateComparison(req.params.id, { status: 'running' });
      res.json({ message: 'Comparison started', id: comparison.id });

      // Run both evaluations (could be parallelized, but sequential for simplicity)
      try {
        await runEvaluation(comparison.evaluationA);
        await runEvaluation(comparison.evaluationB);

        // Compare results
        const evalA = evaluationStore.getEvaluation(comparison.evaluationA);
        const evalB = evaluationStore.getEvaluation(comparison.evaluationB);

        const scoreA = evalA?.results?.overallScore || 0;
        const scoreB = evalB?.results?.overallScore || 0;

        const results = {
          winner: scoreA > scoreB ? 'A' : scoreB > scoreA ? 'B' : 'tie',
          scoreA,
          scoreB,
          difference: Math.abs(scoreA - scoreB)
        };

        evaluationStore.updateComparison(req.params.id, {
          status: 'completed',
          completedAt: new Date().toISOString(),
          results
        });
      } catch (err) {
        console.error(`Comparison ${req.params.id} failed:`, err);
        evaluationStore.updateComparison(req.params.id, {
          status: 'error',
          error: err.message
        });
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
