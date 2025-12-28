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
    const args = ['-p', '--permission-mode', 'default'];

    if (jsonOutput) {
      args.push('--output-format', 'json');
    }

    if (systemPrompt) {
      args.push('--system-prompt', systemPrompt);
    }

    args.push(prompt);

    const promptPreview = prompt.substring(0, 100).replace(/\n/g, ' ');
    console.log(`[claude-executor] Starting: claude ${args.slice(0, -1).join(' ')} "${promptPreview}..."`);
    console.log(`[claude-executor] Timeout: ${timeout}ms`);
    const startTime = Date.now();

    const proc = spawn('claude', args, {
      cwd,
      env: { ...process.env }
    });

    // Close stdin immediately - we're not sending input, and leaving it open
    // causes the Claude CLI to hang waiting for EOF
    proc.stdin.end();

    let stdout = '';
    let stderr = '';
    let settled = false;

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    const timeoutId = setTimeout(() => {
      if (settled) return;
      settled = true;
      console.log(`[claude-executor] TIMEOUT after ${timeout}ms`);
      proc.kill('SIGTERM');
      reject(new Error(`Command timed out after ${timeout}ms`));
    }, timeout);

    proc.on('close', (code) => {
      clearTimeout(timeoutId);
      if (settled) return;
      settled = true;

      const elapsed = Date.now() - startTime;
      console.log(`[claude-executor] Completed with exit code ${code} in ${elapsed}ms`);

      if (code !== 0) {
        console.log(`[claude-executor] Error: ${stderr.substring(0, 200)}`);
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
      if (settled) return;
      settled = true;
      console.log(`[claude-executor] Spawn error: ${err.message}`);
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

  // The Claude CLI with --output-format json returns a wrapper object:
  // { type: "result", result: "actual response text", session_id: ..., usage: ... }
  // The actual AI response is in the nested 'result' field as a string,
  // which may contain JSON embedded in markdown code blocks.

  let textToParse = result.text;

  if (result.json) {
    // Check if this is a CLI wrapper with nested result
    if (result.json.type === 'result' && typeof result.json.result === 'string') {
      textToParse = result.json.result;
    } else if (!result.json.type && !result.json.session_id) {
      // This looks like direct JSON content (not a wrapper), return it
      return result.json;
    }
  }

  // Try to extract JSON from markdown code blocks in the response
  const jsonMatch = textToParse.match(/```json\s*([\s\S]*?)\s*```/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[1]);
    } catch (e) {
      // Fall through to try other parsing methods
    }
  }

  // Try parsing the entire text as JSON
  try {
    return JSON.parse(textToParse);
  } catch (e) {
    throw new Error(`Failed to parse JSON response: ${textToParse.substring(0, 200)}`);
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

/**
 * Execute a single turn in a conversation, with optional session persistence
 * @param {string} prompt - The prompt to send
 * @param {object} options - Execution options
 * @param {string} options.sessionId - Session ID for conversation persistence (used with --resume for subsequent turns)
 * @param {string} options.systemPrompt - Optional system prompt
 * @param {number} options.timeout - Timeout in ms (default: 120000)
 * @param {boolean} options.isFirstTurn - Whether this is the first turn (uses --session-id, not --resume)
 * @returns {Promise<{text: string, json?: object, sessionId: string}>}
 */
async function executeConversationTurn(prompt, options = {}) {
  const {
    sessionId,
    systemPrompt,
    timeout = 120000,
    isFirstTurn = true
  } = options;

  return new Promise((resolve, reject) => {
    const args = ['-p', '--permission-mode', 'default', '--output-format', 'json'];

    // For first turn, use --session-id to set the ID
    // For subsequent turns, use --resume to continue the conversation
    if (sessionId) {
      if (isFirstTurn) {
        args.push('--session-id', sessionId);
      } else {
        args.push('--resume', sessionId);
      }
    }

    if (systemPrompt) {
      args.push('--system-prompt', systemPrompt);
    }

    args.push(prompt);

    const promptPreview = prompt.substring(0, 100).replace(/\n/g, ' ');
    console.log(`[claude-executor] Conversation turn (session: ${sessionId || 'none'}, first: ${isFirstTurn}): "${promptPreview}..."`);
    const startTime = Date.now();

    const proc = spawn('claude', args, {
      cwd: process.cwd(),
      env: { ...process.env }
    });

    proc.stdin.end();

    let stdout = '';
    let stderr = '';
    let settled = false;

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    const timeoutId = setTimeout(() => {
      if (settled) return;
      settled = true;
      console.log(`[claude-executor] Conversation turn TIMEOUT after ${timeout}ms`);
      proc.kill('SIGTERM');
      reject(new Error(`Command timed out after ${timeout}ms`));
    }, timeout);

    proc.on('close', (code) => {
      clearTimeout(timeoutId);
      if (settled) return;
      settled = true;

      const elapsed = Date.now() - startTime;
      console.log(`[claude-executor] Conversation turn completed with exit code ${code} in ${elapsed}ms`);

      if (code !== 0) {
        console.log(`[claude-executor] Error: ${stderr.substring(0, 200)}`);
        reject(new Error(`claude exited with code ${code}: ${stderr}`));
        return;
      }

      const result = { text: stdout.trim(), sessionId };

      try {
        const json = JSON.parse(stdout);
        result.json = json;

        // Extract text from CLI wrapper format
        if (json.type === 'result' && typeof json.result === 'string') {
          result.text = json.result;
        } else if (json.content) {
          result.text = json.content;
        } else if (json.result) {
          result.text = typeof json.result === 'string' ? json.result : JSON.stringify(json.result);
        }
      } catch (e) {
        // JSON parsing failed, keep text as-is
      }

      resolve(result);
    });

    proc.on('error', (err) => {
      clearTimeout(timeoutId);
      if (settled) return;
      settled = true;
      console.log(`[claude-executor] Spawn error: ${err.message}`);
      reject(new Error(`Failed to spawn claude: ${err.message}`));
    });
  });
}

module.exports = {
  executePrompt,
  executeJsonPrompt,
  executeConversationTurn,
  stripAnsi,
  cleanPtyOutput
};
