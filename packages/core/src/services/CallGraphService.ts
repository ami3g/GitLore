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
