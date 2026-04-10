import simpleGit, { type SimpleGit } from 'simple-git';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { CodeChunk } from '../types';
import type { ProgressCallback } from './GitProcessor';

// ─── Chunk Settings ───
const CHUNK_LINES = 256;
const OVERLAP_LINES = 50;
/** Lines from head/tail used to build a file-level summary for large repos */
const SUMMARY_HEAD_LINES = 80;
const SUMMARY_TAIL_LINES = 40;

// ─── Language Detection ───
const LANG_MAP: Record<string, string> = {
  '.ts': 'typescript', '.tsx': 'typescript', '.js': 'javascript', '.jsx': 'javascript',
  '.mjs': 'javascript', '.cjs': 'javascript', '.py': 'python', '.go': 'go',
  '.rs': 'rust', '.java': 'java', '.c': 'c', '.cpp': 'cpp', '.h': 'c',
  '.hpp': 'cpp', '.cs': 'csharp', '.rb': 'ruby', '.swift': 'swift',
  '.kt': 'kotlin', '.kts': 'kotlin', '.scala': 'scala', '.ex': 'elixir',
  '.exs': 'elixir', '.vue': 'vue', '.svelte': 'svelte',
  '.sql': 'sql', '.graphql': 'graphql', '.gql': 'graphql', '.proto': 'protobuf',
  '.sh': 'shell', '.bash': 'shell', '.zsh': 'shell', '.ps1': 'powershell',
  '.lua': 'lua', '.r': 'r', '.m': 'matlab',
  '.json': 'json', '.yaml': 'yaml', '.yml': 'yaml', '.toml': 'toml',
  '.xml': 'xml', '.html': 'html', '.css': 'css', '.scss': 'scss',
  '.md': 'markdown', '.txt': 'text',
};

// ─── Exclusions (reuse same logic as GitProcessor) ───
const EXCLUDED_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.svg', '.bmp',
  '.mp4', '.mp3', '.wav', '.ogg', '.webm', '.mov', '.avi',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.zip', '.tar', '.gz', '.bz2', '.7z', '.rar',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.wasm',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.lock',
]);

const EXCLUDED_FILENAMES = new Set([
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
  'composer.lock', 'Gemfile.lock', 'Cargo.lock',
  'poetry.lock', 'Pipfile.lock',
]);

const SENSITIVE_PATTERNS = [
  /\.env(\..+)?$/i, /\.secret/i, /\.pem$/i, /\.key$/i,
  /\.crt$/i, /\.p12$/i, /\.pfx$/i, /id_rsa/i, /id_ed25519/i,
];

const EXCLUDED_DIRS = [
  '.vscode/git-lore/', '.git/', 'node_modules/', 'dist/', 'build/',
  '.next/', '.nuxt/', '.output/', '__pycache__/', '.pytest_cache/',
  'coverage/', '.nyc_output/', '.turbo/', '.cache/',
];

function isExcluded(filePath: string): boolean {
  if (EXCLUDED_DIRS.some((d) => filePath.startsWith(d) || filePath.includes('/' + d))) return true;
  const ext = extOf(filePath);
  if (EXCLUDED_EXTENSIONS.has(ext)) return true;
  const fileName = filePath.split('/').pop() ?? filePath;
  if (EXCLUDED_FILENAMES.has(fileName)) return true;
  if (SENSITIVE_PATTERNS.some((p) => p.test(filePath))) return true;
  return false;
}

function extOf(filePath: string): string {
  const dot = filePath.lastIndexOf('.');
  return dot === -1 ? '' : filePath.slice(dot).toLowerCase();
}

// ─── Code Meta ───
const CODE_META_FILE = 'code-meta.json';

interface CodeMeta {
  /** filePath → SHA-256 of content */
  fileHashes: Record<string, string>;
  lastIndexedAt: string;
}

export class CodeIndexer {
  private git: SimpleGit;
  private repoPath: string;

  constructor(repoPath: string) {
    this.repoPath = repoPath;
    this.git = simpleGit(repoPath, { maxConcurrentProcesses: 4 });
  }

