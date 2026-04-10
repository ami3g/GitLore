// ─── Intent-Based Query Router ───
// Soft-max distribution classifier: instead of picking one winning intent,
// outputs a weight for every intent and blends per-source-type multipliers
// proportionally. A query that is 49% historical + 51% implementation will
// get meaningful context from both PRs/commits AND code.

export type QueryIntent = 'overview' | 'historical' | 'implementation' | 'debugging' | 'general';

export interface IntentWeights {
  /** The dominant intent (for logging / intent-specific features) */
  intent: QueryIntent;
  commit: number;
  code: number;
  pr: number;
  /** Raw soft-max distribution across all intents (sums to ~1.0) */
  distribution: Record<QueryIntent, number>;
  /** Fraction of snippet budget allocated to code results (0–1). Remainder goes to commits/PRs. */
  codeBudgetRatio: number;
}

// ─── Keyword dictionaries (lowercase, checked via word-boundary regex) ───

// "What is this project?" / "What are the features?" — current state questions
const OVERVIEW_SIGNALS = [
  'about', 'overview', 'purpose', 'project', 'feature', 'summary',
  'describe', 'explain.*project', 'tech.*stack', 'stack',
  'main', 'major', 'core', 'what.*is.*this',
];

const HISTORICAL_SIGNALS = [
  'why', 'when', 'who', 'history', 'introduced', 'added', 'removed',
  'changed', 'motivation', 'decision', 'context', 'background',
  'pr', 'pull request', 'issue', 'ticket', 'milestone',
  'review', 'approved', 'merged', 'linked', 'resolved', 'goal',
  'roadmap', 'planning', 'rationale', 'trade-?off',
];

const IMPLEMENTATION_SIGNALS = [
  'how', 'implement', 'code', 'function', 'class',
  'method', 'interface', 'module', 'import', 'export', 'define',
  'declaration', 'signature', 'return', 'parameter', 'type',
  'architecture', 'structure', 'pattern', 'design', 'call',
  'api', 'endpoint', 'schema', 'model', 'component',
  // Trace / flow keywords (code-heavy intent, not debugging)
  'trace', 'flow', 'middleware', 'chain', 'pipeline',
  'dispatch', 'route', 'handle', 'process', 'traverse',
  'walk', 'step.*through', 'iterator', 'next',
];

const DEBUGGING_SIGNALS = [
  'bug', 'fix', 'error', 'broken', 'crash', 'fail', 'exception',
  'regression', 'revert', 'bisect', 'blame', 'cause', 'broke',
  'debug', 'stack', 'issue', 'wrong', 'unexpected',
  'null', 'undefined', 'timeout', 'leak', 'corrupt',
  // Root-cause / "why did this break" keywords
  'root.*cause', 'broke.*after', 'since.*commit',
];

function buildPattern(words: string[]): RegExp {
  // Match as whole words (or close to it) — case-insensitive
  const escaped = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`\\b(?:${escaped.join('|')})\\b`, 'gi');
}

const OVERVIEW_RE = buildPattern(OVERVIEW_SIGNALS);
const HISTORICAL_RE = buildPattern(HISTORICAL_SIGNALS);
const IMPLEMENTATION_RE = buildPattern(IMPLEMENTATION_SIGNALS);
const DEBUGGING_RE = buildPattern(DEBUGGING_SIGNALS);

function countMatches(text: string, pattern: RegExp): number {
  // Reset lastIndex since we reuse the regex
  pattern.lastIndex = 0;
  const matches = text.match(pattern);
  return matches ? matches.length : 0;
}

// ─── Per-intent weight profiles (what each intent "wants" from each table) ───
const INTENT_PROFILES: Record<QueryIntent, { commit: number; code: number; pr: number }> = {
  overview:       { commit: 0.6, code: 1.8, pr: 0.7 },
  historical:     { commit: 1.2, code: 0.8, pr: 1.5 },
  implementation: { commit: 0.8, code: 1.5, pr: 0.9 },
  debugging:      { commit: 1.5, code: 1.2, pr: 0.7 },
  general:        { commit: 1.0, code: 1.0, pr: 1.0 },
};

