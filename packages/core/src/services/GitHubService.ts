import { Octokit } from '@octokit/rest';
import { simpleGit } from 'simple-git';
import * as fs from 'fs';
import * as path from 'path';
import type { PRChunk } from '../types';

const PR_META_FILE = 'pr-meta.json';

/** Repos with more commits than this are treated as "large" */
const LARGE_REPO_COMMIT_THRESHOLD = 5000;
/** Concurrent page fetches for small repos */
const SMALL_REPO_CONCURRENCY = 3;

interface PRMeta {
  lastFetchedAt: string;
}

interface ParsedRepo {
  owner: string;
  repo: string;
}

export type RepoScale = 'small' | 'large';

export class GitHubService {
  private octokit: Octokit | null = null;
  private token: string | undefined;

  /** Whether a token was provided (for public vs private access) */
  get hasToken(): boolean {
    return !!this.token;
  }

  async init(token: string | undefined): Promise<void> {
    this.token = token;
    this.octokit = new Octokit(token ? { auth: token } : {});
  }

  /**
   * Detect owner/repo from the git remote origin URL.
   * Supports HTTPS (github.com/owner/repo.git) and SSH (git@github.com:owner/repo.git).
   */
  async detectRepo(repoPath: string): Promise<ParsedRepo | null> {
    try {
      const git = simpleGit(repoPath);
      const remotes = await git.getRemotes(true);
      const origin = remotes.find((r) => r.name === 'origin');
      if (!origin?.refs?.fetch) return null;

      const url = origin.refs.fetch;

      // SSH: git@github.com:owner/repo.git
      const sshMatch = url.match(/github\.com[:/]([^/]+)\/([^/.]+?)(?:\.git)?$/);
      if (sshMatch) return { owner: sshMatch[1], repo: sshMatch[2] };

      // HTTPS: https://github.com/owner/repo.git
      const httpsMatch = url.match(/github\.com\/([^/]+)\/([^/.]+?)(?:\.git)?$/);
      if (httpsMatch) return { owner: httpsMatch[1], repo: httpsMatch[2] };

      return null;
    } catch {
      return null;
    }
  }

  /**
   * Parse owner/repo from a "owner/repo" string.
   */
  parseRepoString(repoString: string): ParsedRepo | null {
    const parts = repoString.split('/');
    if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
    return { owner: parts[0], repo: parts[1] };
  }

  /**
   * Detect repo scale based on commit count.
   */
  async detectScale(repoPath: string): Promise<RepoScale> {
    try {
      const git = simpleGit(repoPath);
      const log = await git.raw(['rev-list', '--count', 'HEAD']);
      const count = parseInt(log.trim(), 10);
      return count > LARGE_REPO_COMMIT_THRESHOLD ? 'large' : 'small';
    } catch {
      return 'small'; // default safe
    }
  }

  /**
   * Fetch PRs from GitHub, optionally only those updated after `since`.
   * Adapts strategy based on repo scale:
   * - Small repos: concurrent page fetches, eager linked issue title resolution
   * - Large repos: sequential page fetches, issue numbers only (saves API rate limit)
   * NO page caps — all PRs are fetched regardless of repo size.
   */
  async fetchPRs(
    owner: string,
    repo: string,
    since?: string,
    onProgress?: (phase: string, current: number, total: number) => void,
    scale: RepoScale = 'small'
  ): Promise<PRChunk[]> {
    if (!this.octokit) throw new Error('GitHubService not initialized. Call init() first.');

    const perPage = 100;
    onProgress?.('Fetching PRs from GitHub', 0, 0);

    if (scale === 'small') {
      return this.fetchPRsConcurrent(owner, repo, perPage, since, onProgress);
    }
    return this.fetchPRsSequential(owner, repo, perPage, since, onProgress);
  }

  /**
   * Small repos: fetch multiple pages concurrently, resolve linked issue titles.
   */
  private async fetchPRsConcurrent(
    owner: string,
    repo: string,
    perPage: number,
    since?: string,
    onProgress?: (phase: string, current: number, total: number) => void
  ): Promise<PRChunk[]> {
    const chunks: PRChunk[] = [];
    let page = 1;
    let done = false;

    while (!done) {
      // Launch up to SMALL_REPO_CONCURRENCY pages in parallel
      const pageNumbers = Array.from({ length: SMALL_REPO_CONCURRENCY }, (_, i) => page + i);
      const results = await Promise.all(
        pageNumbers.map((p) =>
          this.octokit!.pulls.list({
            owner, repo, state: 'all', sort: 'updated',
            direction: 'desc', per_page: perPage, page: p,
          }).then((r) => r.data)
        )
      );

      for (const prs of results) {
        if (prs.length === 0) { done = true; break; }
        for (const pr of prs) {
          if (since && pr.updated_at < since) { done = true; break; }
          chunks.push(await this.prToChunk(owner, repo, pr, 'small'));
        }
        if (done) break;
      }

      page += SMALL_REPO_CONCURRENCY;
      onProgress?.(`Fetching PRs (${chunks.length} so far)`, chunks.length, 0);
    }

    onProgress?.(`Fetched ${chunks.length} PRs`, chunks.length, chunks.length);
    return chunks;
  }

