import simpleGit, { type SimpleGit, type DefaultLogFields, type ListLogLine } from 'simple-git';
import type { CommitChunk } from '../types';

// ─── Smart Truncation Budget ───
// Code files get the lion's share; config/docs get less.
const BUDGET_HIGH = 3000;   // .ts, .py, .go, .rs, .java, .c, .cpp, etc.
const BUDGET_MEDIUM = 1500; // .sql, .graphql, .proto, .sh
const BUDGET_LOW = 600;     // .json, .yaml, .md, .lock, .css, .html, etc.

const HIGH_PRIORITY_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.java', '.c', '.cpp', '.h', '.hpp',
  '.cs', '.rb', '.swift', '.kt', '.kts', '.scala', '.ex', '.exs',
  '.vue', '.svelte',
]);

const MEDIUM_PRIORITY_EXT = new Set([
  '.sql', '.graphql', '.gql', '.proto', '.sh', '.bash', '.zsh',
  '.ps1', '.bat', '.cmd', '.lua', '.r', '.m',
]);

// Everything else falls to LOW.

export type ProgressCallback = (phase: string, current: number, total: number) => void;

function extOf(filePath: string): string {
  const dot = filePath.lastIndexOf('.');
  return dot === -1 ? '' : filePath.slice(dot).toLowerCase();
}

function budgetFor(filePath: string): number {
  const ext = extOf(filePath);
  if (HIGH_PRIORITY_EXT.has(ext)) return BUDGET_HIGH;
  if (MEDIUM_PRIORITY_EXT.has(ext)) return BUDGET_MEDIUM;
  return BUDGET_LOW;
}

export class GitProcessor {
  private git: SimpleGit;

  constructor(repoPath: string) {
    this.git = simpleGit(repoPath, { maxConcurrentProcesses: 4 });
  }

  /**
   * Extract commits and produce **one chunk per file** changed in each commit.
   * This gives the vector DB fine-grained, file-level embeddings.
   */
  async extractAndChunk(
    maxCount: number,
    onProgress?: ProgressCallback
  ): Promise<CommitChunk[]> {
    onProgress?.('Fetching commit log', 0, maxCount);

    const log = await this.git.log({ maxCount, '--all': null });
    const commits = log.all as ReadonlyArray<DefaultLogFields & ListLogLine>;
    const total = commits.length;
    const chunks: CommitChunk[] = [];

    for (let i = 0; i < total; i++) {
      const commit = commits[i];
      onProgress?.('Processing commits', i + 1, total);

      try {
        const diff = await this.getDiffForCommit(commit.hash);
        const fileDiffs = this.splitDiffByFile(diff);
        const allFiles = fileDiffs.map((fd) => fd.filePath);

        if (fileDiffs.length === 0) {
          // Merge commit or empty diff — still index the commit message
          chunks.push({
            hash: commit.hash,
            author: commit.author_name,
            date: commit.date,
            message: commit.message,
            filePath: '',
            condensedDiff: '',
            filesChanged: [],
          });
          continue;
        }

        for (const fd of fileDiffs) {
          const budget = budgetFor(fd.filePath);
          const condensed = this.condenseFileDiff(fd.rawDiff, budget);

          chunks.push({
            hash: commit.hash,
            author: commit.author_name,
            date: commit.date,
            message: commit.message,
            filePath: fd.filePath,
            condensedDiff: condensed,
            filesChanged: allFiles,
          });
        }
      } catch {
        // Initial commit or error — index just the message
        chunks.push({
          hash: commit.hash,
          author: commit.author_name,
          date: commit.date,
          message: commit.message,
          filePath: '',
          condensedDiff: '',
          filesChanged: [],
        });
      }
    }

    return chunks;
  }

  private async getDiffForCommit(hash: string): Promise<string> {
    const result = await this.git.show([
      hash,
      '--stat',
      '--patch',
      '--no-color',
      '--format=',
    ]);
    return result;
  }

  // ─── Split a full commit diff into per-file segments ───

  private splitDiffByFile(diff: string): { filePath: string; rawDiff: string }[] {
    if (!diff) return [];

    const segments: { filePath: string; rawDiff: string }[] = [];
    // Split on "diff --git" boundaries, keeping the delimiter
    const parts = diff.split(/(?=^diff --git )/m);

    for (const part of parts) {
      if (!part.startsWith('diff --git')) continue;
      const match = part.match(/^diff --git a\/.+ b\/(.+)$/m);
      if (match) {
        segments.push({ filePath: match[1], rawDiff: part });
      }
    }

    return segments;
  }

  // ─── Condense a single file's diff within the given budget ───

  private condenseFileDiff(rawDiff: string, budget: number): string {
    const lines = rawDiff.split('\n');
    const kept: string[] = [];
    let length = 0;

    for (const line of lines) {
      if (
        line.startsWith('diff --git') ||
        line.startsWith('---') ||
        line.startsWith('+++') ||
        line.startsWith('@@') ||
        line.startsWith('+') ||
        line.startsWith('-')
      ) {
        if (length + line.length + 1 > budget) {
          kept.push('... [diff truncated]');
          break;
        }
        kept.push(line);
        length += line.length + 1;
      }
    }

    return kept.join('\n');
  }

  // ─── Embedding Text ───

  toEmbeddingText(chunk: CommitChunk): string {
    const parts = [
      `Commit: ${chunk.hash.substring(0, 8)}`,
      `Author: ${chunk.author}`,
      `Date: ${chunk.date}`,
      `Message: ${chunk.message}`,
    ];
    if (chunk.filePath) {
      parts.push(`File: ${chunk.filePath}`);
    }
    if (chunk.filesChanged.length > 0) {
      parts.push(`Other files in commit: ${chunk.filesChanged.join(', ')}`);
    }
    if (chunk.condensedDiff) {
      parts.push(`Diff:\n${chunk.condensedDiff}`);
    }
    return parts.join('\n');
  }
}
