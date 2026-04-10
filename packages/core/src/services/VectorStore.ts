import * as lancedb from '@lancedb/lancedb';
import { Index } from '@lancedb/lancedb';
import type { Table } from '@lancedb/lancedb';
import * as fs from 'fs';
import * as path from 'path';
import type { CommitChunk, CodeChunk, PRChunk, SearchResult, IndexStatus, CallEdge } from '../types';

const COMMITS_TABLE = 'commits';
const CODE_TABLE = 'code_files';
const PR_TABLE = 'pr_data';
const CALL_GRAPH_TABLE = 'call_graph';
const META_FILE = 'index-meta.json';
/** Minimum row count before creating an HNSW-SQ index (below this brute-force is faster) */
const SQ_INDEX_THRESHOLD = 10000;
/** Refine factor for SQ-indexed searches — fetch Nx candidates, re-rank with full vectors */
const SQ_REFINE_FACTOR = 3;
/** Marker file that persists SQ-enabled state across sessions */
const SQ_MARKER = 'sq-enabled';

interface IndexMeta {
  lastIndexedHash: string;
  lastIndexedAt: string;
}

type CommitRecord = Record<string, unknown> & {
  vector: number[];
  hash: string;
  author: string;
  date: string;
  message: string;
  filePath: string;
  condensedDiff: string;
  filesChanged: string;
};

type CodeRecord = Record<string, unknown> & {
  vector: number[];
  filePath: string;
  language: string;
  startLine: number;
  endLine: number;
  content: string;
  isSummary: number; // 1 for summary, 0 for detail (LanceDB doesn't persist booleans well)
};

type PRRecord = Record<string, unknown> & {
  vector: number[];
  prNumber: number;
  title: string;
  description: string;
  state: string;
  author: string;
  mergedBy: string;
  createdAt: string;
  mergedAt: string;
  linkedIssues: string;
  resolvedBy: string;
};

export class VectorStore {
  private db: lancedb.Connection | null = null;
  private commitTable: Table | null = null;
  private codeTable: Table | null = null;
  private prTable: Table | null = null;
  private callGraphTable: Table | null = null;
  private dbPath: string;
  /** Cached SQ state — null means not yet checked */
  private sqEnabled: boolean | null = null;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  private async connect(): Promise<lancedb.Connection> {
    if (!this.db) {
      this.db = await lancedb.connect(this.dbPath);
    }
    return this.db;
  }

  async createTable(
    chunks: CommitChunk[],
    embeddings: number[][]
  ): Promise<void> {
    const db = await this.connect();

    const records: CommitRecord[] = chunks.map((chunk, i) => ({
      vector: embeddings[i],
      hash: chunk.hash,
      author: chunk.author,
      date: chunk.date,
      message: chunk.message,
      filePath: chunk.filePath,
      condensedDiff: chunk.condensedDiff,
      filesChanged: chunk.filesChanged.join(','),
    }));

    // Drop existing table if it exists
    try {
      await db.dropTable(COMMITS_TABLE);
    } catch {
      // Table doesn't exist yet — OK
    }

    this.commitTable = await db.createTable(COMMITS_TABLE, records);
  }

  /**
   * Append new records to an existing table (incremental indexing).
   */
  async addRecords(
    chunks: CommitChunk[],
    embeddings: number[][]
  ): Promise<void> {
    const table = await this.getCommitTable();
    if (!table) {
      throw new Error('Cannot append — no existing index. Run a full index first.');
    }

    const records: CommitRecord[] = chunks.map((chunk, i) => ({
      vector: embeddings[i],
      hash: chunk.hash,
      author: chunk.author,
      date: chunk.date,
      message: chunk.message,
      filePath: chunk.filePath,
      condensedDiff: chunk.condensedDiff,
      filesChanged: chunk.filesChanged.join(','),
    }));

    await table.add(records);
  }

  // ─── Metadata persistence ───

  saveMeta(lastIndexedHash: string): void {
    const meta: IndexMeta = {
      lastIndexedHash,
      lastIndexedAt: new Date().toISOString(),
    };
    const metaPath = path.join(this.dbPath, '..', META_FILE);
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  }

