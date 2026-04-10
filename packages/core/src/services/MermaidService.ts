import type { CallEdge, CommitChunk, PRChunk, FileSymbols } from '../types';

// ─── Mermaid Diagram Generation ───

export class MermaidService {
  /**
   * Generate a code architecture diagram showing files as nodes,
   * import/call edges between them, grouped by directory.
   */
  generateCodeArchitecture(
    allSymbols: Map<string, FileSymbols>,
    edges: CallEdge[],
  ): string {
    const lines: string[] = ['graph TD'];

    // Group files by directory for subgraphs
    const dirFiles = new Map<string, string[]>();
    for (const filePath of allSymbols.keys()) {
      const dir = filePath.substring(0, filePath.lastIndexOf('/')) || '.';
      const existing = dirFiles.get(dir) ?? [];
      existing.push(filePath);
      dirFiles.set(dir, existing);
    }

    // Create subgraphs per directory
    for (const [dir, files] of dirFiles) {
      const sanitizedDir = dir === '.' ? 'root' : this.sanitizeId(dir);
      const dirLabel = dir === '.' ? 'root' : dir;
      lines.push(`  subgraph ${sanitizedDir}["${this.escapeLabel(dirLabel)}"]`);
      for (const file of files) {
        const id = this.sanitizeId(file);
        const label = file.split('/').pop() ?? file;
        lines.push(`    ${id}["${this.escapeLabel(label)}"]`);
      }
      lines.push('  end');
    }

    // Add edges — deduplicate by file pair
    const fileEdges = new Set<string>();
    for (const edge of edges) {
      if (edge.calleeFile === '<external>') continue;
      if (edge.callerFile === edge.calleeFile) continue;
      const key = `${edge.callerFile}->${edge.calleeFile}`;
      if (fileEdges.has(key)) continue;
      fileEdges.add(key);
      lines.push(`  ${this.sanitizeId(edge.callerFile)} --> ${this.sanitizeId(edge.calleeFile)}`);
    }

    // Also add import edges from FileSymbols
    for (const [filePath, symbols] of allSymbols) {
      for (const imp of symbols.imports) {
        if (!imp.source.startsWith('.')) continue;
        // Try to find the target file
        const resolved = this.findImportTarget(imp.source, filePath, allSymbols);
        if (resolved && resolved !== filePath) {
          const key = `${filePath}->${resolved}`;
          if (!fileEdges.has(key)) {
            fileEdges.add(key);
            lines.push(`  ${this.sanitizeId(filePath)} -.-> ${this.sanitizeId(resolved)}`);
          }
        }
      }
    }

    return lines.join('\n');
  }

