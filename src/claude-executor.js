const { spawn } = require('child_process');

/**
 * Execute a prompt via `claude -p` and return the response
 * @param {string} prompt - The prompt to send
 * @param {object} options - Execution options
 * @param {string} options.systemPrompt - Optional system prompt
 * @param {string} options.cwd - Working directory
 * @param {number} options.timeout - Timeout in ms (default: 120000)
 * @param {boolean} options.jsonOutput - Request JSON output format
 * @returns {Promise<{text: string, json?: object, usage?: object}>}
 */
async function executePrompt(prompt, options = {}) {
  const {
    systemPrompt,
    cwd = process.cwd(),
    timeout = 120000,
    jsonOutput = false
  } = options;

  return new Promise((resolve, reject) => {
    const args = ['-p'];

    if (jsonOutput) {
      args.push('--output-format', 'json');
    }

    if (systemPrompt) {
      args.push('--system-prompt', systemPrompt);
    }

    args.push(prompt);

    const proc = spawn('claude', args, {
      cwd,
      env: { ...process.env },
      timeout
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    const timeoutId = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error(`Command timed out after ${timeout}ms`));
    }, timeout);

    proc.on('close', (code) => {
      clearTimeout(timeoutId);

      if (code !== 0) {
        reject(new Error(`claude exited with code ${code}: ${stderr}`));
        return;
      }

      const result = { text: stdout.trim() };

      if (jsonOutput) {
        try {
          result.json = JSON.parse(stdout);
          result.text = result.json.result || result.json.content || stdout.trim();
        } catch (e) {
          // JSON parsing failed, just return text
        }
      }

      resolve(result);
    });

    proc.on('error', (err) => {
      clearTimeout(timeoutId);
      reject(new Error(`Failed to spawn claude: ${err.message}`));
    });
  });
}

/**
 * Execute a prompt that expects structured JSON response
 * @param {string} prompt - The prompt (should request JSON output)
 * @param {object} options - Execution options
 * @returns {Promise<object>} Parsed JSON response
 */
async function executeJsonPrompt(prompt, options = {}) {
  const result = await executePrompt(prompt, { ...options, jsonOutput: true });

  if (result.json) {
    return result.json;
  }

  // Try to extract JSON from text response
  const jsonMatch = result.text.match(/```json\s*([\s\S]*?)\s*```/);
  if (jsonMatch) {
    return JSON.parse(jsonMatch[1]);
  }

  // Try parsing the entire response as JSON
  try {
    return JSON.parse(result.text);
  } catch (e) {
    throw new Error(`Failed to parse JSON response: ${result.text.substring(0, 200)}`);
  }
}

/**
 * Strip ANSI escape codes from text
 * @param {string} text - Text with potential ANSI codes
 * @returns {string} Clean text
 */
function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
}

/**
 * Extract meaningful content from PTY output
 * @param {string} output - Raw PTY output
 * @returns {string} Cleaned content
 */
function cleanPtyOutput(output) {
  let cleaned = stripAnsi(output);

  // Remove common terminal artifacts
  cleaned = cleaned
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return cleaned;
}

module.exports = {
  executePrompt,
  executeJsonPrompt,
  stripAnsi,
  cleanPtyOutput
};
