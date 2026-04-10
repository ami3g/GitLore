import * as path from 'path';
import * as fs from 'fs';
import * as https from 'https';
import type { FileSymbols, SymbolInfo, ImportInfo, ExportInfo, CallSite } from '../types';

// ─── Grammar Config ───

/** Map from our language name → tree-sitter grammar WASM filename */
const GRAMMAR_MAP: Record<string, string> = {
  typescript: 'tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-tsx.wasm',
  javascript: 'tree-sitter-javascript.wasm',
  python: 'tree-sitter-python.wasm',
  go: 'tree-sitter-go.wasm',
  rust: 'tree-sitter-rust.wasm',
  java: 'tree-sitter-java.wasm',
  c: 'tree-sitter-c.wasm',
  cpp: 'tree-sitter-cpp.wasm',
};

/**
 * Map from our language name → GitHub release download URL for the grammar WASM.
 * Source: official tree-sitter grammar repos publish WASM as release assets.
 */
const GRAMMAR_URLS: Record<string, string> = {
  typescript: 'https://github.com/tree-sitter/tree-sitter-typescript/releases/download/v0.23.2/tree-sitter-typescript.wasm',
  tsx: 'https://github.com/tree-sitter/tree-sitter-typescript/releases/download/v0.23.2/tree-sitter-tsx.wasm',
  javascript: 'https://github.com/tree-sitter/tree-sitter-javascript/releases/download/v0.25.0/tree-sitter-javascript.wasm',
  python: 'https://github.com/tree-sitter/tree-sitter-python/releases/download/v0.25.0/tree-sitter-python.wasm',
  go: 'https://github.com/tree-sitter/tree-sitter-go/releases/download/v0.25.0/tree-sitter-go.wasm',
  rust: 'https://github.com/tree-sitter/tree-sitter-rust/releases/download/v0.24.2/tree-sitter-rust.wasm',
  java: 'https://github.com/tree-sitter/tree-sitter-java/releases/download/v0.23.5/tree-sitter-java.wasm',
  c: 'https://github.com/tree-sitter/tree-sitter-c/releases/download/v0.24.1/tree-sitter-c.wasm',
  cpp: 'https://github.com/tree-sitter/tree-sitter-cpp/releases/download/v0.23.4/tree-sitter-cpp.wasm',
};

// ─── Tree-sitter Query Patterns ───

const TS_QUERY = `
(function_declaration
  name: (identifier) @fn.name
  parameters: (formal_parameters) @fn.params) @fn.def

(class_declaration
  name: (type_identifier) @class.name
  body: (class_body) @class.body) @class.def

(method_definition
  name: (property_identifier) @method.name) @method.def

(call_expression
  function: [
    (identifier) @call.name
    (member_expression
      property: (property_identifier) @call.name)
  ]) @call.expr

(import_statement
  source: (string) @import.source) @import.stmt

(export_statement) @export.stmt
`;

const JS_QUERY = `
(function_declaration
  name: (identifier) @fn.name
  parameters: (formal_parameters) @fn.params) @fn.def

(class_declaration
  name: (identifier) @class.name
  body: (class_body) @class.body) @class.def

(method_definition
  name: (property_identifier) @method.name) @method.def

(call_expression
  function: [
    (identifier) @call.name
    (member_expression
      property: (property_identifier) @call.name)
  ]) @call.expr

(import_statement
  source: (string) @import.source) @import.stmt

(export_statement) @export.stmt
`;

const PYTHON_QUERY = `
(function_definition
  name: (identifier) @fn.name
  parameters: (parameters) @fn.params) @fn.def

(class_definition
  name: (identifier) @class.name
  body: (block) @class.body) @class.def

(call
  function: [
    (identifier) @call.name
    (attribute
      attribute: (identifier) @call.name)
  ]) @call.expr

(import_from_statement
  module_name: (dotted_name) @import.source) @import.stmt

(import_statement
  name: (dotted_name) @import.source) @import.stmt
`;

const GO_QUERY = `
(function_declaration
  name: (identifier) @fn.name
  parameters: (parameter_list) @fn.params) @fn.def

(method_declaration
  name: (field_identifier) @method.name) @method.def

(type_declaration
  (type_spec
    name: (type_identifier) @class.name
    type: (struct_type) @class.body)) @class.def

(call_expression
  function: [
    (identifier) @call.name
    (selector_expression
      field: (field_identifier) @call.name)
  ]) @call.expr

(import_spec
  path: (interpreted_string_literal) @import.source) @import.stmt
`;

