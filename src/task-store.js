const fs = require('fs');
const path = require('path');

const TASKS_FILE = path.join(process.cwd(), 'tasks.json');

function loadTasks() {
  try {
    if (fs.existsSync(TASKS_FILE)) {
      const data = fs.readFileSync(TASKS_FILE, 'utf8');
      const parsed = JSON.parse(data);
      return parsed.tasks || [];
    }
  } catch (err) {
    console.error('Error loading tasks:', err.message);
  }
  return [];
}

function saveTasks(tasks) {
  const data = {
    tasks: tasks.map(t => ({
      id: t.id,
      title: t.title,
      completed: t.completed,
      priority: t.priority,
      dueDate: t.dueDate,
      order: t.order,
      createdAt: t.createdAt
    })),
    lastUpdated: new Date().toISOString()
  };

  try {
    fs.writeFileSync(TASKS_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('Error saving tasks:', err.message);
  }
}

module.exports = { loadTasks, saveTasks };
