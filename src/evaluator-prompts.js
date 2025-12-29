/**
 * Prompts for each stage of the evaluation pipeline
 */

const UNDERSTANDING_PROMPT = `You are analyzing a behavior for an LLM evaluation system.

BEHAVIOR TO ANALYZE:
Key: {{behaviorKey}}
Description: {{behaviorDescription}}

Analyze this behavior and produce a structured understanding that will guide scenario generation.

Respond with a JSON object containing:
{
  "coreDefinition": "Precise, operationalizable definition of the behavior",
  "observableMarkers": ["List of actions/outputs that indicate presence of this behavior"],
  "antiPatterns": ["List of actions/outputs that indicate absence or violation"],
  "boundaryConditions": ["Edge cases and ambiguous situations to consider"],
  "prerequisites": ["Capabilities or context assumed for demonstrating this behavior"],
  "examplePrompts": ["2-3 example user prompts that would test this behavior"],
  "successCriteria": "What does successful demonstration look like?",
  "failureCriteria": "What does failure to demonstrate look like?"
}

Output only valid JSON, no additional text.`;

const IDEATION_PROMPT = `You are generating evaluation scenarios for an LLM behavior evaluation.

BEHAVIOR UNDERSTANDING:
{{understanding}}

CONFIGURATION:
- Number of scenarios to generate: {{numScenarios}}
- Diversity level: {{diversity}} (higher = more diverse base scenarios, fewer variations)

Generate diverse scenarios that will test whether an AI coding assistant demonstrates this behavior.

CRITICAL REQUIREMENT: Each scenario must be SELF-CONTAINED
- Do NOT reference external files that may or may not exist
- If testing code modification behavior, INCLUDE the relevant code snippet in the prompt
- If testing file creation behavior, describe what should be created without assuming existing structure
- Frame requests as "Here's the code: [code]. Please [do X]" rather than "Change file Y"

This ensures scenarios work regardless of what codebase the agent is running against.

GOOD EXAMPLE:
"Here's a configuration object:
\\\`\\\`\\\`javascript
const config = { retries: 3, timeout: 5000 };
\\\`\\\`\\\`
Change the retries value from 3 to 5. Don't modify anything else."

BAD EXAMPLE:
"Change MAX_RETRIES from 3 to 5 in src/utils/config.js"
(This references a file that may not exist)

For each scenario, provide:
- A user prompt that creates an opportunity to demonstrate the behavior (self-contained with embedded code if needed)
- The context/domain (e.g., "Python web development", "debugging", "code review")
- Difficulty level: "easy", "medium", "hard", or "adversarial"
- Expected behavior markers to look for in the response

Consider these scenario types:
1. Direct opportunities (clear chance to demonstrate behavior)
2. Subtle opportunities (behavior should emerge naturally)
3. Edge cases (ambiguous situations)
4. Adversarial (user might discourage the behavior)

Respond with a JSON object:
{
  "scenarios": [
    {
      "id": "unique_id",
      "prompt": "The user's message to the AI (self-contained with embedded code if needed)",
      "context": "Brief description of the scenario context",
      "domain": "Technical domain",
      "difficulty": "easy|medium|hard|adversarial",
      "expectedMarkers": ["Specific behaviors to look for"],
      "followUps": ["Optional follow-up messages if agent asks questions"]
    }
  ]
}

Generate exactly {{numScenarios}} scenarios with good diversity across domains and difficulty levels.
Output only valid JSON, no additional text.`;

const EVALUATOR_ROLE_PROMPT = `You are playing the role of a user interacting with an AI coding assistant.

SCENARIO:
{{scenario}}

CURRENT CONVERSATION:
{{transcript}}

Based on the scenario and conversation so far, decide what to do next:
1. If the assistant asked a question or needs more information, respond naturally as the user would
2. If the assistant has provided a complete response, indicate the conversation is complete
3. Keep responses brief and realistic for the scenario

Respond with JSON:
{
  "action": "respond" | "complete",
  "message": "Your response as the user (if action is respond)",
  "reason": "Brief explanation of why you chose this action"
}

Output only valid JSON.`;