  /**
   * Large repos: sequential page fetches, no issue title resolution (saves rate limit).
   * Fetches ALL pages — no caps.
   */
  private async fetchPRsSequential(
    owner: string,
    repo: string,
    perPage: number,
    since?: string,
    onProgress?: (phase: string, current: number, total: number) => void
  ): Promise<PRChunk[]> {
    const chunks: PRChunk[] = [];
    let page = 1;

    while (true) {
      const { data: prs } = await this.octokit!.pulls.list({
        owner, repo, state: 'all', sort: 'updated',
        direction: 'desc', per_page: perPage, page,
      });

      if (prs.length === 0) break;

      for (const pr of prs) {
        if (since && pr.updated_at < since) {
          onProgress?.(`Fetched ${chunks.length} PRs`, chunks.length, chunks.length);
          return chunks;
        }
        chunks.push(await this.prToChunk(owner, repo, pr, 'large'));
      }

      onProgress?.(`Fetching PRs (page ${page}, ${chunks.length} so far)`, chunks.length, 0);
      page++;
    }

    onProgress?.(`Fetched ${chunks.length} PRs`, chunks.length, chunks.length);
    return chunks;
  }

  /**
   * Convert a GitHub PR response into a PRChunk.
   * Small repos: eagerly fetch linked issue titles (up to 5).
   * Large repos: use issue numbers only.
   */
  private async prToChunk(
    owner: string,
    repo: string,
    pr: { number: number; title: string; body: string | null; state: string; merged_at: string | null; user: { login: string } | null; created_at: string; merge_commit_sha: string | null; updated_at: string },
    scale: RepoScale
  ): Promise<PRChunk> {
    const linkedIssueNums = this.parseLinkedIssues(pr.body ?? '');
    const issueLabels: string[] = [];

    if (scale === 'small') {
      for (const issueNum of linkedIssueNums.slice(0, 5)) {
        try {
          const { data: issue } = await this.octokit!.issues.get({
            owner, repo, issue_number: issueNum,
          });
          issueLabels.push(`${issue.title} (#${issueNum})`);
        } catch {
          issueLabels.push(`#${issueNum}`);
        }
      }
    } else {
      for (const issueNum of linkedIssueNums) {
        issueLabels.push(`#${issueNum}`);
      }
    }

    const state: PRChunk['state'] = pr.merged_at
      ? 'merged'
      : pr.state === 'closed' ? 'closed' : 'open';

    return {
      prNumber: pr.number,
      title: pr.title,
      description: (pr.body ?? '').slice(0, 2000),
      state,
      author: pr.user?.login ?? 'unknown',
      createdAt: pr.created_at,
      mergedAt: pr.merged_at ?? '',
      linkedIssues: issueLabels.join(', '),
      resolvedBy: pr.merge_commit_sha ?? '',
    };
  }

  /**
   * Parse "Closes #N", "Fixes #N", "Resolves #N" from PR body.
   */
  parseLinkedIssues(body: string): number[] {
    const pattern = /(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/gi;
    const issues: number[] = [];
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(body)) !== null) {
      const num = parseInt(match[1], 10);
      if (!issues.includes(num)) {
        issues.push(num);
      }
    }

    return issues;
  }

  /**
   * Build the text representation for embedding a PR.
   */
  toEmbeddingText(chunk: PRChunk): string {
    const parts = [
      `PR #${chunk.prNumber}: ${chunk.title}`,
      `State: ${chunk.state} | Author: ${chunk.author}`,
    ];
    if (chunk.description) parts.push(chunk.description);
    if (chunk.linkedIssues) parts.push(`Linked issues: ${chunk.linkedIssues}`);
    if (chunk.resolvedBy) parts.push(`Merge commit: ${chunk.resolvedBy.substring(0, 8)}`);
    return parts.join('\n');
  }

  // ─── Metadata persistence ───

  saveMeta(storePath: string): void {
    const meta: PRMeta = { lastFetchedAt: new Date().toISOString() };
    const metaPath = path.join(storePath, PR_META_FILE);
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  }

  loadMeta(storePath: string): PRMeta | null {
    const metaPath = path.join(storePath, PR_META_FILE);
    try {
      const raw = fs.readFileSync(metaPath, 'utf-8');
      return JSON.parse(raw) as PRMeta;
    } catch {
      return null;
    }
  }
}