  loadMeta(): IndexMeta | null {
    const metaPath = path.join(this.dbPath, '..', META_FILE);
    try {
      const raw = fs.readFileSync(metaPath, 'utf-8');
      return JSON.parse(raw) as IndexMeta;
    } catch {
      return null;
    }
  }

  async search(queryEmbedding: number[], topK: number): Promise<SearchResult[]> {
    const table = await this.getCommitTable();
    if (!table) {
      throw new Error('Index not found. Please index the repository first.');
    }

    let query = table.vectorSearch(queryEmbedding).limit(topK);
    if (await this.isSQEnabled()) {
      query = query.refineFactor(SQ_REFINE_FACTOR);
    }
    const results = await query.toArray();

    return results.map((row: Record<string, unknown>) => ({
      type: 'commit' as const,
      chunk: {
        hash: row['hash'] as string,
        author: row['author'] as string,
        date: row['date'] as string,
        message: row['message'] as string,
        filePath: row['filePath'] as string,
        condensedDiff: row['condensedDiff'] as string,
        filesChanged: (row['filesChanged'] as string).split(',').filter(Boolean),
      },
      score: row['_distance'] as number,
    }));
  }

  /**
   * Fetch commits by merge commit SHA hash (for temporal chain: PR → linked commits).
   * Searches the commit table for rows where the hash starts with the given prefix.
   */
  async searchCommitsByHash(hashPrefix: string): Promise<SearchResult[]> {
    const table = await this.getCommitTable();
    if (!table || !hashPrefix) return [];

    try {
      const escaped = hashPrefix.replace(/'/g, "''");
      const results = await table
        .query()
        .where(`hash LIKE '${escaped}%'`)
        .toArray();

      return results.map((row: Record<string, unknown>) => ({
        type: 'commit' as const,
        chunk: {
          hash: row['hash'] as string,
          author: row['author'] as string,
          date: row['date'] as string,
          message: row['message'] as string,
          filePath: row['filePath'] as string,
          condensedDiff: row['condensedDiff'] as string,
          filesChanged: (row['filesChanged'] as string).split(',').filter(Boolean),
        },
        score: 0, // direct lookup — best possible score
      }));
    } catch {
      return [];
    }
  }

  /**
   * Search code chunks filtered to those with AST metadata ([DEFINES]/[EXPORTS]).
   * Used to boost structural chunks when implementation intent is high.
   */
  async searchCodeWithAST(
    queryEmbedding: number[],
    topK: number
  ): Promise<SearchResult[]> {
    const table = await this.getCodeTable();
    if (!table) return [];

    try {
      let query = table.vectorSearch(queryEmbedding)
        .where(`content LIKE '%[DEFINES]%' OR content LIKE '%[EXPORTS]%'`)
        .limit(topK);
      if (await this.isSQEnabled()) {
        query = query.refineFactor(SQ_REFINE_FACTOR);
      }
      const results = await query.toArray();

      return results.map((row: Record<string, unknown>) => ({
        type: 'code' as const,
        chunk: {
          filePath: row['filePath'] as string,
          language: row['language'] as string,
          startLine: row['startLine'] as number,
          endLine: row['endLine'] as number,
          content: row['content'] as string,
          isSummary: (row['isSummary'] as number) === 1,
        },
        score: row['_distance'] as number,
      }));
    } catch {
      // Fallback: if the WHERE clause fails (e.g. old index without AST metadata),
      // return empty — regular code search will still work
      return [];
    }
  }

  // ─── Code Files Table ───

  async createCodeTable(
    chunks: CodeChunk[],
    embeddings: number[][]
  ): Promise<void> {
    const db = await this.connect();

    const records: CodeRecord[] = chunks.map((chunk, i) => ({
      vector: embeddings[i],
      filePath: chunk.filePath,
      language: chunk.language,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      content: chunk.content,
      isSummary: chunk.isSummary ? 1 : 0,
    }));

    try {
      await db.dropTable(CODE_TABLE);
    } catch { /* OK */ }

    this.codeTable = await db.createTable(CODE_TABLE, records);
  }

  async addCodeRecords(
    chunks: CodeChunk[],
    embeddings: number[][]
  ): Promise<void> {
    const table = await this.getCodeTable();
    if (!table) {
      throw new Error('Cannot append code records — no existing code index.');
    }

    const records: CodeRecord[] = chunks.map((chunk, i) => ({
      vector: embeddings[i],
      filePath: chunk.filePath,
      language: chunk.language,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      content: chunk.content,
      isSummary: chunk.isSummary ? 1 : 0,
    }));

    await table.add(records);
  }

  /**
   * Remove all code records for specific files, then insert new ones.
   * Used for incremental code re-indexing.
   */
  async upsertCodeFiles(
    filePaths: string[],
    newChunks: CodeChunk[],
    newEmbeddings: number[][]
  ): Promise<void> {
    const table = await this.getCodeTable();

    if (!table) {
      // No code table yet — create it
      if (newChunks.length > 0) {
        await this.createCodeTable(newChunks, newEmbeddings);
      }
      return;
    }

    // Delete old rows for changed files
    for (const fp of filePaths) {
      try {
        await table.delete(`filePath = '${fp.replace(/'/g, "''")}'`);
      } catch { /* OK — row may not exist */ }
    }

    // Insert new chunks
    if (newChunks.length > 0) {
      const records: CodeRecord[] = newChunks.map((chunk, i) => ({
        vector: newEmbeddings[i],
        filePath: chunk.filePath,
        language: chunk.language,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        content: chunk.content,
        isSummary: chunk.isSummary ? 1 : 0,
      }));
      await table.add(records);
    }
  }

  /**
   * Remove code records for deleted files.
   */
  async removeCodeFiles(filePaths: string[]): Promise<void> {
    const table = await this.getCodeTable();
    if (!table) return;

    for (const fp of filePaths) {
      try {
        await table.delete(`filePath = '${fp.replace(/'/g, "''")}'`);
      } catch { /* OK */ }
    }
  }

  // ─── PR Data Table ───

  async createPRTable(
    chunks: PRChunk[],
    embeddings: number[][]
  ): Promise<void> {
    const db = await this.connect();

    const records: PRRecord[] = chunks.map((chunk, i) => ({
      vector: embeddings[i],
      prNumber: chunk.prNumber,
      title: chunk.title,
      description: chunk.description,
      state: chunk.state,
      author: chunk.author,
      mergedBy: chunk.mergedBy,
      createdAt: chunk.createdAt,
      mergedAt: chunk.mergedAt,
      linkedIssues: chunk.linkedIssues,
      resolvedBy: chunk.resolvedBy,
    }));

    try { await db.dropTable(PR_TABLE); } catch { /* OK */ }
    this.prTable = await db.createTable(PR_TABLE, records);
  }

  async addPRRecords(
    chunks: PRChunk[],
    embeddings: number[][]
  ): Promise<void> {
    const table = await this.getPRTable();
    if (!table) {
      throw new Error('Cannot append PR records — no existing PR index.');
    }

    const records: PRRecord[] = chunks.map((chunk, i) => ({
      vector: embeddings[i],
      prNumber: chunk.prNumber,
      title: chunk.title,
      description: chunk.description,
      state: chunk.state,
      author: chunk.author,
      mergedBy: chunk.mergedBy,
      createdAt: chunk.createdAt,
      mergedAt: chunk.mergedAt,
      linkedIssues: chunk.linkedIssues,
      resolvedBy: chunk.resolvedBy,
    }));

    await table.add(records);
  }

  async searchPR(queryEmbedding: number[], topK: number): Promise<SearchResult[]> {
    const table = await this.getPRTable();
    if (!table) return [];

    let query = table.vectorSearch(queryEmbedding).limit(topK);
    if (await this.isSQEnabled()) {
      query = query.refineFactor(SQ_REFINE_FACTOR);
    }
    const results = await query.toArray();

    return results.map((row: Record<string, unknown>) => ({
      type: 'pr' as const,
      chunk: {
        prNumber: row['prNumber'] as number,
        title: row['title'] as string,
        description: row['description'] as string,
        state: row['state'] as PRChunk['state'],
        author: row['author'] as string,
        mergedBy: row['mergedBy'] as string ?? '',
        createdAt: row['createdAt'] as string,
        mergedAt: row['mergedAt'] as string,
        linkedIssues: row['linkedIssues'] as string,
        resolvedBy: row['resolvedBy'] as string,
      },
      score: row['_distance'] as number,
    }));
  }

  async getPRCount(): Promise<number> {
    const table = await this.getPRTable();
    if (!table) return 0;
    return table.countRows();
  }

  async searchCode(queryEmbedding: number[], topK: number): Promise<SearchResult[]> {
    const table = await this.getCodeTable();
    if (!table) return [];

    let query = table.vectorSearch(queryEmbedding).limit(topK);
    if (await this.isSQEnabled()) {
      query = query.refineFactor(SQ_REFINE_FACTOR);
    }
    const results = await query.toArray();

    return results.map((row: Record<string, unknown>) => ({
      type: 'code' as const,
      chunk: {
        filePath: row['filePath'] as string,
        language: row['language'] as string,
        startLine: row['startLine'] as number,
        endLine: row['endLine'] as number,
        content: row['content'] as string,
        isSummary: (row['isSummary'] as number) === 1,
      },
      score: row['_distance'] as number,
    }));
  }

  /**
   * Search code with optional directory scoping (large repos).
   * When directoryPrefix is set, only results with matching filePath are returned.
   */
  async searchCodeScoped(
    queryEmbedding: number[],
    topK: number,
    directoryPrefix?: string
  ): Promise<SearchResult[]> {
    const table = await this.getCodeTable();
    if (!table) return [];

    let query = table.vectorSearch(queryEmbedding);

    if (directoryPrefix) {
      const escaped = directoryPrefix.replace(/'/g, "''");
      query = query.where(`filePath LIKE '${escaped}%'`);
    }

    query = query.limit(topK);
    if (await this.isSQEnabled()) {
      query = query.refineFactor(SQ_REFINE_FACTOR);
    }
    const results = await query.toArray();

    return results.map((row: Record<string, unknown>) => ({
      type: 'code' as const,
      chunk: {
        filePath: row['filePath'] as string,
        language: row['language'] as string,
        startLine: row['startLine'] as number,
        endLine: row['endLine'] as number,
        content: row['content'] as string,
        isSummary: (row['isSummary'] as number) === 1,
      },
      score: row['_distance'] as number,
    }));
  }

  async isCodeIndexed(): Promise<boolean> {
    const table = await this.getCodeTable();
    return table !== null;
  }

  /**
   * Fetch ALL chunks for specific files from the code_files table.
   * Used for small-to-big retrieval: search finds the best 256-line chunk,
   * then we expand to the full file context.
   * Returns chunks sorted by startLine for each file.
   */
  async getCodeChunksForFiles(filePaths: string[]): Promise<CodeChunk[]> {
    const table = await this.getCodeTable();
    if (!table || filePaths.length === 0) return [];

    const conditions = filePaths
      .map((fp) => `"filePath" = '${fp.replace(/'/g, "''")}'`)
      .join(' OR ');

    const rows: Record<string, unknown>[] = await table
      .query()
      .where(conditions)
      .toArray();

    return rows
      .map((row) => ({
        filePath: row['filePath'] as string,
        language: row['language'] as string,
        startLine: row['startLine'] as number,
        endLine: row['endLine'] as number,
        content: row['content'] as string,
        isSummary: (row['isSummary'] as number) === 1,
      }))
      .sort((a, b) => a.filePath.localeCompare(b.filePath) || a.startLine - b.startLine);
  }

  async getAllUniqueFilePaths(): Promise<string[]> {
    const table = await this.getCodeTable();
    if (!table) return [];

    const rows: Record<string, unknown>[] = await table
      .query()
      .select(['filePath'])
      .toArray();

    const unique = new Set<string>();
    for (const row of rows) {
      unique.add(row['filePath'] as string);
    }
    return Array.from(unique).sort();
  }

  async getCodeFileCount(): Promise<number> {
    const table = await this.getCodeTable();
    if (!table) return 0;
    return table.countRows();
  }

  async isIndexed(): Promise<boolean> {
    const table = await this.getCommitTable();
    return table !== null;
  }

  async getStatus(): Promise<IndexStatus> {
    const table = await this.getCommitTable();
    if (!table) {
      return { indexed: false, commitCount: 0, codeFileCount: 0, prCount: 0, lastIndexedAt: null, lastIndexedHash: null };
    }

    const count = await table.countRows();
    const codeFileCount = await this.getCodeFileCount();
    const prCount = await this.getPRCount();
    const meta = this.loadMeta();
    return {
      indexed: true,
      commitCount: count,
      codeFileCount,
      prCount,
      lastIndexedAt: meta?.lastIndexedAt ?? new Date().toISOString(),
      lastIndexedHash: meta?.lastIndexedHash ?? null,
    };
  }

  // ─── HNSW-SQ Index (for large repos) ───

  /**
   * Create an HNSW Scalar Quantization index on the vector column of a table.
   * Only creates if the row count exceeds SQ_INDEX_THRESHOLD.
   * Safe to call multiple times — recreates if already exists.
   */
  async createSQIndex(tableName: string): Promise<boolean> {
    const db = await this.connect();
    const tables = await db.tableNames();
    if (!tables.includes(tableName)) return false;

    const table = await db.openTable(tableName);
    const rowCount = await table.countRows();

    if (rowCount < SQ_INDEX_THRESHOLD) return false;

    await table.createIndex('vector', {
      config: Index.hnswSq(),
    });
    return true;
  }

  /**
   * Create HNSW-SQ indices on all tables that exceed the threshold.
   * Called after indexing for large repos to compress vectors and speed up search.
   */
  async ensureSQIndices(
    onProgress?: (message: string) => void
  ): Promise<{ indexed: string[] }> {
    const indexed: string[] = [];
    const tables = [COMMITS_TABLE, CODE_TABLE, PR_TABLE];
    for (let i = 0; i < tables.length; i++) {
      onProgress?.(`Optimizing index for large repository (${tables[i]})...`);
      const created = await this.createSQIndex(tables[i]);
      if (created) indexed.push(tables[i]);
      // Yield to event loop between table index builds to avoid blocking Extension Host
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
    if (indexed.length > 0) this.markSQEnabled();
    return { indexed };
  }

  // ─── Call Graph Table (relational — no vectors) ───

  /**
   * Create or replace the call_graph table with the given edges.
   * This is a relational table (no vector column) — used for direct lookups.
   */
  async upsertCallGraph(edges: CallEdge[]): Promise<void> {
    if (edges.length === 0) return;

    const db = await this.connect();
    const records = edges.map((e) => ({
      callerFile: e.callerFile,
      callerName: e.callerName,
      calleeFile: e.calleeFile,
      calleeName: e.calleeName,
      line: e.line,
      edgeType: e.edgeType ?? 'call',
      weight: e.weight ?? 0,
      rawCount: e.rawCount ?? 0,
      latestCommitHash: e.latestCommitHash ?? '',
      latestCommitDate: e.latestCommitDate ?? '',
      earliestCommitHash: e.earliestCommitHash ?? '',
      earliestCommitDate: e.earliestCommitDate ?? '',
    }));

    try { await db.dropTable(CALL_GRAPH_TABLE); } catch { /* OK */ }
    this.callGraphTable = await db.createTable(CALL_GRAPH_TABLE, records);
  }

  /**
   * Query call graph edges where a given file is the caller.
   */
  async queryCallGraphByCaller(filePath: string): Promise<CallEdge[]> {
    const table = await this.getCallGraphTable();
    if (!table) return [];

    try {
      const results = await table
        .query()
        .where(`"callerFile" = '${filePath.replace(/'/g, "''")}'`)
        .toArray();
      return results.map((r: any) => ({
        callerFile: r.callerFile,
        callerName: r.callerName,
        calleeFile: r.calleeFile,
        calleeName: r.calleeName,
        line: r.line,
        edgeType: r.edgeType ?? 'call',
        weight: r.weight ?? 0,
        rawCount: r.rawCount || undefined,
        latestCommitHash: r.latestCommitHash || undefined,
        latestCommitDate: r.latestCommitDate || undefined,
        earliestCommitHash: r.earliestCommitHash || undefined,
        earliestCommitDate: r.earliestCommitDate || undefined,
      }));
    } catch {
      return [];
    }
  }

  /**
   * Query call graph edges where a given file is the callee.
   */
  async queryCallGraphByCallee(filePath: string): Promise<CallEdge[]> {
    const table = await this.getCallGraphTable();
    if (!table) return [];

    try {
      const results = await table
        .query()
        .where(`"calleeFile" = '${filePath.replace(/'/g, "''")}'`)
        .toArray();
      return results.map((r: any) => ({
        callerFile: r.callerFile,
        callerName: r.callerName,
        calleeFile: r.calleeFile,
        calleeName: r.calleeName,
        line: r.line,
        edgeType: r.edgeType ?? 'call',
        weight: r.weight ?? 0,
        rawCount: r.rawCount || undefined,
        latestCommitHash: r.latestCommitHash || undefined,
        latestCommitDate: r.latestCommitDate || undefined,
        earliestCommitHash: r.earliestCommitHash || undefined,
        earliestCommitDate: r.earliestCommitDate || undefined,
      }));
    } catch {
      return [];
    }
  }

  /**
   * Get all call graph edges (for full graph operations like BFS closure).
   */
  async getAllCallGraphEdges(): Promise<CallEdge[]> {
    const table = await this.getCallGraphTable();
    if (!table) return [];

    try {
      const results = await table.query().toArray();
      return results.map((r: any) => ({
        callerFile: r.callerFile,
        callerName: r.callerName,
        calleeFile: r.calleeFile,
        calleeName: r.calleeName,
        line: r.line,
        edgeType: r.edgeType ?? 'call',
        weight: r.weight ?? 0,
        rawCount: r.rawCount || undefined,
        latestCommitHash: r.latestCommitHash || undefined,
        latestCommitDate: r.latestCommitDate || undefined,
        earliestCommitHash: r.earliestCommitHash || undefined,
        earliestCommitDate: r.earliestCommitDate || undefined,
      }));
    } catch {
      return [];
    }
  }

  /**
   * Query co-change edges for a given file.
   * Returns files that frequently change together with the target file in commits.
   */
  async queryCoChangeEdges(filePath: string): Promise<CallEdge[]> {
    const table = await this.getCallGraphTable();
    if (!table) return [];

    try {
      const escaped = filePath.replace(/'/g, "''");
      const results = await table
        .query()
        .where(`"edgeType" = 'co-change' AND ("callerFile" = '${escaped}' OR "calleeFile" = '${escaped}')`)
        .toArray();
      return results.map((r: any) => ({
        callerFile: r.callerFile,
        callerName: r.callerName,
        calleeFile: r.calleeFile,
        calleeName: r.calleeName,
        line: r.line,
        edgeType: r.edgeType,
        weight: r.weight ?? 0,
        rawCount: r.rawCount || undefined,
        latestCommitHash: r.latestCommitHash || undefined,
        latestCommitDate: r.latestCommitDate || undefined,
        earliestCommitHash: r.earliestCommitHash || undefined,
        earliestCommitDate: r.earliestCommitDate || undefined,
      }));
    } catch {
      return [];
    }
  }

  /**
   * Get all unique commit hashes with their associated file paths and dates.
   * Used to compute co-change / evolutionary coupling between files.
   */
  async getCommitFileGroups(): Promise<Map<string, { files: string[]; date: string }>> {
    const table = await this.getCommitTable();
    if (!table) return new Map();

    try {
      const rows: Record<string, unknown>[] = await table
        .query()
        .select(['hash', 'filePath', 'date'])
        .toArray();

      const groups = new Map<string, { files: string[]; date: string }>();
      for (const row of rows) {
        const hash = row['hash'] as string;
        const fp = row['filePath'] as string;
        const date = row['date'] as string;
        if (!groups.has(hash)) groups.set(hash, { files: [], date });
        groups.get(hash)!.files.push(fp);
      }
      return groups;
    } catch {
      return new Map();
    }
  }

  /**
   * Get the number of call graph edges.
   */
  async getCallGraphCount(): Promise<number> {
    const table = await this.getCallGraphTable();
    if (!table) return 0;
    try {
      return await table.countRows();
    } catch {
      return 0;
    }
  }

  async clear(): Promise<void> {
    const db = await this.connect();
    try { await db.dropTable(COMMITS_TABLE); } catch { /* OK */ }
    try { await db.dropTable(CODE_TABLE); } catch { /* OK */ }
    try { await db.dropTable(PR_TABLE); } catch { /* OK */ }
    try { await db.dropTable(CALL_GRAPH_TABLE); } catch { /* OK */ }
    // Remove metadata files
    const metaPath = path.join(this.dbPath, '..', META_FILE);
    try { fs.unlinkSync(metaPath); } catch { /* OK */ }
    const prMetaPath = path.join(this.dbPath, '..', 'pr-meta.json');
    try { fs.unlinkSync(prMetaPath); } catch { /* OK */ }
    this.clearSQMarker();
    this.commitTable = null;
    this.codeTable = null;
    this.prTable = null;
    this.callGraphTable = null;
  }

  // ─── SQ State Persistence ───

  private async isSQEnabled(): Promise<boolean> {
    if (this.sqEnabled !== null) return this.sqEnabled;
    const markerPath = path.join(this.dbPath, '..', SQ_MARKER);
    this.sqEnabled = fs.existsSync(markerPath);
    return this.sqEnabled;
  }

  private markSQEnabled(): void {
    this.sqEnabled = true;
    const markerPath = path.join(this.dbPath, '..', SQ_MARKER);
    try { fs.writeFileSync(markerPath, new Date().toISOString()); } catch { /* OK */ }
  }

  private clearSQMarker(): void {
    this.sqEnabled = false;
    const markerPath = path.join(this.dbPath, '..', SQ_MARKER);
    try { fs.unlinkSync(markerPath); } catch { /* OK */ }
  }

  private async getCommitTable(): Promise<Table | null> {
    if (this.commitTable) return this.commitTable;

    try {
      const db = await this.connect();
      const tables = await db.tableNames();
      if (tables.includes(COMMITS_TABLE)) {
        this.commitTable = await db.openTable(COMMITS_TABLE);
        return this.commitTable;
      }
    } catch {
      // DB doesn't exist yet
    }

    return null;
  }

  private async getCodeTable(): Promise<Table | null> {
    if (this.codeTable) return this.codeTable;

    try {
      const db = await this.connect();
      const tables = await db.tableNames();
      if (tables.includes(CODE_TABLE)) {
        this.codeTable = await db.openTable(CODE_TABLE);
        return this.codeTable;
      }
    } catch {
      // DB doesn't exist yet
    }

    return null;
  }

  private async getPRTable(): Promise<Table | null> {
    if (this.prTable) return this.prTable;

    try {
      const db = await this.connect();
      const tables = await db.tableNames();
      if (tables.includes(PR_TABLE)) {
        this.prTable = await db.openTable(PR_TABLE);
        return this.prTable;
      }
    } catch {
      // DB doesn't exist yet
    }

    return null;
  }

  private async getCallGraphTable(): Promise<Table | null> {
    if (this.callGraphTable) return this.callGraphTable;

    try {
      const db = await this.connect();
      const tables = await db.tableNames();
      if (tables.includes(CALL_GRAPH_TABLE)) {
        this.callGraphTable = await db.openTable(CALL_GRAPH_TABLE);
        return this.callGraphTable;
      }
    } catch {
      // DB doesn't exist yet
    }

    return null;
  }
}