const RUST_QUERY = `
(function_item
  name: (identifier) @fn.name
  parameters: (parameters) @fn.params) @fn.def

(struct_item
  name: (type_identifier) @class.name
  body: (field_declaration_list) @class.body) @class.def

(impl_item
  type: (type_identifier) @class.name) @class.def

(call_expression
  function: [
    (identifier) @call.name
    (field_expression
      field: (field_identifier) @call.name)
    (scoped_identifier
      name: (identifier) @call.name)
  ]) @call.expr

(use_declaration
  argument: (_) @import.source) @import.stmt
`;

const JAVA_QUERY = `
(method_declaration
  name: (identifier) @fn.name
  parameters: (formal_parameters) @fn.params) @fn.def

(class_declaration
  name: (identifier) @class.name
  body: (class_body) @class.body) @class.def

(method_invocation
  name: (identifier) @call.name) @call.expr

(import_declaration
  (scoped_identifier) @import.source) @import.stmt
`;

const C_CPP_QUERY = `
(function_definition
  declarator: (function_declarator
    declarator: (identifier) @fn.name
    parameters: (parameter_list) @fn.params)) @fn.def

(struct_specifier
  name: (type_identifier) @class.name
  body: (field_declaration_list) @class.body) @class.def

(call_expression
  function: [
    (identifier) @call.name
    (field_expression
      field: (field_identifier) @call.name)
  ]) @call.expr

(preproc_include
  path: (_) @import.source) @import.stmt
`;

const QUERY_MAP: Record<string, string> = {
  typescript: TS_QUERY,
  tsx: TS_QUERY,
  javascript: JS_QUERY,
  python: PYTHON_QUERY,
  go: GO_QUERY,
  rust: RUST_QUERY,
  java: JAVA_QUERY,
  c: C_CPP_QUERY,
  cpp: C_CPP_QUERY,
};

// ─── ASTService ───

type TreeSitterParser = any;
type TreeSitterLanguage = any;
type TreeSitterQuery = any;
type TreeSitterModule = {
  Parser: { new(): TreeSitterParser; init(opts?: any): Promise<void> };
  Language: { load(input: string | Uint8Array): Promise<TreeSitterLanguage> };
  Query: { new(language: TreeSitterLanguage, source: string): TreeSitterQuery };
};

export class ASTService {
  private grammarDir: string;
  private languages: Map<string, TreeSitterLanguage> = new Map();
  private queries: Map<string, TreeSitterQuery> = new Map();
  private failedLanguages: Set<string> = new Set();
  private parser: TreeSitterParser | null = null;
  private tsModule: TreeSitterModule | null = null;
  private initialized = false;

  /**
   * @param grammarDir — Directory for caching grammar WASM files.
   *   CLI: ~/.gitlore/grammars/   VS Code: globalStorageUri
   */
  constructor(grammarDir: string) {
    this.grammarDir = grammarDir;
  }

  /** Initialize web-tree-sitter runtime. Must be called once before parseFile(). */
  async init(): Promise<void> {
    if (this.initialized) return;

    const TreeSitter = require('web-tree-sitter');
    const wasmPath = path.join(
      path.dirname(require.resolve('web-tree-sitter')),
      'web-tree-sitter.wasm'
    );
    await TreeSitter.Parser.init({
      locateFile: () => wasmPath,
    });
    this.tsModule = TreeSitter;
    this.parser = new TreeSitter.Parser();
    this.initialized = true;

    // Ensure grammar cache dir exists
    fs.mkdirSync(this.grammarDir, { recursive: true });
  }

  /** Get the list of languages we support AST parsing for. */
  get supportedLanguages(): string[] {
    return Object.keys(GRAMMAR_MAP);
  }

  /**
   * Parse a single file and extract symbols, imports, exports, and call sites.
   * Returns null for unsupported languages.
   */
  async parseFile(filePath: string, content: string, language: string): Promise<FileSymbols | null> {
    if (!GRAMMAR_MAP[language]) return null;
    if (!this.initialized) await this.init();

    const lang = await this.ensureLanguage(language);
    if (!lang) return null;

    this.parser!.setLanguage(lang);
    const tree = this.parser!.parse(content);
    if (!tree) return null;

    try {
      const query = this.ensureQuery(language, lang);
      if (!query) {
        tree.delete();
        return null;
      }

      const matches = query.matches(tree.rootNode);
      return this.extractSymbols(filePath, language, content, matches);
    } finally {
      tree.delete();
    }
  }

  /**
   * Parse multiple files in batch. Skips unsupported languages.
   */
  async parseFiles(files: { filePath: string; content: string; language: string }[]): Promise<Map<string, FileSymbols>> {
    if (!this.initialized) await this.init();
    const results = new Map<string, FileSymbols>();

    for (const file of files) {
      const symbols = await this.parseFile(file.filePath, file.content, file.language);
      if (symbols) {
        results.set(file.filePath, symbols);
      }
    }

    return results;
  }

