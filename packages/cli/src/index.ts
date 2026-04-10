#!/usr/bin/env node
import { Command } from 'commander';
import { RAGEngine, GitProcessor, GitHubService, type GitLoreConfig, DEFAULT_CONFIG } from '@gitlore/core';
import * as path from 'path';
import * as fs from 'fs';

const program = new Command();

/** Load config from .gitlore.json or env vars */
function loadConfig(): GitLoreConfig {
  const configPath = path.resolve(process.cwd(), '.gitlore.json');
  let fileConfig: Partial<GitLoreConfig> = {};

  if (fs.existsSync(configPath)) {
    fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  }

  return {
    ...DEFAULT_CONFIG,
    ...fileConfig,
    llmProvider: (process.env.GITLORE_LLM_PROVIDER as 'openai' | 'ollama') ?? fileConfig.llmProvider ?? DEFAULT_CONFIG.llmProvider,
    openaiModel: process.env.GITLORE_OPENAI_MODEL ?? fileConfig.openaiModel ?? DEFAULT_CONFIG.openaiModel,
    ollamaEndpoint: process.env.GITLORE_OLLAMA_ENDPOINT ?? fileConfig.ollamaEndpoint ?? DEFAULT_CONFIG.ollamaEndpoint,
    ollamaModel: process.env.GITLORE_OLLAMA_MODEL ?? fileConfig.ollamaModel ?? DEFAULT_CONFIG.ollamaModel,
    getApiKey: async () => process.env.OPENAI_API_KEY,
    getGitHubToken: async () => process.env.GITHUB_TOKEN,
    githubRepo: process.env.GITLORE_GITHUB_REPO,
  };
}

program
  .name('gitlore')
  .description('Chat with your Git history from the terminal')
  .version('0.1.0');

program
  .command('index')
  .description('Index the current repository')
  .option('-d, --depth <number>', 'Number of commits to index', '1000')
  .action(async (opts) => {
    const config = loadConfig();
    config.commitDepth = parseInt(opts.depth, 10);
    const engine = new RAGEngine(config);
    const repoPath = process.cwd();

    console.log(`Indexing ${repoPath} (depth: ${config.commitDepth})...`);

    await engine.indexRepository(repoPath, (phase, current, total) => {
      if (total > 0) {
        process.stdout.write(`\r  ${phase}: ${current}/${total}`);
      } else {
        process.stdout.write(`\r  ${phase}`);
      }
    });

    // Also index code files (with scale detection for adaptive chunking)
    console.log('\nIndexing code files...');
    const ghService = new GitHubService();
    const scale = await ghService.detectScale(repoPath);
    if (scale === 'large') console.log('  Large repo — enabling hierarchical chunking + SQ indices');

    const codeResult = await engine.indexCode(repoPath, (phase, current, total) => {
      if (total > 0) {
        process.stdout.write(`\r  ${phase}: ${current}/${total}`);
      } else {
        process.stdout.write(`\r  ${phase}`);
      }
    }, scale);

    console.log(`\nDone. ${codeResult.changedFiles} code files indexed (${codeResult.totalChunks} chunks).`);

    // Also index PRs from GitHub (optional — works without token for public repos)
    if (!process.env.GITHUB_TOKEN) {
      console.log('\n⚠ No GITHUB_TOKEN set — PR indexing will use unauthenticated access (60 req/hr).');
      console.log('  Set GITHUB_TOKEN for private repos or higher rate limits.');
    }
    try {
      console.log('\nIndexing PRs from GitHub...');
      const prResult = await engine.indexPRs(repoPath, (phase, current, total) => {
        if (total > 0) {
          process.stdout.write(`\r  ${phase}: ${current}/${total}`);
        } else {
          process.stdout.write(`\r  ${phase}`);
        }
      });
      console.log(`\nDone. ${prResult.prCount} PRs indexed.`);
    } catch {
      console.log('\nPR indexing skipped (no GitHub remote detected). Commits + code still fully functional.');
    }
  });

program
  .command('index-code')
  .description('Index only the current code files (incremental)')
  .action(async () => {
    const config = loadConfig();
    const engine = new RAGEngine(config);
    const repoPath = process.cwd();

    console.log('Indexing code files...');
    const ghService = new GitHubService();
    const scale = await ghService.detectScale(repoPath);
    if (scale === 'large') console.log('  Large repo — enabling hierarchical chunking');

    const result = await engine.indexCode(repoPath, (phase, current, total) => {
      if (total > 0) {
        process.stdout.write(`\r  ${phase}: ${current}/${total}`);
      } else {
        process.stdout.write(`\r  ${phase}`);
      }
    }, scale);

    if (result.changedFiles === 0) {
      console.log('\nCode index already up to date.');
    } else {
      console.log(`\nDone. ${result.changedFiles} files re-indexed (${result.totalChunks} chunks).`);
    }
  });

program
  .command('index-prs')
  .description('Index pull requests and issues from GitHub')
  .action(async () => {
    const config = loadConfig();
    const engine = new RAGEngine(config);
    const repoPath = process.cwd();

    console.log('Indexing PRs from GitHub...');
    try {
      const result = await engine.indexPRs(repoPath, (phase, current, total) => {
        if (total > 0) {
          process.stdout.write(`\r  ${phase}: ${current}/${total}`);
        } else {
          process.stdout.write(`\r  ${phase}`);
        }
      });
      console.log(`\nDone. ${result.prCount} PRs indexed.`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`\nFailed: ${msg}`);
      console.error('Set GITHUB_TOKEN env var for private repos or check the remote URL.');
      process.exit(1);
    }
  });

program
  .command('query <question>')
  .description('Ask a question about the repository history')
  .action(async (question: string) => {
    const config = loadConfig();
    const engine = new RAGEngine(config);
    const repoPath = process.cwd();

    await engine.query(repoPath, question, (chunk) => {
      process.stdout.write(chunk);
    });

    console.log();
  });

program
  .command('status')
  .description('Show index status')
  .action(async () => {
    const config = loadConfig();
    const engine = new RAGEngine(config);
    const repoPath = process.cwd();

    const status = await engine.getStatus(repoPath);
    if (status.indexed) {
      console.log(`Indexed: ${status.commitCount} commit chunks, ${status.codeFileCount} code chunks, ${status.prCount} PRs`);
      console.log(`Last indexed: ${status.lastIndexedAt}`);
      console.log(`Latest hash: ${status.lastIndexedHash}`);
    } else {
      console.log('Not indexed. Run `gitlore index` first.');
    }
  });

program
  .command('standup')
  .description('Summarize recent changes for a standup')
  .action(async () => {
    const config = loadConfig();
    const engine = new RAGEngine(config);
    const repoPath = process.cwd();

    await engine.summarizeRecent(repoPath, (chunk) => {
      process.stdout.write(chunk);
    });

    console.log();
  });

program
  .command('clear')
  .description('Clear the index')
  .action(async () => {
    const config = loadConfig();
    const engine = new RAGEngine(config);
    const repoPath = process.cwd();

    await engine.clearIndex(repoPath);
    console.log('Index cleared.');
  });

program.parse();
