import type { FileSymbols, CallEdge, ImportInfo } from '../types';

// ─── CallGraphService ───

export class CallGraphService {
  /**
   * Build call graph edges from all file symbols.
   * Resolution strategy:
   *   1. Same-file: caller and callee are in the same file
   *   2. Import tracing: callee name matches an imported symbol → resolve to source file
   *   3. Fuzzy: callee name matches a known function/method in any file
   */
  buildGraph(allSymbols: Map<string, FileSymbols>): CallEdge[] {
    const edges: CallEdge[] = [];

    // Build a global index: functionName → [filePath, ...] for cross-file resolution
    const globalFunctions = new Map<string, string[]>();
    // Build import map: filePath → importedName → resolvedSourceFile
    const importMap = new Map<string, Map<string, string>>();

    for (const [filePath, symbols] of allSymbols) {
      // Index all functions and methods
      for (const fn of symbols.functions) {
        const existing = globalFunctions.get(fn.name) ?? [];
        existing.push(filePath);
        globalFunctions.set(fn.name, existing);
      }
      for (const cls of symbols.classes) {
        if (cls.methods) {
          for (const method of cls.methods) {
            const existing = globalFunctions.get(method) ?? [];
            existing.push(filePath);
            globalFunctions.set(method, existing);
          }
        }
      }

      // Build import resolution for this file
      const fileImports = new Map<string, string>();
      for (const imp of symbols.imports) {
        const resolvedFile = this.resolveImportSource(imp.source, filePath, allSymbols);
        if (resolvedFile) {
          for (const name of imp.names) {
            fileImports.set(name, resolvedFile);
          }
          // Also map the default-ish import (last segment of path)
          const defaultName = imp.source.split('/').pop()?.replace(/\.\w+$/, '');
          if (defaultName) {
            fileImports.set(defaultName, resolvedFile);
          }
        }
      }
      importMap.set(filePath, fileImports);
    }

    // Resolve call sites to edges
    for (const [filePath, symbols] of allSymbols) {
      const fileImportResolution = importMap.get(filePath) ?? new Map();

      for (const site of symbols.callSites) {
        const resolved = this.resolveCallee(
          site.callee,
          filePath,
          symbols,
          fileImportResolution,
          globalFunctions,
        );

        edges.push({
          callerFile: filePath,
          callerName: site.caller,
          calleeFile: resolved.file,
          calleeName: site.callee,
          line: site.line,
        });
      }
    }

    return edges;
  }