  // ─── Grammar Management ───

  private async ensureLanguage(language: string): Promise<TreeSitterLanguage | null> {
    if (this.languages.has(language)) return this.languages.get(language)!;
    if (this.failedLanguages.has(language)) return null;

    const wasmFile = GRAMMAR_MAP[language];
    if (!wasmFile) return null;

    const localPath = path.join(this.grammarDir, wasmFile);

    // Download if not cached
    if (!fs.existsSync(localPath)) {
      const downloaded = await this.downloadGrammar(language, localPath);
      if (!downloaded) {
        this.failedLanguages.add(language);
        return null;
      }
    }

    try {
      const lang = await this.tsModule!.Language.load(localPath);
      this.languages.set(language, lang);
      return lang;
    } catch (err) {
      console.error(`[ASTService] Failed to load grammar for ${language}:`, err);
      return null;
    }
  }

  private async downloadGrammar(language: string, destPath: string): Promise<boolean> {
    const url = GRAMMAR_URLS[language];
    if (!url) return false;

    console.log(`[ASTService] Downloading ${language} grammar from ${url}...`);
    try {
      await this.downloadFile(url, destPath);
      console.log(`[ASTService] Downloaded ${language} grammar successfully.`);
      return true;
    } catch (err) {
      console.error(`[ASTService] Failed to download grammar for ${language}: ${err instanceof Error ? err.message : err}`);
      // Clean up partial download
      try { fs.unlinkSync(destPath); } catch { /* ignore */ }
      return false;
    }
  }

