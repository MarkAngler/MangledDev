const fs = require('fs');
const path = require('path');

const WORKFLOWS_FILE = path.join(process.cwd(), 'workflows.json');

function loadWorkflows() {
  try {
    if (fs.existsSync(WORKFLOWS_FILE)) {
      const data = fs.readFileSync(WORKFLOWS_FILE, 'utf8');
      const parsed = JSON.parse(data);
      return parsed.workflows || [];
    }
  } catch (err) {
    console.error('Error loading workflows:', err.message);
  }
  return [];
}

function saveWorkflows(workflows) {
  const data = {
    workflows: workflows.map(w => ({
      id: w.id,
      name: w.name,
      steps: w.steps,
      createdAt: w.createdAt
    })),
    lastUpdated: new Date().toISOString()
  };

  try {
    fs.writeFileSync(WORKFLOWS_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('Error saving workflows:', err.message);
  }
}

module.exports = { loadWorkflows, saveWorkflows };
