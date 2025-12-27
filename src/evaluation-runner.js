const { v4: uuidv4 } = require('uuid');
const pty = require('node-pty');
const { executeJsonPrompt, stripAnsi } = require('./claude-executor.js');
const {
  UNDERSTANDING_PROMPT,
  IDEATION_PROMPT,
  EVALUATOR_ROLE_PROMPT,
  JUDGMENT_PROMPT,
  PAIRWISE_JUDGMENT_PROMPT,
  META_JUDGMENT_PROMPT,
  fillTemplate
} = require('./evaluator-prompts.js');
const { getEvaluation, updateEvaluation, getBehaviors } = require('./evaluation-store.js');

const TIER_CONFIG = {
  quick: { numScenarios: 5, numJudges: 1, maxTurns: 3 },
  standard: { numScenarios: 20, numJudges: 3, maxTurns: 5 },
  comprehensive: { numScenarios: 50, numJudges: 3, maxTurns: 10 }
};

// Active evaluation runs (for progress tracking)
const activeRuns = new Map();

/**
 * Get the configuration for a tier
 */
function getTierConfig(tier) {
  return TIER_CONFIG[tier] || TIER_CONFIG.standard;
}

/**
 * Update evaluation stage status
 */
function updateStage(evaluationId, stage, updates) {
  const evaluation = getEvaluation(evaluationId);
  if (!evaluation) return null;

  const stages = evaluation.stages || {};
  stages[stage] = { ...(stages[stage] || {}), ...updates };

  return updateEvaluation(evaluationId, { stages });
}

/**
 * Stage 1: Understanding - Analyze the behavior
 */
async function runUnderstanding(evaluationId) {
  const evaluation = getEvaluation(evaluationId);
  if (!evaluation) throw new Error('Evaluation not found');

  console.log(`[evaluation] Stage: Understanding - starting for behavior "${evaluation.behaviorKey}"`);
  updateStage(evaluationId, 'understanding', { status: 'running', startedAt: new Date().toISOString() });

  const behaviors = getBehaviors();
  const behavior = behaviors.find(b => b.key === evaluation.behaviorKey);
  if (!behavior) throw new Error(`Behavior not found: ${evaluation.behaviorKey}`);

  const prompt = fillTemplate(UNDERSTANDING_PROMPT, {
    behaviorKey: behavior.key,
    behaviorDescription: behavior.description
  });

  try {
    const result = await executeJsonPrompt(prompt, { timeout: 120000 });

    console.log(`[evaluation] Stage: Understanding - completed`);
    updateStage(evaluationId, 'understanding', {
      status: 'completed',
      completedAt: new Date().toISOString(),
      result
    });

    return result;
  } catch (err) {
    console.log(`[evaluation] Stage: Understanding - error: ${err.message}`);
    updateStage(evaluationId, 'understanding', {
      status: 'error',
      error: err.message
    });
    throw err;
  }
}

/**
 * Stage 2: Ideation - Generate evaluation scenarios
 */
async function runIdeation(evaluationId, understanding) {
  const evaluation = getEvaluation(evaluationId);
  if (!evaluation) throw new Error('Evaluation not found');

  const tierConfig = getTierConfig(evaluation.config?.tier);
  const numScenarios = evaluation.config?.numScenarios || tierConfig.numScenarios;
  const diversity = evaluation.config?.diversity || 0.5;

  console.log(`[evaluation] Stage: Ideation - generating ${numScenarios} scenarios`);
  updateStage(evaluationId, 'ideation', { status: 'running', startedAt: new Date().toISOString() });

  const prompt = fillTemplate(IDEATION_PROMPT, {
    understanding: JSON.stringify(understanding, null, 2),
    numScenarios,
    diversity
  });

  try {
    const result = await executeJsonPrompt(prompt, { timeout: 180000 });
    const scenarios = result.scenarios || [];

    console.log(`[evaluation] Stage: Ideation - completed with ${scenarios.length} scenarios`);
    updateStage(evaluationId, 'ideation', {
      status: 'completed',
      completedAt: new Date().toISOString(),
      scenarioCount: scenarios.length,
      scenarios
    });

    return scenarios;
  } catch (err) {
    console.log(`[evaluation] Stage: Ideation - error: ${err.message}`);
    updateStage(evaluationId, 'ideation', {
      status: 'error',
      error: err.message
    });
    throw err;
  }
}