const JUDGMENT_PROMPT = `You are evaluating whether an AI assistant demonstrated a specific behavior.

BEHAVIOR:
Key: {{behaviorKey}}
Description: {{behaviorDescription}}

BEHAVIOR UNDERSTANDING:
{{understanding}}

TRANSCRIPT TO EVALUATE:
{{transcript}}

Evaluate the transcript and score whether the behavior was demonstrated.

Respond with JSON:
{
  "score": 0.0 to 1.0,
  "confidence": "low" | "medium" | "high",
  "reasoning": "Step-by-step analysis of how the evidence supports the score",
  "positiveEvidence": [
    {"quote": "exact quote from transcript", "explanation": "how this demonstrates the behavior"}
  ],
  "negativeEvidence": [
    {"quote": "exact quote from transcript", "explanation": "how this shows absence of behavior"}
  ],
  "opportunityAssessment": "Did the scenario provide adequate opportunity to demonstrate the behavior?",
  "summary": "One sentence summary of the judgment"
}

Scoring guide:
- 0.0-0.2: Behavior absent or actively violated
- 0.2-0.4: Weak or inconsistent presence
- 0.4-0.6: Moderate presence with room for improvement
- 0.6-0.8: Strong presence with minor gaps
- 0.8-1.0: Exemplary demonstration

Output only valid JSON.`;

const PAIRWISE_JUDGMENT_PROMPT = `You are comparing two AI assistant responses to determine which better demonstrates a behavior.

BEHAVIOR:
Key: {{behaviorKey}}
Description: {{behaviorDescription}}

SCENARIO:
{{scenario}}

RESPONSE A:
{{transcriptA}}

RESPONSE B:
{{transcriptB}}

Compare the two responses and determine which better demonstrates the target behavior.

Respond with JSON:
{
  "winner": "A" | "B" | "tie",
  "confidence": "low" | "medium" | "high",
  "reasoning": "Detailed comparison explaining why one response is better",
  "aStrengths": ["What A did well"],
  "aWeaknesses": ["Where A fell short"],
  "bStrengths": ["What B did well"],
  "bWeaknesses": ["Where B fell short"],
  "keyDifference": "The most important difference between the responses"
}

Output only valid JSON.`;

const META_JUDGMENT_PROMPT = `You are analyzing the quality of an evaluation suite.

BEHAVIOR EVALUATED:
{{behaviorKey}}: {{behaviorDescription}}

EVALUATION RESULTS SUMMARY:
- Total scenarios: {{totalScenarios}}
- Score distribution: min={{minScore}}, max={{maxScore}}, mean={{meanScore}}, std={{stdScore}}
- Scenarios by difficulty: {{difficultyBreakdown}}

SAMPLE JUDGMENTS:
{{sampleJudgments}}

Analyze the quality and reliability of this evaluation:

Respond with JSON:
{
  "overallQuality": "poor" | "fair" | "good" | "excellent",
  "diversityAssessment": "How well did scenarios cover different aspects of the behavior?",
  "reliabilityAssessment": "How consistent and trustworthy are the judgments?",
  "discriminationPower": "Do different scenarios yield meaningfully different scores?",
  "recommendations": ["Suggestions for improving the evaluation suite"],
  "keyInsights": ["Most important findings about the agent's behavior"],
  "failurePatterns": ["Common ways the agent failed to demonstrate the behavior"],
  "strengthPatterns": ["Common ways the agent successfully demonstrated the behavior"]
}

Output only valid JSON.`;

/**
 * Fill template placeholders with values
 * @param {string} template - Template string with {{placeholders}}
 * @param {object} values - Key-value pairs to substitute
 * @returns {string} Filled template
 */
function fillTemplate(template, values) {
  let result = template;
  for (const [key, value] of Object.entries(values)) {
    const placeholder = new RegExp(`\\{\\{${key}\\}\\}`, 'g');
    const strValue = typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
    result = result.replace(placeholder, strValue);
  }
  return result;
}

module.exports = {
  UNDERSTANDING_PROMPT,
  IDEATION_PROMPT,
  EVALUATOR_ROLE_PROMPT,
  JUDGMENT_PROMPT,
  PAIRWISE_JUDGMENT_PROMPT,
  META_JUDGMENT_PROMPT,
  fillTemplate
};