  /**
   * Get all functions reachable from a given entry point via BFS.
   * Returns the set of {file, function} pairs reachable.
   */
  getTransitiveClosure(
    entryFile: string,
    entryFunction: string,
    edges: CallEdge[],
  ): { file: string; name: string }[] {
    // Build adjacency list: "file::name" → ["file::name", ...]
    const adj = new Map<string, Set<string>>();
    for (const edge of edges) {
      const from = `${edge.callerFile}::${edge.callerName}`;
      const to = `${edge.calleeFile}::${edge.calleeName}`;
      const existing = adj.get(from) ?? new Set();
      existing.add(to);
      adj.set(from, existing);
    }

    const start = `${entryFile}::${entryFunction}`;
    const visited = new Set<string>();
    const queue = [start];
    visited.add(start);

    while (queue.length > 0) {
      const current = queue.shift()!;
      const neighbors = adj.get(current);
      if (!neighbors) continue;
      for (const neighbor of neighbors) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push(neighbor);
        }
      }
    }

    return Array.from(visited).map((key) => {
      const sep = key.indexOf('::');
      return { file: key.slice(0, sep), name: key.slice(sep + 2) };
    });
  }

  /**
   * Get all callers of a given function (reverse edges).
   */
  getCallers(
    targetFile: string,
    targetFunction: string,
    edges: CallEdge[],
  ): { file: string; name: string; line: number }[] {
    return edges
      .filter((e) => e.calleeFile === targetFile && e.calleeName === targetFunction)
      .map((e) => ({ file: e.callerFile, name: e.callerName, line: e.line }));
  }

  /**
   * Get all callees of a given function (forward edges).
   */
  getCallees(
    sourceFile: string,
    sourceFunction: string,
    edges: CallEdge[],
  ): { file: string; name: string; line: number }[] {
    return edges
      .filter((e) => e.callerFile === sourceFile && e.callerName === sourceFunction)
      .map((e) => ({ file: e.calleeFile, name: e.calleeName, line: e.line }));
  }

  // ─── Resolution Helpers ───

  private resolveCallee(
    calleeName: string,
    callerFile: string,
    callerSymbols: FileSymbols,
    importResolution: Map<string, string>,
    globalFunctions: Map<string, string[]>,
  ): { file: string; name: string } {
    // 1. Same-file: check if callee is defined in the same file
    const localMatch = callerSymbols.functions.find((f) => f.name === calleeName)
      || callerSymbols.classes.some((c) => c.methods?.includes(calleeName));
    if (localMatch) {
      return { file: callerFile, name: calleeName };
    }

    // 2. Import tracing: check if callee was imported  
    const importedFrom = importResolution.get(calleeName);
    if (importedFrom) {
      return { file: importedFrom, name: calleeName };
    }

    // 3. Fuzzy: check global function index
    const candidates = globalFunctions.get(calleeName);
    if (candidates && candidates.length > 0) {
      // Prefer files in the same directory
      const callerDir = callerFile.substring(0, callerFile.lastIndexOf('/') + 1);
      const sameDir = candidates.find((f) => f.startsWith(callerDir));
      return { file: sameDir ?? candidates[0], name: calleeName };
    }

    // Unresolved: mark as external
    return { file: '<external>', name: calleeName };
  }

  /**
   * Try to resolve a relative import source (e.g. "./utils", "../lib/helper")
   * to an actual file path in allSymbols.
   */
  private resolveImportSource(
    source: string,
    currentFile: string,
    allSymbols: Map<string, FileSymbols>,
  ): string | null {
    // Only resolve relative imports
    if (!source.startsWith('.')) return null;

    const currentDir = currentFile.substring(0, currentFile.lastIndexOf('/') + 1);
    const resolved = this.normalizePath(currentDir + source);

    // Try exact match, then with extensions
    const extensions = ['', '.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java', '.c', '.cpp'];
    for (const ext of extensions) {
      const candidate = resolved + ext;
      if (allSymbols.has(candidate)) return candidate;
    }

    // Try index files
    for (const indexFile of ['index.ts', 'index.js', 'index.tsx']) {
      const candidate = resolved + '/' + indexFile;
      if (allSymbols.has(candidate)) return candidate;
    }

    return null;
  }

  /**
   * Compute co-change (evolutionary coupling) edges from commit history.
   * Two files are coupled if they frequently appear in the same commits.
   *
   * Uses exponential recency decay: recent co-changes score higher than old ones.
   * A commit from today contributes ~1.0; a commit from 2 years ago contributes ~0.13.
   * This ensures modern refactoring patterns naturally float to the top.
   *
   * Thresholds: each file must appear in ≥3 commits, pair must co-occur ≥3 times,
   * and co-change rate must exceed 50% relative to the less-frequent file.
   */
  computeCoChangeEdges(
    commitFileGroups: Map<string, { files: string[]; date: string }>
  ): CallEdge[] {
    const MIN_FILE_COMMITS = 3;
    const MIN_CO_OCCURRENCES = 3;
    const MIN_CO_CHANGE_RATE = 0.5;
    const MAX_EDGES = 500;
    // Half-life in days: a commit from this many days ago has half the weight of today's
    const HALF_LIFE_DAYS = 365;
    const DECAY_LAMBDA = Math.LN2 / HALF_LIFE_DAYS;

    const now = Date.now();

    // Count how many commits each file appears in
    const fileCommitCount = new Map<string, number>();
    for (const { files } of commitFileGroups.values()) {
      const unique = new Set(files);
      for (const f of unique) {
        fileCommitCount.set(f, (fileCommitCount.get(f) ?? 0) + 1);
      }
    }

    // Track pairwise co-occurrence: decayed weight sum + raw count + most-recent + earliest commit
    interface PairInfo {
      decayedWeight: number;
      rawCount: number;
      latestHash: string;
      latestDate: string;
      latestTimestamp: number;
      earliestHash: string;
      earliestDate: string;
      earliestTimestamp: number;
    }
    const pairInfo = new Map<string, PairInfo>();

    for (const [hash, { files, date }] of commitFileGroups) {
      const commitTime = new Date(date).getTime();
      const ageDays = Math.max(0, (now - commitTime) / (1000 * 60 * 60 * 24));
      const decayFactor = Math.exp(-DECAY_LAMBDA * ageDays);

      const qualified = [...new Set(files)].filter(
        (f) => (fileCommitCount.get(f) ?? 0) >= MIN_FILE_COMMITS
      );

      for (let i = 0; i < qualified.length; i++) {
        for (let j = i + 1; j < qualified.length; j++) {
          const key = qualified[i] < qualified[j]
            ? `${qualified[i]}|||${qualified[j]}`
            : `${qualified[j]}|||${qualified[i]}`;

          const existing = pairInfo.get(key);
          if (existing) {
            existing.decayedWeight += decayFactor;
            existing.rawCount += 1;
            if (commitTime > existing.latestTimestamp) {
              existing.latestHash = hash;
              existing.latestDate = date;
              existing.latestTimestamp = commitTime;
            }
            if (commitTime < existing.earliestTimestamp) {
              existing.earliestHash = hash;
              existing.earliestDate = date;
              existing.earliestTimestamp = commitTime;
            }
          } else {
            pairInfo.set(key, {
              decayedWeight: decayFactor,
              rawCount: 1,
              latestHash: hash,
              latestDate: date,
              latestTimestamp: commitTime,
              earliestHash: hash,
              earliestDate: date,
              earliestTimestamp: commitTime,
            });
          }
        }
      }
    }

    // Filter pairs by co-occurrence threshold and rate
    const edges: CallEdge[] = [];
    for (const [key, info] of pairInfo) {
      if (info.rawCount < MIN_CO_OCCURRENCES) continue;

      const [fileA, fileB] = key.split('|||');
      const countA = fileCommitCount.get(fileA) ?? 0;
      const countB = fileCommitCount.get(fileB) ?? 0;
      const minCount = Math.min(countA, countB);
      const rate = info.rawCount / minCount;

      if (rate < MIN_CO_CHANGE_RATE) continue;

      // Round to 2 decimal places for readability in diagnostics
      const weight = Math.round(info.decayedWeight * 100) / 100;

      edges.push({
        callerFile: fileA,
        callerName: '<co-change>',
        calleeFile: fileB,
        calleeName: '<co-change>',
        line: 0,
        edgeType: 'co-change',
        weight,
        rawCount: info.rawCount,
        latestCommitHash: info.latestHash,
        latestCommitDate: info.latestDate,
        earliestCommitHash: info.earliestHash,
        earliestCommitDate: info.earliestDate,
      });
    }

    // Sort by decayed weight descending (recent+frequent pairs first) and cap
    edges.sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0));
    return edges.slice(0, MAX_EDGES);
  }

  /** Normalize a path by resolving . and .. segments */
  private normalizePath(p: string): string {
    const parts = p.split('/');
    const result: string[] = [];
    for (const part of parts) {
      if (part === '.' || part === '') continue;
      if (part === '..') {
        result.pop();
      } else {
        result.push(part);
      }
    }
    return result.join('/');
  }
}
