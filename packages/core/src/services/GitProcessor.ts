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

// ─── Exclusion List ("Git-ignore for vectors") ───
// Skip files that add noise, leak secrets, or are binary.
const EXCLUDED_EXTENSIONS = new Set([
  // Binary / media
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.svg', '.bmp',
  '.mp4', '.mp3', '.wav', '.ogg', '.webm', '.mov', '.avi',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.zip', '.tar', '.gz', '.bz2', '.7z', '.rar',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.wasm',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  // Lock files (large, low signal)
  '.lock',
]);

const EXCLUDED_FILENAMES = new Set([
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'composer.lock',
  'Gemfile.lock',
  'Cargo.lock',
  'poetry.lock',
  'Pipfile.lock',
]);

// Files that may contain secrets — skip even if committed
const SENSITIVE_PATTERNS = [
  /\.env(\..+)?$/i,       // .env, .env.local, .env.production
  /\.secret/i,
  /\.pem$/i,
  /\.key$/i,
  /\.crt$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /id_rsa/i,
  /id_ed25519/i,
];

function isExcluded(filePath: string): boolean {
  const ext = extOf(filePath);
  if (EXCLUDED_EXTENSIONS.has(ext)) return true;

  const fileName = filePath.split('/').pop() ?? filePath;
  if (EXCLUDED_FILENAMES.has(fileName)) return true;

  if (SENSITIVE_PATTERNS.some((p) => p.test(filePath))) return true;

  return false;
}

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
    const chunks: CommitChunk[] = [];
    for await (const page of this.extractPaged(maxCount, 200, onProgress)) {
      chunks.push(...page);
    }
    return chunks;
  }

  /**
   * Paged commit extraction — yields one page of chunks at a time.
   * Uses `git log --skip=N --max-count=PAGE` so only one page of
   * commits and their diffs live in memory at any point.
   */
  async *extractPaged(
    totalMax: number,
    pageSize: number,
    onProgress?: ProgressCallback
  ): AsyncGenerator<CommitChunk[]> {
    let processed = 0;

    for (let skip = 0; skip < totalMax; skip += pageSize) {
      const take = Math.min(pageSize, totalMax - skip);
      onProgress?.('Fetching commit page', skip, totalMax);

      const log = await this.git.log({
        maxCount: take,
        '--all': null,
        '--skip': skip,
      } as any);

      const commits = log.all as ReadonlyArray<DefaultLogFields & ListLogLine>;
      if (commits.length === 0) break; // no more commits in the repo

      const pageChunks: CommitChunk[] = [];

      for (const commit of commits) {
        processed++;
        onProgress?.('Processing commits', processed, totalMax);

        try {
          const diff = await this.getDiffForCommit(commit.hash);
          const fileDiffs = this.splitDiffByFile(diff);
          const allFiles = fileDiffs.map((fd) => fd.filePath);

          if (fileDiffs.length === 0) {
            pageChunks.push({
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
            if (isExcluded(fd.filePath)) continue;

            const budget = budgetFor(fd.filePath);
            const condensed = this.condenseFileDiff(fd.rawDiff, budget);

            pageChunks.push({
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
          pageChunks.push({
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

      yield pageChunks;

      // If we got fewer commits than requested, we've hit the end
      if (commits.length < take) break;
    }
  }

  /**
   * Extract only commits newer than `sinceHash`.
   * Uses `git log sinceHash..HEAD` to get the delta.
   */
  async extractNewCommits(
    sinceHash: string,
    maxCount: number,
    onProgress?: ProgressCallback
  ): Promise<CommitChunk[]> {
    onProgress?.('Checking for new commits', 0, 0);

    const log = await this.git.log({ maxCount, from: sinceHash, to: 'HEAD', '--all': null });
    const commits = log.all as ReadonlyArray<DefaultLogFields & ListLogLine>;

    if (commits.length === 0) {
      return [];
    }

    const total = commits.length;
    const chunks: CommitChunk[] = [];

    for (let i = 0; i < total; i++) {
      const commit = commits[i];
      onProgress?.('Processing new commits', i + 1, total);

      try {
        const diff = await this.getDiffForCommit(commit.hash);
        const fileDiffs = this.splitDiffByFile(diff);
        const allFiles = fileDiffs.map((fd) => fd.filePath);

        if (fileDiffs.length === 0) {
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
          if (isExcluded(fd.filePath)) continue;

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

  /**
   * Get the latest commit hash in the repo.
   */
  async getLatestHash(): Promise<string | null> {
    try {
      const log = await this.git.log({ maxCount: 1 });
      return log.latest?.hash ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Check if a commit hash exists in the current history.
   * Returns false after a rebase/reset that removed it.
   */
  async hashExists(hash: string): Promise<boolean> {
    try {
      await this.git.catFile(['-t', hash]);
      return true;
    } catch {
      return false;
    }
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
      `[COMMIT: ${chunk.hash.substring(0, 8)}] Author: ${chunk.author} | Date: ${chunk.date}`,
      `[MESSAGE]: ${chunk.message}`,
    ];
    if (chunk.filePath) {
      parts.push(`[FILE]: ${chunk.filePath}`);
    }
    if (chunk.filesChanged.length > 0) {
      parts.push(`[OTHER FILES]: ${chunk.filesChanged.join(', ')}`);
    }
    if (chunk.condensedDiff) {
      parts.push(`[DIFF]:\n${chunk.condensedDiff}`);
    }
    return parts.join('\n');
  }

  /**
   * Get a lightweight "table of contents" for commits since a hash.
   * Uses `git log --stat` for file-change summaries without full diffs.
   */
  async getCommitTOC(
    sinceHash: string | null,
    maxCount: number
  ): Promise<{ hash: string; author: string; date: string; message: string; stat: string; linesChanged: number }[]> {
    const logArgs: string[] = [
      'log', `--max-count=${maxCount}`, '--no-merges',
      '--format=%H|%an|%ai|%s', '--stat', '--no-color',
    ];
    if (sinceHash) {
      logArgs.splice(1, 0, `${sinceHash}..HEAD`);
    }

    const raw = await this.git.raw(logArgs);
    const entries: { hash: string; author: string; date: string; message: string; stat: string; linesChanged: number }[] = [];
    const blocks = raw.split(/\n(?=[0-9a-f]{40}\|)/m);

    for (const block of blocks) {
      if (!block.trim()) continue;
      const firstLine = block.split('\n')[0];
      const [hash, author, date, ...msgParts] = firstLine.split('|');
      if (!hash || hash.length < 40) continue;

      const statLines = block.split('\n').slice(1).filter((l) => l.trim()).join('\n');

      // Parse "N insertions(+), N deletions(-)" from the stat summary line
      let linesChanged = 0;
      const insertMatch = statLines.match(/(\d+) insertion/);
      const deleteMatch = statLines.match(/(\d+) deletion/);
      if (insertMatch) linesChanged += parseInt(insertMatch[1], 10);
      if (deleteMatch) linesChanged += parseInt(deleteMatch[1], 10);

      entries.push({
        hash: hash.trim(),
        author: author?.trim() ?? '',
        date: date?.trim() ?? '',
        message: msgParts.join('|').trim(),
        stat: statLines,
        linesChanged,
      });
    }

    return entries;
  }

  /**
   * Get full diff for a single commit (used to pull details for complex commits).
   */
  async getFullDiffForCommit(hash: string): Promise<string> {
    return this.getDiffForCommit(hash);
  }

  /**
   * Get the commit hash that last touched a specific line in a file.
   * Uses `git blame -L line,line -- filePath`.
   */
  async blameLineHash(filePath: string, line: number): Promise<{ hash: string; author: string; message: string } | null> {
    try {
      const raw = await this.git.raw([
        'blame', '-L', `${line},${line}`, '--porcelain', '--', filePath,
      ]);
      const hashMatch = raw.match(/^([0-9a-f]{40})/m);
      const authorMatch = raw.match(/^author (.+)$/m);
      const summaryMatch = raw.match(/^summary (.+)$/m);
      if (!hashMatch) return null;
      return {
        hash: hashMatch[1],
        author: authorMatch?.[1] ?? 'Unknown',
        message: summaryMatch?.[1] ?? '',
      };
    } catch {
      return null;
    }
  }
}
