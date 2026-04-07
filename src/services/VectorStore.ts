import * as lancedb from '@lancedb/lancedb';
import type { Table } from '@lancedb/lancedb';
import type { CommitChunk, SearchResult, IndexStatus } from '../types';

const TABLE_NAME = 'commits';

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

export class VectorStore {
  private db: lancedb.Connection | null = null;
  private table: Table | null = null;
  private dbPath: string;

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
      await db.dropTable(TABLE_NAME);
    } catch {
      // Table doesn't exist yet — OK
    }

    this.table = await db.createTable(TABLE_NAME, records);
  }

  async search(queryEmbedding: number[], topK: number): Promise<SearchResult[]> {
    const table = await this.getTable();
    if (!table) {
      throw new Error('Index not found. Please index the repository first.');
    }

    const results = await table
      .vectorSearch(queryEmbedding)
      .limit(topK)
      .toArray();

    return results.map((row: Record<string, unknown>) => ({
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

  async isIndexed(): Promise<boolean> {
    const table = await this.getTable();
    return table !== null;
  }

  async getStatus(): Promise<IndexStatus> {
    const table = await this.getTable();
    if (!table) {
      return { indexed: false, commitCount: 0, lastIndexedAt: null };
    }

    const count = await table.countRows();
    return {
      indexed: true,
      commitCount: count,
      lastIndexedAt: new Date().toISOString(),
    };
  }

  async clear(): Promise<void> {
    const db = await this.connect();
    try {
      await db.dropTable(TABLE_NAME);
    } catch {
      // Table doesn't exist — OK
    }
    this.table = null;
  }

  private async getTable(): Promise<Table | null> {
    if (this.table) return this.table;

    try {
      const db = await this.connect();
      const tables = await db.tableNames();
      if (tables.includes(TABLE_NAME)) {
        this.table = await db.openTable(TABLE_NAME);
        return this.table;
      }
    } catch {
      // DB doesn't exist yet
    }

    return null;
  }
}