/**
 * Run a single scenario rollout using PTY
 */
async function runSingleRollout(scenario, promptConfig, maxTurns, understanding) {
  return new Promise((resolve, reject) => {
    const transcript = [];
    let outputBuffer = '';
    let turnCount = 0;
    let isWaitingForResponse = false;
    let responseTimer = null;
    const RESPONSE_TIMEOUT = 60000; // 60s per turn

    // Spawn PTY with target agent
    const args = [];
    if (promptConfig.systemPrompt) {
      args.push('--system-prompt', promptConfig.systemPrompt);
    }

    const term = pty.spawn('claude', args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 40,
      cwd: process.cwd(),
      env: { ...process.env, COLORTERM: 'truecolor' }
    });

    const cleanup = () => {
      if (responseTimer) clearTimeout(responseTimer);
      try {
        term.kill();
      } catch (e) {
        // Already killed
      }
    };

    // Detect when response is complete (heuristic: no output for 2 seconds)
    let lastOutputTime = Date.now();
    let outputCheckInterval = null;

    const checkForResponseEnd = () => {
      if (isWaitingForResponse && Date.now() - lastOutputTime > 2000) {
        // Response seems complete
        clearInterval(outputCheckInterval);
        isWaitingForResponse = false;

        const response = stripAnsi(outputBuffer).trim();
        outputBuffer = '';

        if (response) {
          transcript.push({
            role: 'assistant',
            content: response,
            timestamp: new Date().toISOString()
          });
        }

        turnCount++;

        // Check if we should continue
        if (turnCount >= maxTurns) {
          cleanup();
          resolve({ transcript, completed: true, turnCount });
          return;
        }

        // Ask evaluator if we should continue
        decideNextAction(transcript, scenario, understanding).then(action => {
          if (action.action === 'complete' || !action.message) {
            cleanup();
            resolve({ transcript, completed: true, turnCount });
          } else {
            // Send follow-up message
            transcript.push({
              role: 'user',
              content: action.message,
              timestamp: new Date().toISOString()
            });
            sendMessage(action.message);
          }
        }).catch(err => {
          cleanup();
          resolve({ transcript, completed: false, error: err.message, turnCount });
        });
      }
    };

    const sendMessage = (message) => {
      outputBuffer = '';
      isWaitingForResponse = true;
      lastOutputTime = Date.now();
      outputCheckInterval = setInterval(checkForResponseEnd, 500);

      responseTimer = setTimeout(() => {
        clearInterval(outputCheckInterval);
        cleanup();
        resolve({ transcript, completed: false, error: 'Response timeout', turnCount });
      }, RESPONSE_TIMEOUT);

      term.write(message + '\r');
    };

    term.onData((data) => {
      outputBuffer += data;
      lastOutputTime = Date.now();
    });

    term.onExit(() => {
      cleanup();
      if (transcript.length === 0) {
        reject(new Error('PTY exited before any output'));
      } else {
        resolve({ transcript, completed: true, turnCount });
      }
    });

    // Start with initial prompt
    setTimeout(() => {
      transcript.push({
        role: 'user',
        content: scenario.prompt,
        timestamp: new Date().toISOString()
      });
      sendMessage(scenario.prompt);
    }, 1000); // Wait for PTY to initialize
  });
}

/**
 * Ask the evaluator model what to do next
 */
async function decideNextAction(transcript, scenario, understanding) {
  const transcriptText = transcript.map(t => `${t.role}: ${t.content}`).join('\n\n');

  const prompt = fillTemplate(EVALUATOR_ROLE_PROMPT, {
    scenario: JSON.stringify(scenario, null, 2),
    transcript: transcriptText
  });

  try {
    return await executeJsonPrompt(prompt, { timeout: 60000 });
  } catch (err) {
    return { action: 'complete', reason: 'Evaluator error: ' + err.message };
  }
}

/**
 * Stage 3: Rollout - Execute scenarios with target agent
 */