  private downloadFile(url: string, destPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const file = fs.createWriteStream(destPath);
      const request = (reqUrl: string, redirects = 0) => {
        if (redirects > 5) {
          file.close();
          return reject(new Error('Too many redirects'));
        }
        https.get(reqUrl, (response) => {
          // Follow redirects
          if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
            response.resume();
            request(response.headers.location, redirects + 1);
            return;
          }
          if (response.statusCode !== 200) {
            file.close();
            return reject(new Error(`HTTP ${response.statusCode} for ${reqUrl}`));
          }
          response.pipe(file);
          file.on('finish', () => {
            file.close();
            resolve();
          });
        }).on('error', (err) => {
          file.close();
          reject(err);
        });
      };
      request(url);
    });
  }

  // ─── Query Management ───

  private ensureQuery(language: string, lang: TreeSitterLanguage): TreeSitterQuery | null {
    if (this.queries.has(language)) return this.queries.get(language)!;
    if (this.failedLanguages.has(language)) return null;

    const pattern = QUERY_MAP[language];
    if (!pattern) return null;

    try {
      const query = new this.tsModule!.Query(lang, pattern);
      this.queries.set(language, query);
      return query;
    } catch (err) {
      console.error(`[ASTService] Failed to create query for ${language}:`, err);
      this.failedLanguages.add(language);
      return null;
    }
  }

  // ─── Symbol Extraction ───

  private extractSymbols(
    filePath: string,
    language: string,
    content: string,
    matches: any[],
  ): FileSymbols {
    const functions: SymbolInfo[] = [];
    const classes: SymbolInfo[] = [];
    const imports: ImportInfo[] = [];
    const exports: ExportInfo[] = [];
    const callSites: CallSite[] = [];

    // Track which function scope we're in for call site attribution
    const lines = content.split('\n');

    for (const match of matches) {
      const captureMap: Record<string, any> = {};
      for (const capture of match.captures) {
        captureMap[capture.name] = capture.node;
      }

      // Function declarations
      if (captureMap['fn.def'] && captureMap['fn.name']) {
        const node = captureMap['fn.def'];
        const name = captureMap['fn.name'].text;
        const params = captureMap['fn.params']
          ? this.extractParamNames(captureMap['fn.params'].text, language)
          : [];
        functions.push({
          name,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          params,
        });
      }

      // Method definitions
      if (captureMap['method.def'] && captureMap['method.name']) {
        const node = captureMap['method.def'];
        const name = captureMap['method.name'].text;
        functions.push({
          name,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
        });
      }

      // Class declarations
      if (captureMap['class.def'] && captureMap['class.name']) {
        const node = captureMap['class.def'];
        const name = captureMap['class.name'].text;
        const methods = this.extractMethodNames(captureMap['class.body'], language);
        classes.push({
          name,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          methods,
        });
      }

      // Call expressions
      if (captureMap['call.expr'] && captureMap['call.name']) {
        const node = captureMap['call.expr'];
        const callee = captureMap['call.name'].text;
        const line = node.startPosition.row + 1;
        const caller = this.findEnclosingFunction(functions, line) ?? '<module>';
        callSites.push({ caller, callee, line });
      }

      // Import statements
      if (captureMap['import.stmt'] && captureMap['import.source']) {
        const node = captureMap['import.stmt'];
        const source = captureMap['import.source'].text.replace(/['"]/g, '');
        const names = this.extractImportNames(node, language);
        imports.push({
          source,
          names,
          line: node.startPosition.row + 1,
        });
      }

      // Export statements
      if (captureMap['export.stmt']) {
        const node = captureMap['export.stmt'];
        const name = this.extractExportName(node, language);
        if (name) {
          exports.push({
            name,
            line: node.startPosition.row + 1,
          });
        }
      }
    }

    return { filePath, language, functions, classes, imports, exports, callSites };
  }

  // ─── Helpers ───

  private extractParamNames(paramsText: string, language: string): string[] {
    // Strip parentheses and split by comma
    const inner = paramsText.replace(/^\(|\)$/g, '').trim();
    if (!inner) return [];

    return inner.split(',').map((p) => {
      const trimmed = p.trim();
      // For typed languages (TS, Java, Go), take the first word as the name
      // For Python, handle `self` and type annotations
      if (language === 'python') {
        return trimmed.split(':')[0].split('=')[0].trim();
      }
      // TS/JS: name: type = default
      const match = trimmed.match(/^(\w+)/);
      return match ? match[1] : trimmed;
    }).filter(Boolean);
  }

  private extractMethodNames(classBody: any, language: string): string[] {
    if (!classBody) return [];
    const methods: string[] = [];
    for (let i = 0; i < classBody.childCount; i++) {
      const child = classBody.child(i);
      if (!child) continue;
      const type = child.type;
      if (type === 'method_definition' || type === 'function_definition' || type === 'method_declaration') {
        const nameNode = child.childForFieldName('name');
        if (nameNode) methods.push(nameNode.text);
      }
    }
    return methods;
  }

  private findEnclosingFunction(functions: SymbolInfo[], line: number): string | null {
    for (const fn of functions) {
      if (line >= fn.startLine && line <= fn.endLine) return fn.name;
    }
    return null;
  }

  private extractImportNames(node: any, language: string): string[] {
    const names: string[] = [];
    // Walk children looking for named imports
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (!child) continue;

      if (child.type === 'import_clause') {
        // TS/JS import { X, Y } or import Z
        for (let j = 0; j < child.childCount; j++) {
          const sub = child.child(j);
          if (!sub) continue;
          if (sub.type === 'identifier') names.push(sub.text);
          if (sub.type === 'named_imports') {
            for (let k = 0; k < sub.childCount; k++) {
              const spec = sub.child(k);
              if (spec && spec.type === 'import_specifier') {
                const nameNode = spec.childForFieldName('name');
                if (nameNode) names.push(nameNode.text);
              }
            }
          }
        }
      }

      // Python: from X import a, b
      if (child.type === 'dotted_name' && language === 'python' && i > 0) {
        names.push(child.text);
      }
      if ((child.type === 'import_from_statement' || node.type === 'import_from_statement') && language === 'python') {
        for (let j = 0; j < node.childCount; j++) {
          const sub = node.child(j);
          if (sub && sub.type === 'dotted_name' && j > 1) {
            names.push(sub.text);
          }
        }
        break;
      }
    }

    return names;
  }

  private extractExportName(node: any, language: string): string | null {
    // Look for the declaration inside the export
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (!child) continue;
      // export function X / export class X / export const X
      if (child.type === 'function_declaration' || child.type === 'class_declaration' ||
          child.type === 'lexical_declaration' || child.type === 'variable_declaration') {
        const nameNode = child.childForFieldName('name');
        if (nameNode) return nameNode.text;
        // For const/let, look deeper
        for (let j = 0; j < child.childCount; j++) {
          const sub = child.child(j);
          if (sub && sub.type === 'variable_declarator') {
            const n = sub.childForFieldName('name');
            if (n) return n.text;
          }
        }
      }
      // export { X }
      if (child.type === 'export_clause') {
        const specs: string[] = [];
        for (let j = 0; j < child.childCount; j++) {
          const spec = child.child(j);
          if (spec && spec.type === 'export_specifier') {
            const n = spec.childForFieldName('name');
            if (n) specs.push(n.text);
          }
        }
        return specs.join(', ') || null;
      }
    }
    return null;
  }

  /** Clean up resources. */
  dispose(): void {
    for (const query of this.queries.values()) {
      try { query.delete(); } catch { /* ignore */ }
    }
    this.queries.clear();
    if (this.parser) {
      try { this.parser.delete(); } catch { /* ignore */ }
    }
    this.parser = null;
    this.languages.clear();
    this.initialized = false;
  }
}
