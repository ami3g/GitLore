#!/usr/bin/env node
import { Command } from 'commander';
import {
  RAGEngine, GitProcessor, GitHubService, CodeIndexer, EmbeddingService, VectorStore,
  ASTService, CallGraphService, MermaidService,
  type GitLoreConfig, DEFAULT_CONFIG, type PRChunk
} from '@gitlore/core';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

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
  .option('--top-k <number>', 'Number of results to retrieve (higher = more context)', '10')
  .action(async (question: string, opts: { topK: string }) => {
    const config = loadConfig();
    const engine = new RAGEngine(config);
    const repoPath = process.cwd();

    await engine.query(repoPath, question, (chunk) => {
      process.stdout.write(chunk);
    }, undefined, undefined, parseInt(opts.topK, 10));

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

// ─── Diagram Commands ───

const diagram = program
  .command('diagram')
  .description('Generate Mermaid diagrams from the indexed codebase');

/** Shared helper: parse all code files and build call graph */
async function buildASTAndCallGraph(repoPath: string) {
  const grammarDir = path.join(os.homedir(), '.gitlore', 'grammars');
  const ast = new ASTService(grammarDir);
  await ast.init();

  const indexer = new CodeIndexer(repoPath);
  const files = await indexer.listFiles();

  console.error(`Parsing ${files.length} files for AST...`);
  const fileContents: { filePath: string; content: string; language: string }[] = [];

  for (const relPath of files) {
    const absPath = path.join(repoPath, relPath);
    try {
      const content = fs.readFileSync(absPath, 'utf-8');
      const ext = path.extname(relPath).toLowerCase();
      const langMap: Record<string, string> = {
        '.ts': 'typescript', '.tsx': 'tsx', '.js': 'javascript', '.jsx': 'javascript',
        '.py': 'python', '.go': 'go', '.rs': 'rust', '.java': 'java',
        '.c': 'c', '.cpp': 'cpp', '.h': 'c', '.hpp': 'cpp',
      };
      const language = langMap[ext];
      if (language) {
        fileContents.push({ filePath: relPath, content, language });
      }
    } catch {
      // Skip unreadable files
    }
  }

  const allSymbols = await ast.parseFiles(fileContents);
  console.error(`Parsed ${allSymbols.size} files. Building call graph...`);

  const cg = new CallGraphService();
  const edges = cg.buildGraph(allSymbols);
  console.error(`Call graph: ${edges.length} edges.`);

  ast.dispose();
  return { allSymbols, edges, cg };
}

diagram
  .command('architecture')
  .description('Generate a code architecture Mermaid diagram')
  .action(async () => {
    const repoPath = process.cwd();
    const { allSymbols, edges } = await buildASTAndCallGraph(repoPath);
    const mermaid = new MermaidService();
    console.log(mermaid.generateCodeArchitecture(allSymbols, edges));
  });

diagram
  .command('callgraph')
  .description('Generate a call graph Mermaid diagram')
  .option('--entry <function>', 'Entry function to trace from')
  .action(async (opts) => {
    const repoPath = process.cwd();
    const { allSymbols, edges, cg } = await buildASTAndCallGraph(repoPath);
    const mermaid = new MermaidService();

    let closure: { file: string; name: string }[] | undefined;

    if (opts.entry) {
      // Find the entry function across all files
      for (const [file, symbols] of allSymbols) {
        const fn = symbols.functions.find((f) => f.name === opts.entry);
        if (fn) {
          closure = cg.getTransitiveClosure(file, fn.name, edges);
          console.error(`Tracing from ${fn.name} in ${file}: ${closure.length} reachable functions`);
          break;
        }
      }
      if (!closure) {
        console.error(`Warning: function '${opts.entry}' not found, showing full graph`);
      }
    }

    console.log(mermaid.generateCallGraph(edges, closure));
  });

diagram
  .command('commits')
  .description('Generate a commit timeline Mermaid diagram')
  .option('--limit <number>', 'Maximum number of commits', '30')
  .action(async (opts) => {
    const repoPath = process.cwd();
    const storePath = path.join(repoPath, '.vscode', 'git-lore');

    const store = new VectorStore(path.join(storePath, 'db'));
    const status = await store.getStatus();

    if (!status.indexed || status.commitCount === 0) {
      console.error('No commits indexed. Run `gitlore index` first.');
      process.exit(1);
    }

    const cacheDir = path.join(storePath, 'models');
    const embedding = new EmbeddingService(cacheDir);
    const queryVec = await embedding.embed('recent commits changes update');

    const results = await store.search(queryVec, parseInt(opts.limit, 10));
    const commits = results
      .filter((r) => r.type === 'commit')
      .map((r) => r.chunk as any);

    const mermaid = new MermaidService();
    console.log(mermaid.generateCommitTimeline(commits, parseInt(opts.limit, 10)));
  });

diagram
  .command('prs')
  .description('Generate a PR/Issue flow Mermaid diagram')
  .action(async () => {
    const repoPath = process.cwd();
    const storePath = path.join(repoPath, '.vscode', 'git-lore');

    const store = new VectorStore(path.join(storePath, 'db'));
    const status = await store.getStatus();

    if (status.prCount === 0) {
      console.error('No PRs indexed. Run `gitlore index-prs` first.');
      process.exit(1);
    }

    const cacheDir = path.join(storePath, 'models');
    const embedding = new EmbeddingService(cacheDir);
    const queryVec = await embedding.embed('all pull requests issues');

    const results = await store.searchPR(queryVec, 100);
    const prs = results
      .filter((r) => r.type === 'pr')
      .map((r) => r.chunk as PRChunk);

    const mermaid = new MermaidService();
    console.log(mermaid.generatePRIssueFlow(prs));
  });

program.parse();