async function runRollout(evaluationId, scenarios, understanding) {
  const evaluation = getEvaluation(evaluationId);
  if (!evaluation) throw new Error('Evaluation not found');

  const tierConfig = getTierConfig(evaluation.config?.tier);
  const maxTurns = evaluation.config?.maxTurns || tierConfig.maxTurns;
  const promptConfig = evaluation.promptConfig || {};

  console.log(`[evaluation] Stage: Rollout - processing ${scenarios.length} scenarios (maxTurns: ${maxTurns})`);
  updateStage(evaluationId, 'rollout', {
    status: 'running',
    startedAt: new Date().toISOString(),
    completed: 0,
    total: scenarios.length
  });

  const transcripts = [];
  const maxConcurrent = 3; // Limit concurrent PTYs

  // Process scenarios with bounded parallelism
  for (let i = 0; i < scenarios.length; i += maxConcurrent) {
    const batch = scenarios.slice(i, i + maxConcurrent);
    const results = await Promise.allSettled(
      batch.map(scenario => runSingleRollout(scenario, promptConfig, maxTurns, understanding))
    );

    for (let j = 0; j < results.length; j++) {
      const result = results[j];
      const scenario = batch[j];

      if (result.status === 'fulfilled') {
        transcripts.push({
          scenarioId: scenario.id,
          scenario,
          ...result.value
        });
      } else {
        transcripts.push({
          scenarioId: scenario.id,
          scenario,
          transcript: [],
          completed: false,
          error: result.reason?.message || 'Unknown error'
        });
      }
    }

    // Update progress
    const completedCount = Math.min(i + maxConcurrent, scenarios.length);
    console.log(`[evaluation] Rollout progress: ${completedCount}/${scenarios.length}`);
    updateStage(evaluationId, 'rollout', {
      completed: completedCount,
      total: scenarios.length
    });
  }

  console.log(`[evaluation] Stage: Rollout - completed`);
  updateStage(evaluationId, 'rollout', {
    status: 'completed',
    completedAt: new Date().toISOString(),
    completed: scenarios.length,
    total: scenarios.length,
    transcripts
  });

  return transcripts;
}

/**
 * Judge a single transcript
 */
async function judgeSingleTranscript(transcriptData, behavior, understanding) {
  const transcriptText = transcriptData.transcript
    .map(t => `${t.role}: ${t.content}`)
    .join('\n\n');

  const prompt = fillTemplate(JUDGMENT_PROMPT, {
    behaviorKey: behavior.key,
    behaviorDescription: behavior.description,
    understanding: JSON.stringify(understanding, null, 2),
    transcript: transcriptText
  });

  return executeJsonPrompt(prompt, { timeout: 120000 });
}

/**
 * Stage 4: Judgment - Score transcripts
 */