  /**
   * List all tracked files via `git ls-files` (respects .gitignore).
   * Filters out excluded/binary/sensitive files.
   */
  async listFiles(): Promise<string[]> {
    const raw = await this.git.raw(['ls-files', '--cached', '--others', '--exclude-standard']);
    return raw
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !isExcluded(l));
  }

  /**
   * Chunk a single file into 256-line windows with 50-line overlap.
   * When hierarchical=true (large repos), also produces a file-level summary chunk.
   * Returns the chunks + a content hash for incremental detection.
   */
  chunkFile(filePath: string, content: string, hierarchical = false): { chunks: CodeChunk[]; contentHash: string } {
    const contentHash = crypto.createHash('sha256').update(content).digest('hex');
    const lines = content.split('\n');
    const chunks: CodeChunk[] = [];
    const ext = extOf(filePath);
    const language = LANG_MAP[ext] ?? 'unknown';

    // Hierarchical: add a summary chunk for large repos
    if (hierarchical && lines.length > CHUNK_LINES) {
      const summaryContent = this.buildFileSummary(filePath, lines, language);
      chunks.push({
        filePath,
        language,
        startLine: 1,
        endLine: lines.length,
        content: summaryContent,
        isSummary: true,
      });
    }

    for (let start = 0; start < lines.length; start += CHUNK_LINES - OVERLAP_LINES) {
      const end = Math.min(start + CHUNK_LINES, lines.length);
      const chunkContent = lines.slice(start, end).join('\n');

      // Skip nearly-empty chunks (< 3 non-blank lines)
      if (chunkContent.replace(/\s/g, '').length < 20) continue;

      chunks.push({
        filePath,
        language,
        startLine: start + 1, // 1-based
        endLine: end,
        content: chunkContent,
      });

      if (end >= lines.length) break;
    }

    return { chunks, contentHash };
  }

  /**
   * Build a condensed file summary: head lines + tail lines + basic stats.
   * This gives the embedding model a birds-eye view of the file.
   */
  private buildFileSummary(filePath: string, lines: string[], language: string): string {
    const totalLines = lines.length;
    const head = lines.slice(0, SUMMARY_HEAD_LINES).join('\n');
    const tail = lines.slice(-SUMMARY_TAIL_LINES).join('\n');

    return [
      `[SUMMARY] File: ${filePath} | Language: ${language} | ${totalLines} lines`,
      '--- HEAD ---',
      head,
      '--- TAIL ---',
      tail,
    ].join('\n');
  }

  /**
   * Full code index: list files → read → chunk → return all chunks + new meta.
   * Only re-chunks files whose content hash changed since last index.
   * When hierarchical=true (large repos), generates file-level summary chunks
   * in addition to the regular 256-line detail chunks.
   */
  async indexAll(
    storePath: string,
    onProgress?: ProgressCallback,
    hierarchical = false
  ): Promise<{ chunks: CodeChunk[]; meta: CodeMeta; changedFiles: string[] }> {
    const previousMeta = this.loadMeta(storePath);
    const previousHashes = previousMeta?.fileHashes ?? {};

    const files = await this.listFiles();
    const allChunks: CodeChunk[] = [];
    const newHashes: Record<string, string> = {};
    const changedFiles: string[] = [];

    for (let i = 0; i < files.length; i++) {
      const relPath = files[i];
      onProgress?.('Scanning code files', i + 1, files.length);

      const absPath = path.join(this.repoPath, relPath);
      let content: string;
      try {
        content = fs.readFileSync(absPath, 'utf-8');
      } catch {
        continue; // file deleted between ls-files and read
      }

      // Quick hash check for incremental
      const quickHash = crypto.createHash('sha256').update(content).digest('hex');
      newHashes[relPath] = quickHash;

      if (previousHashes[relPath] === quickHash) {
        continue; // unchanged — skip re-chunking
      }

      changedFiles.push(relPath);
      const { chunks } = this.chunkFile(relPath, content, hierarchical);
      allChunks.push(...chunks);
    }

    const meta: CodeMeta = {
      fileHashes: newHashes,
      lastIndexedAt: new Date().toISOString(),
    };

    return { chunks: allChunks, meta, changedFiles };
  }

  /**
   * Build embedding text for a code chunk.
   * Summary chunks use [SUMMARY] prefix; detail chunks use [CODE].
   */
  toEmbeddingText(chunk: CodeChunk): string {
    if (chunk.isSummary) {
      return chunk.content; // Summary already includes the [SUMMARY] header
    }
    return [
      `[CODE] File: ${chunk.filePath} | Language: ${chunk.language} | Lines ${chunk.startLine}-${chunk.endLine}`,
      chunk.content,
    ].join('\n');
  }

  // ─── Meta persistence ───

  saveMeta(storePath: string, meta: CodeMeta): void {
    const metaPath = path.join(storePath, CODE_META_FILE);
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  }

  loadMeta(storePath: string): CodeMeta | null {
    const metaPath = path.join(storePath, CODE_META_FILE);
    try {
      const raw = fs.readFileSync(metaPath, 'utf-8');
      return JSON.parse(raw) as CodeMeta;
    } catch {
      return null;
    }
  }

  /**
   * List files that were removed since last index (present in old meta but not in current ls-files).
   */
  async getDeletedFiles(storePath: string): Promise<string[]> {
    const previousMeta = this.loadMeta(storePath);
    if (!previousMeta) return [];

    const currentFiles = new Set(await this.listFiles());
    return Object.keys(previousMeta.fileHashes).filter((f) => !currentFiles.has(f));
  }
}
