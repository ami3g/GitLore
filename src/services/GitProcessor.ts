import simpleGit, { type SimpleGit, type DefaultLogFields, type ListLogLine } from 'simple-git';
import type { CommitChunk } from '../types';

const MAX_DIFF_LENGTH = 2000;

export type ProgressCallback = (phase: string, current: number, total: number) => void;

export class GitProcessor {
  private git: SimpleGit;

  constructor(repoPath: string) {
    this.git = simpleGit(repoPath, { maxConcurrentProcesses: 4 });
  }

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
        const { condensed, filesChanged } = this.condenseDiff(diff);

        chunks.push({
          hash: commit.hash,
          author: commit.author_name,
          date: commit.date,
          message: commit.message,
          condensedDiff: condensed,
          filesChanged,
        });
      } catch {
        // Skip commits that fail (e.g., initial commit with no parent)
        chunks.push({
          hash: commit.hash,
          author: commit.author_name,
          date: commit.date,
          message: commit.message,
          condensedDiff: '',
          filesChanged: [],
        });
      }
    }

    return chunks;
  }

  private async getDiffForCommit(hash: string): Promise<string> {
    // git show produces the patch for a single commit
    const result = await this.git.show([
      hash,
      '--stat',
      '--patch',
      '--no-color',
      '--format=',
    ]);
    return result;
  }

  private condenseDiff(diff: string): { condensed: string; filesChanged: string[] } {
    if (!diff) {
      return { condensed: '', filesChanged: [] };
    }

    const filesChanged: string[] = [];
    const lines = diff.split('\n');
    const condensedParts: string[] = [];
    let currentLength = 0;

    for (const line of lines) {
      // Extract file names from diff headers
      if (line.startsWith('diff --git')) {
        const match = line.match(/b\/(.+)$/);
        if (match) {
          filesChanged.push(match[1]);
        }
      }

      // Keep: file headers, hunk headers, and changed lines (prioritize context)
      if (
        line.startsWith('diff --git') ||
        line.startsWith('---') ||
        line.startsWith('+++') ||
        line.startsWith('@@') ||
        line.startsWith('+') ||
        line.startsWith('-')
      ) {
        if (currentLength + line.length + 1 > MAX_DIFF_LENGTH) {
          condensedParts.push('... [diff truncated]');
          break;
        }
        condensedParts.push(line);
        currentLength += line.length + 1;
      }
    }

    return {
      condensed: condensedParts.join('\n'),
      filesChanged: [...new Set(filesChanged)],
    };
  }

  toEmbeddingText(chunk: CommitChunk): string {
    const parts = [
      `Commit: ${chunk.hash.substring(0, 8)}`,
      `Author: ${chunk.author}`,
      `Date: ${chunk.date}`,
      `Message: ${chunk.message}`,
    ];
    if (chunk.filesChanged.length > 0) {
      parts.push(`Files: ${chunk.filesChanged.join(', ')}`);
    }
    if (chunk.condensedDiff) {
      parts.push(`Diff:\n${chunk.condensedDiff}`);
    }
    return parts.join('\n');
  }
}