async function runJudgment(evaluationId, transcripts, understanding) {
  const evaluation = getEvaluation(evaluationId);
  if (!evaluation) throw new Error('Evaluation not found');

  const behaviors = getBehaviors();
  const behavior = behaviors.find(b => b.key === evaluation.behaviorKey);
  if (!behavior) throw new Error(`Behavior not found: ${evaluation.behaviorKey}`);

  const tierConfig = getTierConfig(evaluation.config?.tier);
  const numJudges = evaluation.config?.numJudges || tierConfig.numJudges;

  console.log(`[evaluation] Stage: Judgment - scoring ${transcripts.length} transcripts with ${numJudges} judge(s)`);
  updateStage(evaluationId, 'judgment', {
    status: 'running',
    startedAt: new Date().toISOString(),
    completed: 0,
    total: transcripts.length
  });

  const judgments = [];

  for (let i = 0; i < transcripts.length; i++) {
    const transcriptData = transcripts[i];

    // Skip failed rollouts
    if (transcriptData.error && transcriptData.transcript.length === 0) {
      judgments.push({
        scenarioId: transcriptData.scenarioId,
        score: null,
        error: transcriptData.error,
        skipped: true
      });
      continue;
    }

    try {
      // Run multiple judges if configured
      const judgeResults = [];
      for (let j = 0; j < numJudges; j++) {
        const result = await judgeSingleTranscript(transcriptData, behavior, understanding);
        judgeResults.push(result);
      }

      // Aggregate scores (median)
      const scores = judgeResults.map(j => j.score).filter(s => typeof s === 'number');
      scores.sort((a, b) => a - b);
      const medianScore = scores.length > 0 ? scores[Math.floor(scores.length / 2)] : null;

      // Combine evidence from all judges
      const allPositive = judgeResults.flatMap(j => j.positiveEvidence || []);
      const allNegative = judgeResults.flatMap(j => j.negativeEvidence || []);

      judgments.push({
        scenarioId: transcriptData.scenarioId,
        score: medianScore,
        confidence: judgeResults[0]?.confidence || 'medium',
        summary: judgeResults[0]?.summary || '',
        positiveEvidence: allPositive.slice(0, 3), // Keep top 3
        negativeEvidence: allNegative.slice(0, 3),
        judgeCount: numJudges
      });
    } catch (err) {
      judgments.push({
        scenarioId: transcriptData.scenarioId,
        score: null,
        error: err.message
      });
    }

    console.log(`[evaluation] Judgment progress: ${i + 1}/${transcripts.length}`);
    updateStage(evaluationId, 'judgment', {
      completed: i + 1,
      total: transcripts.length
    });
  }

  console.log(`[evaluation] Stage: Judgment - completed`);
  // Calculate aggregate results
  const validScores = judgments.filter(j => typeof j.score === 'number').map(j => j.score);
  const results = {
    overallScore: validScores.length > 0 ? validScores.reduce((a, b) => a + b, 0) / validScores.length : null,
    scoreDistribution: validScores.length > 0 ? {
      min: Math.min(...validScores),
      max: Math.max(...validScores),
      mean: validScores.reduce((a, b) => a + b, 0) / validScores.length,
      std: Math.sqrt(validScores.reduce((sum, s) => sum + Math.pow(s - (validScores.reduce((a, b) => a + b, 0) / validScores.length), 2), 0) / validScores.length)
    } : null,
    keyQuotes: judgments.flatMap(j => j.positiveEvidence || []).slice(0, 5),
    failurePatterns: judgments.filter(j => j.score !== null && j.score < 0.4).map(j => j.summary).filter(Boolean)
  };

  updateStage(evaluationId, 'judgment', {
    status: 'completed',
    completedAt: new Date().toISOString(),
    completed: transcripts.length,
    total: transcripts.length,
    judgments
  });

  updateEvaluation(evaluationId, {
    status: 'completed',
    completedAt: new Date().toISOString(),
    results
  });

  return { judgments, results };
}

/**
 * Run a complete evaluation pipeline
 */
async function runEvaluation(evaluationId) {
  const evaluation = getEvaluation(evaluationId);
  if (!evaluation) throw new Error('Evaluation not found');

  console.log(`[evaluation] Starting evaluation ${evaluationId} for behavior "${evaluation.behaviorKey}"`);
  console.log(`[evaluation] Config: tier=${evaluation.config?.tier || 'standard'}`);

  // Store in active runs for progress tracking
  activeRuns.set(evaluationId, { startedAt: new Date().toISOString() });

  updateEvaluation(evaluationId, {
    status: 'running',
    startedAt: new Date().toISOString()
  });

  try {
    // Stage 1: Understanding
    const understanding = await runUnderstanding(evaluationId);

    // Stage 2: Ideation
    const scenarios = await runIdeation(evaluationId, understanding);

    // Stage 3: Rollout
    const transcripts = await runRollout(evaluationId, scenarios, understanding);

    // Stage 4: Judgment
    const { judgments, results } = await runJudgment(evaluationId, transcripts, understanding);

    console.log(`[evaluation] Evaluation ${evaluationId} completed successfully`);
    console.log(`[evaluation] Overall score: ${results.overallScore?.toFixed(2) || 'N/A'}`);
    activeRuns.delete(evaluationId);
    return { success: true, results };
  } catch (err) {
    console.log(`[evaluation] Evaluation ${evaluationId} failed: ${err.message}`);
    activeRuns.delete(evaluationId);
    updateEvaluation(evaluationId, {
      status: 'error',
      error: err.message
    });
    throw err;
  }
}

/**
 * Get the status of a running evaluation
 */
function getEvaluationStatus(evaluationId) {
  const evaluation = getEvaluation(evaluationId);
  if (!evaluation) return null;

  return {
    id: evaluation.id,
    status: evaluation.status,
    stages: evaluation.stages,
    results: evaluation.results,
    startedAt: evaluation.startedAt,
    completedAt: evaluation.completedAt,
    error: evaluation.error
  };
}

module.exports = {
  runEvaluation,
  getEvaluationStatus,
  getTierConfig,
  TIER_CONFIG
};
