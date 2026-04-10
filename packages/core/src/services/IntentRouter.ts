// ─── Intent-Based Query Router ───
// Lightweight keyword classifier that detects query intent and produces
// per-source-type weight multipliers for reranking search results.

export type QueryIntent = 'overview' | 'historical' | 'implementation' | 'debugging' | 'general';

export interface IntentWeights {
  intent: QueryIntent;
  commit: number;
  code: number;
  pr: number;
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
];

const DEBUGGING_SIGNALS = [
  'bug', 'fix', 'error', 'broken', 'crash', 'fail', 'exception',
  'regression', 'revert', 'bisect', 'blame', 'cause', 'broke',
  'debug', 'trace', 'stack', 'issue', 'wrong', 'unexpected',
  'null', 'undefined', 'timeout', 'leak', 'corrupt',
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

/**
 * Classify a user query into an intent and return per-table weight multipliers.
 *
 * Lower distance = better in LanceDB, so we *divide* by the weight rather
 * than multiply — e.g. a 1.5x boost on PR means: dividedScore = rawScore / 1.5
 * This is equivalent to making PR results "closer" in vector space.
 */
export function classifyIntent(query: string): IntentWeights {
  const overviewCount = countMatches(query, OVERVIEW_RE);
  const histCount = countMatches(query, HISTORICAL_RE);
  const implCount = countMatches(query, IMPLEMENTATION_RE);
  const debugCount = countMatches(query, DEBUGGING_RE);

  const maxCount = Math.max(overviewCount, histCount, implCount, debugCount);

  // No strong signal → general balanced query
  if (maxCount === 0) {
    return { intent: 'general', commit: 1.0, code: 1.0, pr: 1.0 };
  }

  // Overview: "what is this project", "what are the features"
  // → Current code (README, docs, config) is the source of truth
  if (overviewCount >= histCount && overviewCount >= implCount && overviewCount >= debugCount) {
    return {
      intent: 'overview',
      commit: 0.6,    // commits are historical noise for "current state" questions
      code: 1.8,      // README, package.json, entry files describe the project best
      pr: 0.7,
    };
  }

  // Winner-takes-all with proportional boosting
  if (histCount >= implCount && histCount >= debugCount) {
    return {
      intent: 'historical',
      commit: 1.2,
      code: 0.8,
      pr: 1.5,       // PR context is most valuable for "why" questions
    };
  }

  if (implCount >= histCount && implCount >= debugCount) {
    return {
      intent: 'implementation',
      commit: 0.8,
      code: 1.5,     // Current code is most valuable for "how" questions
      pr: 0.9,
    };
  }

  // debugCount wins
  return {
    intent: 'debugging',
    commit: 1.5,      // Commits show what changed and when it broke
    code: 1.2,
    pr: 0.7,
  };
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