  /**
   * Generate a call graph diagram showing function-level relationships.
   * If an entry function is specified, only shows its transitive closure.
   */
  generateCallGraph(
    edges: CallEdge[],
    closure?: { file: string; name: string }[],
  ): string {
    const lines: string[] = ['graph TD'];

    const relevantEdges = closure
      ? edges.filter((e) => {
          const callerInClosure = closure.some((c) => c.file === e.callerFile && c.name === e.callerName);
          const calleeInClosure = closure.some((c) => c.file === e.calleeFile && c.name === e.calleeName);
          return callerInClosure || calleeInClosure;
        })
      : edges;

    // Group by file for subgraphs
    const fileNodes = new Map<string, Set<string>>();
    for (const edge of relevantEdges) {
      if (!fileNodes.has(edge.callerFile)) fileNodes.set(edge.callerFile, new Set());
      fileNodes.get(edge.callerFile)!.add(edge.callerName);
      if (edge.calleeFile !== '<external>') {
        if (!fileNodes.has(edge.calleeFile)) fileNodes.set(edge.calleeFile, new Set());
        fileNodes.get(edge.calleeFile)!.add(edge.calleeName);
      }
    }

    // Track all declared node IDs so edges only reference existing nodes
    const declaredNodes = new Set<string>();

    // Create file subgraphs with function nodes
    for (const [file, fns] of fileNodes) {
      const fileLabel = file.split('/').pop() ?? file;
      const subId = file === '.' ? 'root' : this.sanitizeId(file);
      lines.push(`  subgraph ${subId}["${this.escapeLabel(fileLabel)}"]`);
      for (const fn of fns) {
        const nodeId = this.sanitizeId(`${file}::${fn}`);
        declaredNodes.add(nodeId);
        lines.push(`    ${nodeId}["${this.escapeLabel(fn)}"]`);
      }
      lines.push('  end');
    }

    // External nodes
    const externalFns = new Set<string>();
    for (const edge of relevantEdges) {
      if (edge.calleeFile === '<external>') externalFns.add(edge.calleeName);
    }
    if (externalFns.size > 0) {
      lines.push('  subgraph ext_fns["External"]');
      for (const fn of externalFns) {
        const nodeId = this.sanitizeId(`ext::${fn}`);
        declaredNodes.add(nodeId);
        lines.push(`    ${nodeId}["${this.escapeLabel(fn)}"]`);
      }
      lines.push('  end');
    }

    // Add edges — only emit if both endpoints are declared
    for (const edge of relevantEdges) {
      const fromId = this.sanitizeId(`${edge.callerFile}::${edge.callerName}`);
      const toFile = edge.calleeFile === '<external>' ? 'ext' : edge.calleeFile;
      const toId = this.sanitizeId(`${toFile}::${edge.calleeName}`);
      if (declaredNodes.has(fromId) && declaredNodes.has(toId)) {
        lines.push(`  ${fromId} --> ${toId}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * Generate a commit timeline diagram.
   * Uses Mermaid gitgraph syntax for a clean visual.
   */
  generateCommitTimeline(commits: CommitChunk[], limit = 30): string {
    const lines: string[] = ['gitGraph'];

    // Deduplicate by hash and limit
    const seen = new Set<string>();
    const unique: CommitChunk[] = [];
    for (const commit of commits) {
      if (!seen.has(commit.hash)) {
        seen.add(commit.hash);
        unique.push(commit);
      }
      if (unique.length >= limit) break;
    }

    // Sort by date ascending
    unique.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

    for (const commit of unique) {
      const shortHash = commit.hash.substring(0, 7);
      const shortMsg = commit.message.split('\n')[0].substring(0, 50).replace(/"/g, "'");
      lines.push(`  commit id: "${shortHash}" tag: "${shortMsg}"`);
    }

    return lines.join('\n');
  }

  /**
   * Generate a PR/Issue flow diagram showing relationships.
   * PRs link to issues they resolve, and to merge commits.
   */
  generatePRIssueFlow(prs: PRChunk[]): string {
    const lines: string[] = ['graph LR'];

    for (const pr of prs) {
      const prId = this.sanitizeId(`pr${pr.prNumber}`);
      const stateStyle = pr.state === 'merged' ? ':::merged' : pr.state === 'closed' ? ':::closed' : ':::open';
      const shortTitle = pr.title.substring(0, 40).replace(/"/g, "'");
      lines.push(`  ${prId}["#${pr.prNumber}: ${this.escapeLabel(shortTitle)}"]${stateStyle}`);

      // Link to resolved issues
      if (pr.linkedIssues) {
        const issues = pr.linkedIssues.split(',').map((s) => s.trim()).filter(Boolean);
        for (const issue of issues) {
          const issueMatch = issue.match(/#(\d+)/);
          if (issueMatch) {
            const issueId = this.sanitizeId(`issue${issueMatch[1]}`);
            const issueLabel = issue.substring(0, 40).replace(/"/g, "'");
            lines.push(`  ${issueId}["${this.escapeLabel(issueLabel)}"]:::issue`);
            lines.push(`  ${prId} -->|resolves| ${issueId}`);
          }
        }
      }

      // Link to merge commit
      if (pr.resolvedBy) {
        const commitId = this.sanitizeId(`commit${pr.resolvedBy.substring(0, 7)}`);
        lines.push(`  ${commitId}(("${pr.resolvedBy.substring(0, 7)}")):::commit`);
        lines.push(`  ${prId} -->|merged in| ${commitId}`);
      }
    }

    // Add style definitions
    lines.push('');
    lines.push('  classDef merged fill:#238636,color:#fff');
    lines.push('  classDef closed fill:#da3633,color:#fff');
    lines.push('  classDef open fill:#238636,color:#fff,stroke-dasharray: 5 5');
    lines.push('  classDef issue fill:#8957e5,color:#fff');
    lines.push('  classDef commit fill:#848d97,color:#fff');

    return lines.join('\n');
  }

  // ─── Helpers ───

  private sanitizeId(s: string): string {
    // Mermaid IDs can only have alphanumeric + underscore
    return s.replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
  }

  private escapeLabel(s: string): string {
    return s.replace(/"/g, "'").replace(/[[\]]/g, '');
  }

  private findImportTarget(
    source: string,
    currentFile: string,
    allSymbols: Map<string, FileSymbols>,
  ): string | null {
    if (!source.startsWith('.')) return null;
    const currentDir = currentFile.substring(0, currentFile.lastIndexOf('/') + 1);
    const resolved = this.normalizePath(currentDir + source);
    const extensions = ['', '.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java'];
    for (const ext of extensions) {
      if (allSymbols.has(resolved + ext)) return resolved + ext;
    }
    for (const idx of ['index.ts', 'index.js', 'index.tsx']) {
      if (allSymbols.has(resolved + '/' + idx)) return resolved + '/' + idx;
    }
    return null;
  }

  private normalizePath(p: string): string {
    const parts = p.split('/');
    const result: string[] = [];
    for (const part of parts) {
      if (part === '.' || part === '') continue;
      if (part === '..') { result.pop(); } else { result.push(part); }
    }
    return result.join('/');
  }
}