// ─── Elastic budget ratios: fraction of snippet budget given to CODE (rest → commits/PRs) ───
// Trace/Implementation → 80% code, Root-Cause/Why → 20% code, Refactor-like → 50/50
const CODE_BUDGET_RATIOS: Record<QueryIntent, number> = {
  overview:       0.70,
  historical:     0.20,
  implementation: 0.80,
  debugging:      0.20,
  general:        0.50,
};

/**
 * Soft-max over raw match counts → probability distribution.
 * Temperature controls sharpness: lower = more peaked, higher = more uniform.
 */
function softmax(scores: number[], temperature = 1.5): number[] {
  const scaled = scores.map((s) => s / temperature);
  const max = Math.max(...scaled);
  const exps = scaled.map((s) => Math.exp(s - max)); // subtract max for numerical stability
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map((e) => e / sum);
}

/**
 * Classify a user query into a soft-max distribution over all intents,
 * then blend per-table weight multipliers proportionally.
 *
 * A query with 40% historical + 50% implementation + 10% general will
 * produce blended weights that serve both intents well, rather than
 * discarding the 40% historical signal.
 *
 * Lower distance = better in LanceDB, so we *divide* by the weight rather
 * than multiply — e.g. a 1.5x boost on PR means: dividedScore = rawScore / 1.5
 */
export function classifyIntent(query: string): IntentWeights {
  const overviewCount = countMatches(query, OVERVIEW_RE);
  const histCount = countMatches(query, HISTORICAL_RE);
  const implCount = countMatches(query, IMPLEMENTATION_RE);
  const debugCount = countMatches(query, DEBUGGING_RE);

  const rawScores = [overviewCount, histCount, implCount, debugCount, 0];
  const intentNames: QueryIntent[] = ['overview', 'historical', 'implementation', 'debugging', 'general'];

  const maxCount = Math.max(overviewCount, histCount, implCount, debugCount);

  // No strong signal → pure general (uniform)
  if (maxCount === 0) {
    const dist: Record<QueryIntent, number> = { overview: 0, historical: 0, implementation: 0, debugging: 0, general: 1.0 };
    return { intent: 'general', commit: 1.0, code: 1.0, pr: 1.0, distribution: dist, codeBudgetRatio: 0.50 };
  }

  // Give 'general' a small base score (acts as smoothing / floor)
  rawScores[4] = maxCount * 0.15;

  const probs = softmax(rawScores);
  const distribution = {} as Record<QueryIntent, number>;
  for (let i = 0; i < intentNames.length; i++) {
    distribution[intentNames[i]] = probs[i];
  }

  // Dominant intent = highest probability
  let dominantIdx = 0;
  for (let i = 1; i < probs.length; i++) {
    if (probs[i] > probs[dominantIdx]) dominantIdx = i;
  }
  const intent = intentNames[dominantIdx];

  // Blend weights: weighted sum of each intent's profile by its probability
  let commit = 0, code = 0, pr = 0;
  for (let i = 0; i < intentNames.length; i++) {
    const profile = INTENT_PROFILES[intentNames[i]];
    commit += probs[i] * profile.commit;
    code += probs[i] * profile.code;
    pr += probs[i] * profile.pr;
  }

  // Blend elastic code budget ratio from distribution
  let codeBudgetRatio = 0;
  for (let i = 0; i < intentNames.length; i++) {
    codeBudgetRatio += probs[i] * CODE_BUDGET_RATIOS[intentNames[i]];
  }

  return { intent, commit, code, pr, distribution, codeBudgetRatio };
}

import type { SearchResult } from '../types';

/**
 * Apply intent weights to search results.
 * Divides the raw distance score by the weight — higher weight = lower (better) score.
 * Returns a new array sorted by weighted score, ready for greedy token filling.
 */
export function rerank(
  results: SearchResult[],
  weights: IntentWeights
): SearchResult[] {
  const weightMap: Record<string, number> = {
    commit: weights.commit,
    code: weights.code,
    pr: weights.pr,
  };

  return results
    .map((r) => ({
      ...r,
      score: r.score / (weightMap[r.type] || 1.0),
    }))
    .sort((a, b) => a.score - b.score); // lower = better
}
