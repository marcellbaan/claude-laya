// Scores a prompt with a local Laya server and maps it to a tier: haiku, sonnet or opus.

export const LAYA_URL = (process.env.LAYA_URL ?? "http://127.0.0.1:8765").replace(/\/+$/, "");

const SCALE = ["None", "Very low", "Low", "Some", "Moderate", "Moderate to high", "High", "Very high", "Severe", "Extreme"];
const MAX_SCORE = SCALE.length - 1;

/**
 * Laya reads a small option budget, so the tier choice uses three short descriptions. The two
 * scores add a second opinion; eval/routing-eval.mjs shows the average beats the choice alone.
 */
export const QUESTIONS = {
  model_tier: {
    type: "choice",
    instructions: "Which model tier is the cheapest that can fully complete `request`, a coding assistant task?",
    criteria: {
      haiku: "trivial or mechanical: a question, rename, typo, format, run one command",
      sonnet: "routine engineering: implement a clear feature, write tests, fix a known local bug",
      opus: "hard: unknown-cause debugging, concurrency, security, architecture, large migrations",
    },
  },
  task_complexity: {
    type: "score",
    instructions: "How complex is the coding task overall, including ambiguity, scope, and blast radius?",
    criteria: SCALE,
  },
  reasoning_required: {
    type: "score",
    instructions: "How much reasoning is required to complete the request correctly in one pass?",
    criteria: SCALE,
  },
};

/** Cut points on the combined difficulty, fitted on the train split of eval/data/handwritten.jsonl. */
export const CUTS = {
  sonnet: Number(process.env.LAYA_SONNET_AT ?? 0.375),
  opus: Number(process.env.LAYA_OPUS_AT ?? 0.5),
};

const TIMEOUT_MS = Number(process.env.LAYA_TIMEOUT_MS ?? 2000);

/** Combined difficulty in [0, 1]: expected tier rank from the choice, plus both scores. */
export function difficulty(answers) {
  const p = answers.model_tier.probabilities;
  const rank = ((p.sonnet ?? 0) + 2 * (p.opus ?? 0)) / 2;
  return (rank + answers.task_complexity.score / MAX_SCORE + answers.reasoning_required.score / MAX_SCORE) / 3;
}

export const tierFor = (d) => (d < CUTS.sonnet ? "haiku" : d < CUTS.opus ? "sonnet" : "opus");

/**
 * The one place a Laya request is built, shared by the router and eval/routing-eval.mjs so
 * the two cannot drift. The checkpoint is pinned: laya-multilingual rarely picks the first
 * level of a `score` question (Laya README, issue #131), and two of our three are scores.
 */
export function buildRequest(prompt) {
  return {
    url: `${LAYA_URL}/v1/systemone`,
    init: {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(process.env.LAYA_API_KEY && { authorization: `Bearer ${process.env.LAYA_API_KEY}` }),
      },
      body: JSON.stringify({
        model: process.env.LAYA_CHECKPOINT ?? "english",
        state: { request: prompt },
        questions: QUESTIONS,
      }),
    },
  };
}

/** Asks Laya about one prompt. Returns null on any failure so routing never blocks a turn. */
export async function score(prompt) {
  const started = Date.now();
  try {
    const { url, init } = buildRequest(prompt);
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return null;
    const d = difficulty((await res.json()).answers);
    return { tier: tierFor(d), difficulty: d, ms: Date.now() - started };
  } catch {
    return null;
  }
}
