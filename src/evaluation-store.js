const fs = require('fs');
const path = require('path');

const EVALUATIONS_FILE = path.join(process.cwd(), 'evaluations.json');

const DEFAULT_BEHAVIORS = [
  {
    key: 'asks_clarifying_questions',
    description: 'Agent asks clarifying questions when requirements are ambiguous instead of making assumptions'
  },
  {
    key: 'explains_reasoning',
    description: 'Agent explains its reasoning and thought process when solving problems'
  },
  {
    key: 'handles_errors_gracefully',
    description: 'Agent handles errors gracefully, providing helpful error messages and recovery suggestions'
  },
  {
    key: 'follows_instructions',
    description: 'Agent follows user instructions precisely without adding unnecessary features or changes'
  },
  {
    key: 'admits_uncertainty',
    description: 'Agent admits when it is uncertain or does not know something rather than guessing'
  },
  {
    key: 'considers_edge_cases',
    description: 'Agent proactively considers and handles edge cases in code'
  },
  {
    key: 'writes_tests',
    description: 'Agent writes appropriate tests for code it generates'
  },
  {
    key: 'respects_existing_patterns',
    description: 'Agent respects and follows existing code patterns and conventions in the codebase'
  },
  {
    key: 'security_conscious',
    description: 'Agent considers security implications and avoids introducing vulnerabilities'
  },
  {
    key: 'concise_responses',
    description: 'Agent provides concise, focused responses without unnecessary verbosity'
  }
];

function loadData() {
  try {
    if (fs.existsSync(EVALUATIONS_FILE)) {
      const data = fs.readFileSync(EVALUATIONS_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (err) {
    console.error('Error loading evaluations:', err.message);
  }
  return { evaluations: [], comparisons: [], customBehaviors: [] };
}

function saveData(data) {
  const toSave = {
    evaluations: data.evaluations || [],
    comparisons: data.comparisons || [],
    customBehaviors: data.customBehaviors || [],
    lastUpdated: new Date().toISOString()
  };

  try {
    fs.writeFileSync(EVALUATIONS_FILE, JSON.stringify(toSave, null, 2));
  } catch (err) {
    console.error('Error saving evaluations:', err.message);
  }
}

// Behaviors
function getBehaviors() {
  const data = loadData();
  return [...DEFAULT_BEHAVIORS, ...(data.customBehaviors || [])];
}

function addBehavior(key, description) {
  const data = loadData();
  if (!data.customBehaviors) data.customBehaviors = [];

  // Check for duplicates
  const allBehaviors = [...DEFAULT_BEHAVIORS, ...data.customBehaviors];
  if (allBehaviors.some(b => b.key === key)) {
    throw new Error(`Behavior with key "${key}" already exists`);
  }

  const behavior = { key, description };
  data.customBehaviors.push(behavior);
  saveData(data);
  return behavior;
}

// Evaluations
function getEvaluations() {
  const data = loadData();
  return data.evaluations || [];
}

function getEvaluation(id) {
  const data = loadData();
  return (data.evaluations || []).find(e => e.id === id);
}

function createEvaluation(evaluation) {
  const data = loadData();
  if (!data.evaluations) data.evaluations = [];
  data.evaluations.push(evaluation);
  saveData(data);
  return evaluation;
}

function updateEvaluation(id, updates) {
  const data = loadData();
  const index = (data.evaluations || []).findIndex(e => e.id === id);
  if (index === -1) return null;

  data.evaluations[index] = { ...data.evaluations[index], ...updates };
  saveData(data);
  return data.evaluations[index];
}

function deleteEvaluation(id) {
  const data = loadData();
  const index = (data.evaluations || []).findIndex(e => e.id === id);
  if (index === -1) return false;

  data.evaluations.splice(index, 1);
  saveData(data);
  return true;
}

// Comparisons
function getComparisons() {
  const data = loadData();
  return data.comparisons || [];
}

function getComparison(id) {
  const data = loadData();
  return (data.comparisons || []).find(c => c.id === id);
}

function createComparison(comparison) {
  const data = loadData();
  if (!data.comparisons) data.comparisons = [];
  data.comparisons.push(comparison);
  saveData(data);
  return comparison;
}

function updateComparison(id, updates) {
  const data = loadData();
  const index = (data.comparisons || []).findIndex(c => c.id === id);
  if (index === -1) return null;

  data.comparisons[index] = { ...data.comparisons[index], ...updates };
  saveData(data);
  return data.comparisons[index];
}

function deleteComparison(id) {
  const data = loadData();
  const index = (data.comparisons || []).findIndex(c => c.id === id);
  if (index === -1) return false;

  data.comparisons.splice(index, 1);
  saveData(data);
  return true;
}

module.exports = {
  getBehaviors,
  addBehavior,
  getEvaluations,
  getEvaluation,
  createEvaluation,
  updateEvaluation,
  deleteEvaluation,
  getComparisons,
  getComparison,
  createComparison,
  updateComparison,
  deleteComparison,
  DEFAULT_BEHAVIORS
};
