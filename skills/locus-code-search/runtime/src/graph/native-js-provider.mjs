import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { openSqlDatabase } from "./sqlite-driver.mjs";
import {
  expandCodeToken,
  extractIndexTerms,
  normalizeSearchQuery,
} from "../search/query-normalizer.mjs";
import { createProjectIgnoreMatcher } from "../retrieval/project-ignore.mjs";
import { rankAndSelectFiles } from "../retrieval/result-policy.mjs";
import { MAX_RESIDENT_PROJECTS } from "../resource-limits.mjs";
import { bridgeQueryTerms } from "../search/query-bridge.mjs";
import { splitSearchQuery } from "../search/query-normalizer.mjs";
import { fuseClauseResults } from "../search/clause-fusion.mjs";

// v6: retain v5 Go coverage and persist every index-build omission in coverage
// metadata so bounded search text / relation extraction is never silent.
const INDEX_VERSION = "native-symbol-index-v6";
const DEFAULT_GRAPH_DIR = ".locus-mcp/graph";
const DEFAULT_DB_NAME = "js-symbols.sqlite";
const DEFAULT_MAX_FILE_BYTES = 1_000_000;
const DEFAULT_MAX_FILES = 5000;
const SEARCH_TERM_LIMIT = 3500;
const CALL_TARGETS_PER_NAME = 3;
const CALL_EDGES_PER_FILE = 120;
const TEST_EDGES_PER_FILE = 5;

const SOURCE_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".go",
]);

const EXCLUDED_DIRS = new Set([
  ".locus-mcp",
  ".git",
  ".hg",
  ".svn",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".cache",
  "coverage",
  "dist",
  "build",
  "out",
  "node_modules",
  "vendor",
  "deps",
  "third_party",
]);

const JS_KEYWORDS = new Set([
  "as",
  "async",
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "default",
  "delete",
  "do",
  "else",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "from",
  "function",
  "get",
  "if",
  "import",
  "in",
  "instanceof",
  "let",
  "new",
  "null",
  "of",
  "return",
  "set",
  "static",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "undefined",
  "var",
  "void",
  "while",
  "with",
  "yield",
]);

// Genuine function words only. Domain nouns/verbs that can be a query's head
// term (command, mode, local, bypass, parsed, generated, implementation, ...)
// must NOT be dropped — "where is the command parser" loses its subject otherwise.
const QUERY_STOP_WORDS = new Set([
  "a",
  "about",
  "after",
  "all",
  "and",
  "are",
  "around",
  "be",
  "before",
  "by",
  "can",
  "code",
  "could",
  "does",
  "file",
  "files",
  "find",
  "for",
  "from",
  "happen",
  "how",
  "in",
  "including",
  "is",
  "it",
  "large",
  "make",
  "makes",
  "making",
  "of",
  "on",
  "or",
  "project",
  "repositories",
  "the",
  "this",
  "to",
  "when",
  "where",
  "which",
  "who",
  "with",
]);

const QUERY_INTENT_TERMS = Object.freeze({
  calls: ["call", "calls", "caller", "callers", "callee", "callees", "impact"],
  imports: ["import", "imports", "dependency", "dependencies", "export", "exports"],
  routes: ["route", "routes", "routing", "handler", "endpoint", "api", "http"],
  tests: ["test", "tests", "spec", "coverage"],
});

const TOOLING_QUERY_TERMS = Object.freeze([
  "benchmark",
  "benchmarks",
  "check",
  "cli",
  "graph",
  "index",
  "script",
  "scripts",
  "task",
  "tasks",
]);

const RUNTIME_SURFACE_QUERY_TERMS = Object.freeze([
  "api",
  "auth",
  "credential",
  "credentials",
  "endpoint",
  "http",
  "mcp",
  "relay",
  "request",
  "requests",
  "route",
  "server",
  "tool",
  "tools",
  "windsurf",
]);

const RUNTIME_SURFACE_ENTRYPOINT_TERMS = Object.freeze([
  "api",
  "endpoint",
  "http",
  "mcp",
  "relay",
  "request",
  "requests",
  "route",
  "server",
  "tool",
  "tools",
]);

const RANGE_ALIAS_GROUPS = Object.freeze([
  {
    triggers: ["command", "commands", "cmd", "cmds"],
    aliases: ["command", "commands", "cmd", "cmds", "toolargs"],
    weight: 0.85,
  },
  {
    triggers: ["execute", "executed", "execution", "exec", "run", "runs", "running"],
    aliases: ["exec", "execute", "executor", "await"],
    weight: 0.9,
  },
  {
    triggers: ["parse", "parsed", "parsing"],
    aliases: ["parse", "args", "toolargs", "json"],
    weight: 0.75,
  },
  {
    triggers: ["local", "locally"],
    aliases: ["local"],
    weight: 0.6,
  },
]);

const LOCAL_EXECUTOR_RANGE_TRIGGER_TERMS = Object.freeze(["local", "locally"]);
const LOCAL_EXECUTOR_RANGE_SUPPORT_TERMS = Object.freeze([
  "command",
  "commands",
  "cmd",
  "cmds",
  "execute",
  "executed",
  "execution",
  "exec",
  "parse",
  "parsed",
  "parsing",
]);

const RESTRICTED_EXEC_RANGE_TERMS = Object.freeze([
  ["restricted_exec", 2.4],
  ["toolname", 1.0],
  ["toolargs", 0.95],
  ["cmds", 0.95],
  ["exectoolcallasync", 1.15],
  ["executor", 0.9],
]);

function toPosixPath(path) {
  return path.replace(/\\/g, "/");
}

function getDbPath(projectRoot, opts = {}) {
  return resolve(projectRoot, opts.dbPath || join(DEFAULT_GRAPH_DIR, DEFAULT_DB_NAME));
}

async function openDatabase(dbPath = null) {
  // Engine selection lives in sqlite-driver.mjs: native better-sqlite3 when
  // available (mmap open, native query speed), sql.js WASM fallback otherwise.
  return openSqlDatabase(dbPath);
}

// ─── Hot-path caches ───────────────────────────────────────
// Deserializing the sqlite file into the sql.js WASM heap and walking the whole
// project tree used to happen 2-4x per query. Read paths share one Database per
// db file (keyed by size+mtime) and one scan result per root within a short TTL.
// Write paths (build/sync) keep private handles and invalidate after persist.

const _dbCache = new Map(); // dbPath -> { db, key }

// Windows statSync is ~0.5-1ms per call and the validation stats (db file +
// every range candidate) dominated query wall time once CPU work was cached.
// A short TTL makes consecutive queries trust the last stat — same tradeoff
// as _scanCache: no meaningfully stale check inside one interaction.
const STAT_KEY_TTL_MS = 1500;
const _statKeyCache = new Map(); // absPath -> { at, key }

function statKeyCached(absPath) {
  const now = Date.now();
  const hit = _statKeyCache.get(absPath);
  if (hit && now - hit.at <= STAT_KEY_TTL_MS) return hit.key;
  let key = null;
  try {
    const st = statSync(absPath);
    key = `${st.size}:${st.mtimeMs}`;
  } catch {
    key = null;
  }
  _statKeyCache.set(absPath, { at: now, key });
  if (_statKeyCache.size > 512) {
    _statKeyCache.delete(_statKeyCache.keys().next().value);
  }
  return key;
}

function _dbFileKey(dbPath) {
  return statKeyCached(dbPath);
}

/**
 * Shared read-only Database handle. Callers must NOT close it.
 * @param {string} dbPath
 */
async function openDatabaseCached(dbPath) {
  const key = _dbFileKey(dbPath);
  if (key) {
    const hit = _dbCache.get(dbPath);
    if (hit && hit.key === key) {
      _dbCache.delete(dbPath);
      _dbCache.set(dbPath, hit);
      return { db: hit.db };
    }
    if (hit) {
      try { hit.db.close(); } catch { /* already closed */ }
      _dbCache.delete(dbPath);
    }
  }
  const { db } = await openDatabase(dbPath);
  if (key) {
    const concurrent = _dbCache.get(dbPath);
    if (concurrent?.key === key) {
      try { db.close(); } catch { /* already closed */ }
      _dbCache.delete(dbPath);
      _dbCache.set(dbPath, concurrent);
      return { db: concurrent.db };
    }
    if (concurrent) invalidateDbCache(dbPath);
    _dbCache.set(dbPath, { db, key });
    while (_dbCache.size > MAX_RESIDENT_PROJECTS) {
      invalidateDbCache(_dbCache.keys().next().value);
    }
  }
  return { db };
}

function invalidateDbCache(dbPath) {
  const hit = _dbCache.get(dbPath);
  if (hit) {
    try { hit.db.close(); } catch { /* already closed */ }
    _dbCache.delete(dbPath);
  }
  _rowsCache.delete(dbPath);
  _statKeyCache.delete(dbPath);
}

/**
 * Close and drop every cached database handle (or one project's).
 * Windows 下原生引擎会保持 db 文件打开，删除索引目录前必须先释放句柄
 * （sql.js 时代把字节读进内存、不持有 OS 句柄，所以没有这个问题）。
 * @param {string} [projectRoot] - 只释放该项目；缺省释放全部。
 */
export function closeNativeJsGraphCaches(projectRoot = null) {
  if (projectRoot) {
    invalidateDbCache(getDbPath(resolve(projectRoot)));
    return;
  }
  for (const dbPath of [..._dbCache.keys()]) invalidateDbCache(dbPath);
  _rowsCache.clear();
  _statKeyCache.clear();
  _fileLinesCache.clear();
}

export function getNativeJsGraphCacheStatus() {
  return {
    maxResidentProjects: MAX_RESIDENT_PROJECTS,
    databasePaths: [..._dbCache.keys()],
    rowDatabasePaths: [..._rowsCache.keys()],
  };
}

const _scanCache = new Map(); // root -> { at, files, snapshot }
const SCAN_CACHE_TTL_MS = 2000;

/**
 * Project scan with short TTL — collapses the repeated status/sync walks inside
 * a single query without ever serving a meaningfully stale staleness check.
 * @param {string} root
 * @param {Object} opts
 */
function scanSourceFilesCached(root, opts = {}) {
  const hit = _scanCache.get(root);
  if (hit && Date.now() - hit.at <= SCAN_CACHE_TTL_MS) return hit;
  const files = scanSourceFiles(root, opts);
  const entry = { at: Date.now(), files, snapshot: makeSourceSnapshot(files) };
  _scanCache.set(root, entry);
  if (_scanCache.size > 16) {
    const oldest = _scanCache.keys().next().value;
    _scanCache.delete(oldest);
  }
  return entry;
}

// ─── Materialized row cache ────────────────────────────────
// Once the DB handle was cached, query latency was dominated by re-decoding
// every row and regex-scanning search_text per query (~40ms on a 100-file
// repo, engine-independent). Cache decoded rows plus a per-file token-count
// map keyed by the same size+mtime key as the handle cache — identifier term
// scoring becomes Map lookups; only CJK/non-word terms still scan text.

const _rowsCache = new Map(); // dbPath -> { key, files, symbols, edges, fileByPath, symbolsByFile }

const WORD_TOKEN_RE = /[a-z0-9_]+/g;

function tokenCountsFor(textLower) {
  const counts = new Map();
  for (const match of textLower.matchAll(WORD_TOKEN_RE)) {
    const token = match[0];
    counts.set(token, (counts.get(token) || 0) + 1);
  }
  return counts;
}

function loadGraphRows(db, dbPath) {
  const key = _dbFileKey(dbPath);
  const hit = _rowsCache.get(dbPath);
  if (hit && key && hit.key === key) {
    _rowsCache.delete(dbPath);
    _rowsCache.set(dbPath, hit);
    return hit;
  }

  const files = execObjects(db, "SELECT path, line_count, search_text FROM files");
  const symbols = execObjects(db, "SELECT file_path, name, kind, line_start, line_end, exported, signature FROM symbols");
  const edges = execObjects(db, "SELECT from_file, to_file, kind, from_symbol, to_symbol FROM edges");

  for (const file of files) {
    file._searchLower = String(file.search_text || "").toLowerCase();
    file._pathLower = String(file.path || "").toLowerCase();
    file._tokenCounts = tokenCountsFor(file._searchLower);
  }
  for (const symbol of symbols) {
    symbol._nameLower = String(symbol.name).toLowerCase();
    symbol._parts = splitIdentifier(symbol.name);
  }
  for (const edge of edges) {
    // edgeSearchText/kind 归一化曾按 边×词×查询 重复计算——是热路径最大单项。
    edge._searchText = edgeSearchText(edge);
    edge._kindNorm = normalizeEdgeKind(edge.kind);
  }

  const fileByPath = new Map(files.map((file) => [file.path, file]));
  const symbolsByFile = new Map();
  for (const symbol of symbols) {
    if (!symbolsByFile.has(symbol.file_path)) symbolsByFile.set(symbol.file_path, []);
    symbolsByFile.get(symbol.file_path).push(symbol);
  }

  const entry = { key, files, symbols, edges, fileByPath, symbolsByFile };
  if (key) {
    _rowsCache.set(dbPath, entry);
    if (_rowsCache.size > MAX_RESIDENT_PROJECTS) {
      const oldest = _rowsCache.keys().next().value;
      _rowsCache.delete(oldest);
    }
  }
  return entry;
}

/**
 * Term occurrence count for one file. Identifier-shaped terms hit the cached
 * token map (equivalent to the \b-delimited regex count); CJK and non-word
 * terms fall back to the text scan.
 */
function countTermInFile(file, term) {
  if (file._tokenCounts && /^[a-z0-9_]+$/.test(term)) {
    return file._tokenCounts.get(term) || 0;
  }
  const text = file._searchLower ?? String(file.search_text || "").toLowerCase();
  return countTerm(text, term);
}

function createSchema(db) {
  db.run(`
    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS files (
      path TEXT PRIMARY KEY,
      mtime_ms REAL NOT NULL,
      size INTEGER NOT NULL,
      language TEXT NOT NULL,
      line_count INTEGER NOT NULL,
      search_text TEXT NOT NULL,
      indexed_at_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS symbols (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_path TEXT NOT NULL,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      line_start INTEGER NOT NULL,
      line_end INTEGER NOT NULL,
      exported INTEGER NOT NULL,
      signature TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS edges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_file TEXT NOT NULL,
      to_file TEXT NOT NULL,
      kind TEXT NOT NULL,
      from_symbol TEXT,
      to_symbol TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_path);
    CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
    CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(from_file);
    CREATE INDEX IF NOT EXISTS idx_edges_to ON edges(to_file);
  `);
}

function clearIndex(db) {
  db.run(`
    DELETE FROM metadata;
    DELETE FROM edges;
    DELETE FROM symbols;
    DELETE FROM files;
  `);
}

function setMetadata(db, key, value) {
  const stmt = db.prepare("INSERT OR REPLACE INTO metadata(key, value) VALUES (?, ?)");
  stmt.run([key, String(value)]);
  stmt.free();
}

function readMetadata(db) {
  const rows = db.exec("SELECT key, value FROM metadata");
  const metadata = {};
  if (!rows.length) return metadata;
  for (const [key, value] of rows[0].values) metadata[key] = value;
  return metadata;
}

function languageForPath(path) {
  const ext = extname(path).toLowerCase();
  if (ext === ".go") return "go";
  if (ext.includes("ts")) return "typescript";
  return "javascript";
}

function shouldSkipDir(name) {
  return EXCLUDED_DIRS.has(name);
}

function scanSourceFiles(projectRoot, opts = {}) {
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
  const maxFileBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const root = resolve(projectRoot);
  const files = [];
  const coverage = {
    maxFiles,
    maxFileBytes,
    sourceFilesSeen: 0,
    skippedByFileLimit: 0,
    skippedTooLarge: 0,
    readFailures: 0,
  };
  const ignoreMatcher = createProjectIgnoreMatcher(root, {
    hardExcludes: [...EXCLUDED_DIRS].map((name) => `${name}/`),
  });

  function walk(absDir) {
    let entries;
    try {
      entries = readdirSync(absDir, { withFileTypes: true });
    } catch {
      coverage.readFailures += 1;
      return;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const absPath = join(absDir, entry.name);
      const relPath = toPosixPath(relative(root, absPath));
      if (entry.isDirectory()) {
        if (!entry.isSymbolicLink() && !ignoreMatcher.isIgnored(relPath, true)) {
          ignoreMatcher.loadDirectory(absPath);
          walk(absPath);
        }
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = extname(entry.name).toLowerCase();
      if (!SOURCE_EXTENSIONS.has(ext)) continue;
      if (ignoreMatcher.isIgnored(relPath, false)) continue;
      coverage.sourceFilesSeen += 1;

      let stats;
      try {
        stats = statSync(absPath);
      } catch {
        coverage.readFailures += 1;
        continue;
      }
      if (stats.size > maxFileBytes) {
        coverage.skippedTooLarge += 1;
        continue;
      }
      if (files.length >= maxFiles) {
        coverage.skippedByFileLimit += 1;
        continue;
      }
      files.push({
        absPath,
        path: relPath,
        size: stats.size,
        mtimeMs: stats.mtimeMs,
        language: languageForPath(entry.name),
      });
    }
  }

  walk(root);
  Object.defineProperty(files, "ignoreStatus", {
    value: ignoreMatcher.status(),
    enumerable: false,
  });
  Object.defineProperty(files, "coverage", {
    value: {
      ...coverage,
      indexedFiles: files.length,
      complete: coverage.skippedByFileLimit === 0 && coverage.skippedTooLarge === 0 && coverage.readFailures === 0,
    },
    enumerable: false,
  });
  return files;
}

function parseIndexCoverage(value) {
  if (!value) return null;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function createIndexDiagnostics(previousCoverage = null, retainedPaths = null, opts = {}) {
  const previous = parseIndexCoverage(previousCoverage) || {};
  const retain = (paths) => (Array.isArray(paths) ? paths : [])
    .map((path) => String(path))
    .filter((path) => !retainedPaths || retainedPaths.has(path));
  return {
    searchTermLimitedFiles: new Set(retain(previous.searchTermLimitedFiles)),
    sourceReadFailureFiles: new Set(retain(previous.sourceReadFailureFiles)),
    callTargetEdgesOmitted: opts.preserveRelationCounts ? Math.max(0, previous.callTargetEdgesOmitted || 0) : 0,
    callEdgesOmitted: opts.preserveRelationCounts ? Math.max(0, previous.callEdgesOmitted || 0) : 0,
    testEdgesOmitted: opts.preserveRelationCounts ? Math.max(0, previous.testEdgesOmitted || 0) : 0,
  };
}

function buildIndexCoverage(scanCoverage, diagnostics) {
  const searchTermLimitedFiles = [...(diagnostics?.searchTermLimitedFiles || [])].sort();
  const sourceReadFailureFiles = [...(diagnostics?.sourceReadFailureFiles || [])].sort();
  const callTargetEdgesOmitted = Math.max(0, diagnostics?.callTargetEdgesOmitted || 0);
  const callEdgesOmitted = Math.max(0, diagnostics?.callEdgesOmitted || 0);
  const testEdgesOmitted = Math.max(0, diagnostics?.testEdgesOmitted || 0);
  const issues = [];
  if (searchTermLimitedFiles.length) issues.push(`search_term_limit:${searchTermLimitedFiles.length}`);
  if (sourceReadFailureFiles.length) issues.push(`source_read_failure:${sourceReadFailureFiles.length}`);
  if (callTargetEdgesOmitted) issues.push(`call_target_limit:${callTargetEdgesOmitted}`);
  if (callEdgesOmitted) issues.push(`call_edge_limit:${callEdgesOmitted}`);
  if (testEdgesOmitted) issues.push(`test_edge_limit:${testEdgesOmitted}`);
  return {
    ...(scanCoverage || {}),
    searchTermLimitedFiles,
    sourceReadFailureFiles,
    callTargetEdgesOmitted,
    callEdgesOmitted,
    testEdgesOmitted,
    issues,
    complete: scanCoverage?.complete !== false && issues.length === 0,
  };
}

function makeSourceSnapshot(files) {
  const hash = createHash("sha1");
  let totalSize = 0;
  let newestSourceMtime = 0;
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));

  for (const file of sorted) {
    totalSize += file.size;
    newestSourceMtime = Math.max(newestSourceMtime, file.mtimeMs);
    hash.update(file.path);
    hash.update("\0");
    hash.update(String(file.size));
    hash.update("\0");
    hash.update(String(file.mtimeMs));
    hash.update("\0");
  }

  return {
    signature: hash.digest("hex"),
    fileCount: files.length,
    totalSize,
    newestSourceMtime,
  };
}

function stripCommentsPreserveLines(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n\r]/g, " "))
    .replace(/(^|[^:])\/\/[^\n\r]*/g, (match, prefix) => `${prefix}${" ".repeat(match.length - prefix.length)}`);
}

function makeLineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

function lineAtIndex(lineStarts, index) {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (lineStarts[mid] <= index) lo = mid + 1;
    else hi = mid - 1;
  }
  return Math.max(1, hi + 1);
}

function lineTextAt(text, lineStarts, line) {
  const start = lineStarts[line - 1] ?? 0;
  const end = lineStarts[line] === undefined ? text.length : lineStarts[line] - 1;
  return text.slice(start, end).trim();
}

function findBlockEndLine(text, lineStarts, startIndex) {
  const startLine = lineAtIndex(lineStarts, startIndex);
  const braceIndex = text.indexOf("{", startIndex);
  const semiIndex = text.indexOf(";", startIndex);
  if (semiIndex !== -1 && (braceIndex === -1 || semiIndex < braceIndex)) {
    return Math.max(startLine, lineAtIndex(lineStarts, semiIndex));
  }
  if (braceIndex === -1 || braceIndex - startIndex > 800) {
    return Math.min(lineStarts.length, startLine + 20);
  }

  let depth = 0;
  const maxIndex = Math.min(text.length, braceIndex + 80_000);
  for (let i = braceIndex; i < maxIndex; i++) {
    const char = text[i];
    if (char === "{") depth++;
    else if (char === "}") {
      depth--;
      if (depth === 0) return lineAtIndex(lineStarts, i);
    }
  }
  return Math.min(lineStarts.length, startLine + 120);
}

function splitIdentifier(value) {
  return String(value)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9_$]+/)
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length >= 2);
}

function addIdentifierParts(target, value) {
  for (const part of expandCodeToken(value)) {
    if (!JS_KEYWORDS.has(part)) target.add(part);
  }
}

function makeSignature(text, lineStarts, line) {
  return lineTextAt(text, lineStarts, line).slice(0, 240);
}

// ─── Go extractor ──────────────────────────────────────────
// Go 语法高度规则（top-level 声明全部顶格、块用花括号），正则 + 既有的
// findBlockEndLine 花括号计数即可达到接近 AST 的符号精度，且零新依赖。
// 导出性 = 首字母大写（Go 语言规则本身）。

const GO_KEYWORDS = new Set([
  "break", "case", "chan", "const", "continue", "default", "defer", "else",
  "fallthrough", "for", "func", "go", "goto", "if", "import", "interface",
  "map", "package", "range", "return", "select", "struct", "switch", "type", "var",
]);

function extractGoSymbols(text, stripped, relPath) {
  const lineStarts = makeLineStarts(text);
  const symbols = [];
  const seen = new Set();

  function addGoSymbol(index, name, kind) {
    if (!name || GO_KEYWORDS.has(name) || name === "_") return;
    const lineStart = lineAtIndex(lineStarts, index);
    const lineEnd = findBlockEndLine(stripped, lineStarts, index);
    // 按 名字+行 去重（与 kind 无关）：type 兜底正则会与 struct/interface
    // 模式命中同一行，先注册的更精确 kind 优先。
    const key = `${name}:${lineStart}`;
    if (seen.has(key)) return;
    seen.add(key);
    symbols.push({
      filePath: relPath,
      name,
      kind,
      lineStart,
      lineEnd,
      exported: /^[A-Z]/.test(name) ? 1 : 0,
      signature: makeSignature(text, lineStarts, lineStart),
    });
  }

  const patterns = [
    // func Name( / func (recv T) Name(
    { kind: "function", regex: /^func\s+([A-Za-z_]\w*)\s*\(/gm },
    { kind: "method", regex: /^func\s+\([^)]*\)\s+([A-Za-z_]\w*)\s*\(/gm },
    { kind: "class", regex: /^type\s+([A-Za-z_]\w*)\s+struct\b/gm },
    { kind: "interface", regex: /^type\s+([A-Za-z_]\w*)\s+interface\b/gm },
    // 其余 type 别名（struct/interface 已由 seen 去重优先占位）
    { kind: "type", regex: /^type\s+([A-Za-z_]\w*)\s+\S/gm },
    // 顶层单行 const/var
    { kind: "const", regex: /^(?:const|var)\s+([A-Za-z_]\w*)\b/gm },
  ];
  for (const { kind, regex } of patterns) {
    let match;
    while ((match = regex.exec(stripped)) !== null) {
      addGoSymbol(match.index, match[1], kind);
    }
  }

  // const ( ... ) / var ( ... ) 块成员（配置变量大多声明在这里）
  const blockRegex = /^(?:const|var)\s*\(/gm;
  let blockMatch;
  while ((blockMatch = blockRegex.exec(stripped)) !== null) {
    const blockEnd = stripped.indexOf("\n)", blockMatch.index);
    if (blockEnd === -1) continue;
    const body = stripped.slice(blockMatch.index, blockEnd);
    const memberRegex = /^\t([A-Za-z_]\w*)\b/gm;
    let member;
    while ((member = memberRegex.exec(body)) !== null) {
      addGoSymbol(blockMatch.index + member.index, member[1], "const");
    }
  }

  return symbols;
}

function extractGoImports(text) {
  const imports = [];
  const singleRegex = /^import\s+(?:\w+\s+)?"([^"]+)"/gm;
  let match;
  while ((match = singleRegex.exec(text)) !== null) {
    imports.push({ specifier: match[1], kind: "imports" });
  }
  const blockRegex = /^import\s*\(([\s\S]*?)^\)/gm;
  while ((match = blockRegex.exec(text)) !== null) {
    const specRegex = /"([^"]+)"/g;
    let spec;
    while ((spec = specRegex.exec(match[1])) !== null) {
      imports.push({ specifier: spec[1], kind: "imports" });
    }
  }
  return imports;
}

function extractSymbols(text, stripped, relPath, language = "javascript") {
  if (language === "go") return extractGoSymbols(text, stripped, relPath);
  const lineStarts = makeLineStarts(text);
  const symbols = [];
  const seen = new Set();

  function addSymbol(match, name, kind, exported = false) {
    if (!name || JS_KEYWORDS.has(name)) return;
    const lineStart = lineAtIndex(lineStarts, match.index);
    const lineEnd = findBlockEndLine(stripped, lineStarts, match.index);
    const key = `${name}:${kind}:${lineStart}`;
    if (seen.has(key)) return;
    seen.add(key);
    symbols.push({
      filePath: relPath,
      name,
      kind,
      lineStart,
      lineEnd,
      exported: exported ? 1 : 0,
      signature: makeSignature(text, lineStarts, lineStart),
    });
  }

  const patterns = [
    { kind: "function", regex: /^\s*(export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm },
    { kind: "class", regex: /^\s*(export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)\b/gm },
    { kind: "interface", regex: /^\s*(export\s+)?interface\s+([A-Za-z_$][\w$]*)\b/gm },
    { kind: "type", regex: /^\s*(export\s+)?type\s+([A-Za-z_$][\w$]*)\b/gm },
    { kind: "enum", regex: /^\s*(export\s+)?enum\s+([A-Za-z_$][\w$]*)\b/gm },
    { kind: "function", regex: /^\s*(export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/gm },
  ];

  for (const { kind, regex } of patterns) {
    let match;
    while ((match = regex.exec(stripped)) !== null) {
      addSymbol(match, match[2], kind, Boolean(match[1]));
    }
  }

  const methodRegex = /^\s{2,}(?:public\s+|private\s+|protected\s+|static\s+|async\s+|override\s+|readonly\s+)*(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::[^{]+)?\{/gm;
  let methodMatch;
  while ((methodMatch = methodRegex.exec(stripped)) !== null) {
    addSymbol(methodMatch, methodMatch[1], "method", false);
  }

  return symbols;
}

function extractImports(text, language = "javascript") {
  if (language === "go") return extractGoImports(text);
  const imports = [];
  const importRegex = /\bimport\s+(?:type\s+)?(?:[^'"`]*?\s+from\s+)?["'`]([^"'`]+)["'`]/g;
  const exportRegex = /\bexport\s+[^"'`]*?\s+from\s+["'`]([^"'`]+)["'`]/g;
  const requireRegex = /\brequire\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g;
  const dynamicImportRegex = /\bimport\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g;

  for (const [regex, kind] of [
    [importRegex, "imports"],
    [exportRegex, "reexports"],
    [requireRegex, "imports"],
    [dynamicImportRegex, "imports"],
  ]) {
    let match;
    while ((match = regex.exec(text)) !== null) {
      imports.push({ specifier: match[1], kind });
    }
  }

  return imports;
}

function resolveRelativeImport(fromFile, specifier, fileSet) {
  if (!specifier.startsWith(".")) return null;
  const baseDir = dirname(fromFile);
  const raw = toPosixPath(join(baseDir, specifier));
  const candidates = [raw];
  for (const ext of SOURCE_EXTENSIONS) candidates.push(`${raw}${ext}`);
  for (const ext of SOURCE_EXTENSIONS) candidates.push(toPosixPath(join(raw, `index${ext}`)));
  return candidates.find((candidate) => fileSet.has(candidate)) || null;
}

function extractRouteEdges(text, fromFile, symbolByName) {
  const edges = [];
  const routeRegex = /\b(?:app|router|server|route)\.(get|post|put|patch|delete|options|head|use)\s*\(\s*["'`]([^"'`]+)["'`]\s*,\s*([A-Za-z_$][\w$]*)/g;
  let match;
  while ((match = routeRegex.exec(text)) !== null) {
    const method = match[1].toUpperCase();
    const route = match[2];
    const handler = match[3];
    const targets = symbolByName.get(handler.toLowerCase()) || [];
    const target = targets[0];
    edges.push({
      fromFile,
      toFile: target?.filePath || fromFile,
      kind: "routes_to",
      fromSymbol: `${method} ${route}`,
      toSymbol: handler,
    });
  }
  return edges;
}

function extractCallEdges(stripped, fromFile, symbolByName, diagnostics = null) {
  const edges = [];
  const processedNames = new Set();
  const callRegex = /\b([A-Za-z_$][\w$]*)\s*\(/g;
  let match;
  while ((match = callRegex.exec(stripped)) !== null) {
    const name = match[1];
    const normalizedName = name.toLowerCase();
    if (JS_KEYWORDS.has(name) || processedNames.has(normalizedName)) continue;
    processedNames.add(normalizedName);
    const targets = symbolByName.get(name.toLowerCase());
    if (!targets?.length) continue;
    const uniqueTargets = [...new Map(targets.map((target) => [target.filePath, target])).values()];
    for (let index = 0; index < uniqueTargets.length; index++) {
      const target = uniqueTargets[index];
      if (index >= CALL_TARGETS_PER_NAME) {
        if (diagnostics) diagnostics.callTargetEdgesOmitted += 1;
        continue;
      }
      if (edges.length >= CALL_EDGES_PER_FILE) {
        if (diagnostics) diagnostics.callEdgesOmitted += 1;
        continue;
      }
      edges.push({
        fromFile,
        toFile: target.filePath,
        kind: "calls",
        fromSymbol: null,
        toSymbol: name,
      });
    }
  }
  return edges;
}

function isTestFile(path) {
  return /(^|\/)__tests__\//.test(path)
    || /\.(test|spec)\.[cm]?[jt]sx?$/.test(path)
    || /[-_]test\.[cm]?[jt]sx?$/.test(path)
    || /_test\.go$/.test(path);
}

function baseWithoutTest(path) {
  return basename(path)
    .replace(/\.(test|spec)\.[cm]?[jt]sx?$/, "")
    .replace(/[-_]test\.[cm]?[jt]sx?$/, "")
    .replace(/_test\.go$/, "")
    .replace(/\.[cm]?[jt]sx?$/, "")
    .replace(/\.go$/, "");
}

function extractTestEdges(fromFile, fileSet, diagnostics = null) {
  if (!isTestFile(fromFile)) return [];
  const base = baseWithoutTest(fromFile);
  const candidates = [];
  for (const file of fileSet) {
    if (file === fromFile || isTestFile(file)) continue;
    if (baseWithoutTest(file) === base) candidates.push(file);
  }
  if (diagnostics && candidates.length > TEST_EDGES_PER_FILE) {
    diagnostics.testEdgesOmitted += candidates.length - TEST_EDGES_PER_FILE;
  }
  return candidates.slice(0, TEST_EDGES_PER_FILE).map((toFile) => ({
    fromFile,
    toFile,
    kind: "tests",
    fromSymbol: null,
    toSymbol: null,
  }));
}

function buildSearchText({ relPath, text, symbols, imports, routeEdges }, diagnostics = null) {
  const terms = new Set();
  addIdentifierParts(terms, relPath);
  for (const symbol of symbols) {
    addIdentifierParts(terms, symbol.name);
    terms.add(symbol.kind);
    if (symbol.exported) terms.add("export");
  }
  for (const item of imports) addIdentifierParts(terms, item.specifier);
  for (const edge of routeEdges) {
    addIdentifierParts(terms, edge.fromSymbol || "");
    addIdentifierParts(terms, edge.toSymbol || "");
    terms.add("route");
    terms.add("handler");
  }

  // Read just far enough beyond the budget to prove whether a term was
  // omitted. The initial identifier count accounts for source terms that are
  // already present and therefore do not consume additional capacity.
  const sourceTerms = extractIndexTerms(text, {
    maxTerms: SEARCH_TERM_LIMIT + terms.size + 1,
  });
  for (const term of sourceTerms) {
    if (JS_KEYWORDS.has(term) || terms.has(term)) continue;
    if (terms.size >= SEARCH_TERM_LIMIT) {
      diagnostics?.searchTermLimitedFiles?.add(relPath);
      break;
    }
    terms.add(term);
  }

  return [...terms].join(" ");
}

function readSourceFile(file) {
  let text;
  try {
    text = readFileSync(file.absPath, "utf8");
  } catch {
    return null;
  }

  return {
    ...file,
    text,
    stripped: stripCommentsPreserveLines(text),
    lineCount: makeLineStarts(text).length,
  };
}

// Edge sync re-derives edges for every file even when only one changed (edges
// are wiped wholesale for cross-file resolution correctness). Caching parsed
// file contents by (mtime, size) turns that pass from O(project) disk reads +
// comment-stripping into cache hits for unchanged files.
const _fileDataCache = new Map(); // path -> { key, data }
const FILE_DATA_CACHE_MAX = 1000;

function readSourceFileCached(file) {
  const key = `${file.mtimeMs}:${file.size}`;
  const hit = _fileDataCache.get(file.path);
  if (hit && hit.key === key) return hit.data;
  const data = readSourceFile(file);
  if (data) {
    if (_fileDataCache.size >= FILE_DATA_CACHE_MAX) _fileDataCache.clear();
    _fileDataCache.set(file.path, { key, data });
  }
  return data;
}

function analyzeSourceFile(file) {
  const source = readSourceFile(file);
  if (!source) return null;
  return {
    ...source,
    symbols: extractSymbols(source.text, source.stripped, source.path, source.language),
  };
}

function makeFileRow(fileData, indexedAtMs, symbolByName, diagnostics = null) {
  const imports = extractImports(fileData.text, fileData.language);
  const routeEdges = extractRouteEdges(fileData.text, fileData.path, symbolByName);
  return [
    fileData.path,
    fileData.mtimeMs,
    fileData.size,
    fileData.language,
    fileData.lineCount,
    buildSearchText({
      relPath: fileData.path,
      text: fileData.stripped,
      symbols: fileData.symbols || [],
      imports,
      routeEdges,
    }, diagnostics),
    indexedAtMs,
  ];
}

function makeEdgesForFile(fileData, symbolByName, fileSet, diagnostics = null) {
  const imports = extractImports(fileData.text, fileData.language);
  const importEdges = imports.map((item) => ({
    fromFile: fileData.path,
    toFile: resolveRelativeImport(fileData.path, item.specifier, fileSet) || `external:${item.specifier}`,
    kind: item.kind,
    fromSymbol: null,
    toSymbol: item.specifier,
  }));
  const routeEdges = extractRouteEdges(fileData.text, fileData.path, symbolByName);
  const callEdges = extractCallEdges(fileData.stripped, fileData.path, symbolByName, diagnostics);
  const testEdges = extractTestEdges(fileData.path, fileSet, diagnostics);
  return [...importEdges, ...routeEdges, ...callEdges, ...testEdges];
}

function insertRows(db, sql, rows) {
  const stmt = db.prepare(sql);
  try {
    for (const row of rows) stmt.run(row);
  } finally {
    stmt.free();
  }
}

function buildSymbolMap(symbols) {
  const map = new Map();
  for (const symbol of symbols) {
    const key = symbol.name.toLowerCase();
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(symbol);
  }
  return map;
}

function edgeToRow(edge) {
  return [
    edge.fromFile,
    edge.toFile,
    edge.kind,
    edge.fromSymbol || null,
    edge.toSymbol || null,
  ];
}

function symbolToRow(symbol) {
  return [
    symbol.filePath,
    symbol.name,
    symbol.kind,
    symbol.lineStart,
    symbol.lineEnd,
    symbol.exported,
    symbol.signature,
  ];
}

function symbolFromDbRow(row) {
  return {
    filePath: String(row.file_path),
    name: String(row.name),
    kind: String(row.kind),
    lineStart: Number(row.line_start),
    lineEnd: Number(row.line_end),
    exported: Number(row.exported),
    signature: String(row.signature || ""),
  };
}

function fileStatsMatch(indexedFile, sourceFile) {
  return Number(indexedFile.size) === sourceFile.size
    && Math.abs(Number(indexedFile.mtime_ms) - sourceFile.mtimeMs) < 0.001;
}

function deleteRecordsForPaths(db, paths) {
  if (!paths.length) return;
  const deleteFiles = db.prepare("DELETE FROM files WHERE path = ?");
  const deleteSymbols = db.prepare("DELETE FROM symbols WHERE file_path = ?");
  try {
    for (const path of paths) {
      deleteFiles.run([path]);
      deleteSymbols.run([path]);
    }
  } finally {
    deleteFiles.free();
    deleteSymbols.free();
  }
}

function readScalar(db, sql, params = []) {
  const rows = execObjects(db, sql, params);
  const first = rows[0] || {};
  const value = first.value ?? first["COUNT(*)"] ?? Object.values(first)[0] ?? 0;
  return Number(value);
}

function refreshMetadata(
  db,
  root,
  snapshot,
  indexedAtMs,
  fileCount,
  symbolCount,
  edgeCount,
  ignoreStatus = null,
  coverage = null,
) {
  setMetadata(db, "index_version", INDEX_VERSION);
  setMetadata(db, "project_root", root);
  setMetadata(db, "indexed_at_ms", indexedAtMs);
  setMetadata(db, "source_signature", snapshot.signature);
  setMetadata(db, "source_file_count", snapshot.fileCount);
  setMetadata(db, "source_total_size", snapshot.totalSize);
  setMetadata(db, "source_newest_mtime_ms", snapshot.newestSourceMtime);
  setMetadata(db, "file_count", fileCount);
  setMetadata(db, "symbol_count", symbolCount);
  setMetadata(db, "edge_count", edgeCount);
  setMetadata(db, "ignore_files", JSON.stringify(ignoreStatus?.loadedIgnoreFiles || []));
  setMetadata(db, "coverage", JSON.stringify(coverage || { complete: true }));
}

function persistDatabase(db, dbPath) {
  // Native file-backed handles write through to the db file inside their own
  // transactions — serializing again would just double the I/O.
  if (!db.fileBacked) {
    writeFileSync(dbPath, Buffer.from(db.export()));
  }
  // The on-disk file changed — any shared read handle is now stale.
  invalidateDbCache(dbPath);
}

export async function buildNativeJsGraphIndex(projectRoot, opts = {}) {
  const root = resolve(projectRoot);
  const dbPath = getDbPath(root, opts);
  mkdirSync(dirname(dbPath), { recursive: true });

  const files = scanSourceFiles(root, opts);
  const snapshot = makeSourceSnapshot(files);
  const indexedAtMs = Date.now();
  const fileSet = new Set(files.map((file) => file.path));
  const diagnostics = createIndexDiagnostics();
  const fileData = [];
  for (const file of files) {
    const analyzed = analyzeSourceFile(file);
    if (analyzed) fileData.push(analyzed);
    else diagnostics.sourceReadFailureFiles.add(file.path);
  }
  const allSymbols = fileData.flatMap((file) => file.symbols);

  const symbolByName = buildSymbolMap(allSymbols);
  const allEdges = [];
  const fileRows = [];

  for (const file of fileData) {
    fileRows.push(makeFileRow(file, indexedAtMs, symbolByName, diagnostics));
    allEdges.push(...makeEdgesForFile(file, symbolByName, fileSet, diagnostics));
  }
  const coverage = buildIndexCoverage(files.coverage, diagnostics);

  const { db } = await openDatabase();
  createSchema(db);
  db.run("BEGIN TRANSACTION");
  try {
    clearIndex(db);
    refreshMetadata(
      db,
      root,
      snapshot,
      indexedAtMs,
      fileRows.length,
      allSymbols.length,
      allEdges.length,
      files.ignoreStatus,
      coverage,
    );

    insertRows(
      db,
      `INSERT INTO files(path, mtime_ms, size, language, line_count, search_text, indexed_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      fileRows,
    );
    insertRows(
      db,
      `INSERT INTO symbols(file_path, name, kind, line_start, line_end, exported, signature)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      allSymbols.map(symbolToRow),
    );
    insertRows(
      db,
      `INSERT INTO edges(from_file, to_file, kind, from_symbol, to_symbol)
       VALUES (?, ?, ?, ?, ?)`,
      allEdges.map(edgeToRow),
    );
    db.run("COMMIT");
  } catch (error) {
    db.run("ROLLBACK");
    throw error;
  }

  persistDatabase(db, dbPath);
  db.close();

  return {
    mode: "full",
    dbPath,
    indexedAtMs,
    fileCount: fileRows.length,
    symbolCount: allSymbols.length,
    edgeCount: allEdges.length,
    sourceFileCount: snapshot.fileCount,
    changedFileCount: fileRows.length,
    deletedFileCount: 0,
    reusedFileCount: 0,
    skipped: false,
  };
}

export async function syncNativeJsGraphIndex(projectRoot, opts = {}) {
  const root = resolve(projectRoot);
  const dbPath = getDbPath(root, opts);
  mkdirSync(dirname(dbPath), { recursive: true });

  if (!existsSync(dbPath)) {
    return buildNativeJsGraphIndex(root, opts);
  }

  const files = scanSourceFiles(root, opts);
  const snapshot = makeSourceSnapshot(files);
  const { db } = await openDatabase(dbPath);
  createSchema(db);

  const metadata = readMetadata(db);
  if (metadata.index_version !== INDEX_VERSION || metadata.project_root !== root) {
    db.close();
    return buildNativeJsGraphIndex(root, opts);
  }

  const indexedFiles = execObjects(db, "SELECT path, mtime_ms, size FROM files");
  const indexedByPath = new Map(indexedFiles.map((file) => [String(file.path), file]));
  const sourceByPath = new Map(files.map((file) => [file.path, file]));
  const changedFiles = files.filter((file) => {
    const indexedFile = indexedByPath.get(file.path);
    return !indexedFile || !fileStatsMatch(indexedFile, file);
  });
  const deletedPaths = indexedFiles
    .map((file) => String(file.path))
    .filter((path) => !sourceByPath.has(path));

  if (!changedFiles.length && !deletedPaths.length) {
    const fileCount = readScalar(db, "SELECT COUNT(*) AS value FROM files");
    const symbolCount = readScalar(db, "SELECT COUNT(*) AS value FROM symbols");
    const edgeCount = readScalar(db, "SELECT COUNT(*) AS value FROM edges");
    const indexedAtMs = Number(metadata.indexed_at_ms || Date.now());

    const retainedPaths = new Set(files.map((file) => file.path));
    const diagnostics = createIndexDiagnostics(metadata.coverage, retainedPaths, {
      preserveRelationCounts: true,
    });
    const currentCoverage = buildIndexCoverage(files.coverage, diagnostics);
    const serializedCoverage = JSON.stringify(currentCoverage);
    const serializedIgnoreFiles = JSON.stringify(files.ignoreStatus?.loadedIgnoreFiles || []);
    const metadataChanged = metadata.source_signature !== snapshot.signature
      || metadata.coverage !== serializedCoverage
      || metadata.ignore_files !== serializedIgnoreFiles;

    if (metadataChanged) {
      db.run("BEGIN TRANSACTION");
      try {
        refreshMetadata(
          db,
          root,
          snapshot,
          indexedAtMs,
          fileCount,
          symbolCount,
          edgeCount,
          files.ignoreStatus,
          currentCoverage,
        );
        db.run("COMMIT");
        persistDatabase(db, dbPath);
      } catch (error) {
        db.run("ROLLBACK");
        db.close();
        throw error;
      }
    }

    db.close();
    return {
      mode: "incremental",
      dbPath,
      indexedAtMs,
      fileCount,
      symbolCount,
      edgeCount,
      sourceFileCount: snapshot.fileCount,
      changedFileCount: 0,
      deletedFileCount: 0,
      reusedFileCount: fileCount,
      skipped: true,
    };
  }

  const indexedAtMs = Date.now();
  const changedPaths = new Set(changedFiles.map((file) => file.path));
  const removedPaths = [...new Set([...changedPaths, ...deletedPaths])];
  const retainedIndexPaths = new Set(
    files.map((file) => file.path).filter((path) => !changedPaths.has(path)),
  );
  const diagnostics = createIndexDiagnostics(metadata.coverage, retainedIndexPaths);
  const changedData = [];
  for (const file of changedFiles) {
    const analyzed = analyzeSourceFile(file);
    if (analyzed) changedData.push(analyzed);
    else diagnostics.sourceReadFailureFiles.add(file.path);
  }
  const unchangedSymbols = execObjects(
    db,
    "SELECT file_path, name, kind, line_start, line_end, exported, signature FROM symbols",
  )
    .map(symbolFromDbRow)
    .filter((symbol) => !changedPaths.has(symbol.filePath) && !deletedPaths.includes(symbol.filePath));
  const changedSymbols = changedData.flatMap((file) => file.symbols);
  const allSymbols = [...unchangedSymbols, ...changedSymbols];
  const symbolByName = buildSymbolMap(allSymbols);
  const fileSet = new Set(files.map((file) => file.path));
  const changedDataByPath = new Map(changedData.map((file) => [file.path, file]));
  const allEdges = [];

  for (const file of files) {
    const fileData = changedDataByPath.get(file.path) || readSourceFileCached(file);
    if (!fileData) {
      diagnostics.sourceReadFailureFiles.add(file.path);
      continue;
    }
    allEdges.push(...makeEdgesForFile(fileData, symbolByName, fileSet, diagnostics));
  }

  const fileRows = changedData.map((file) => makeFileRow(file, indexedAtMs, symbolByName, diagnostics));
  const coverage = buildIndexCoverage(files.coverage, diagnostics);

  db.run("BEGIN TRANSACTION");
  try {
    deleteRecordsForPaths(db, removedPaths);
    db.run("DELETE FROM edges");
    insertRows(
      db,
      `INSERT INTO files(path, mtime_ms, size, language, line_count, search_text, indexed_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      fileRows,
    );
    insertRows(
      db,
      `INSERT INTO symbols(file_path, name, kind, line_start, line_end, exported, signature)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      changedSymbols.map(symbolToRow),
    );
    insertRows(
      db,
      `INSERT INTO edges(from_file, to_file, kind, from_symbol, to_symbol)
       VALUES (?, ?, ?, ?, ?)`,
      allEdges.map(edgeToRow),
    );

    const fileCount = readScalar(db, "SELECT COUNT(*) AS value FROM files");
    const symbolCount = readScalar(db, "SELECT COUNT(*) AS value FROM symbols");
    const edgeCount = readScalar(db, "SELECT COUNT(*) AS value FROM edges");
    refreshMetadata(
      db,
      root,
      snapshot,
      indexedAtMs,
      fileCount,
      symbolCount,
      edgeCount,
      files.ignoreStatus,
      coverage,
    );
    db.run("COMMIT");

    persistDatabase(db, dbPath);
    db.close();

    return {
      mode: "incremental",
      dbPath,
      indexedAtMs,
      fileCount,
      symbolCount,
      edgeCount,
      sourceFileCount: snapshot.fileCount,
      changedFileCount: changedFiles.length,
      deletedFileCount: deletedPaths.length,
      reusedFileCount: fileCount - fileRows.length,
      skipped: false,
    };
  } catch (error) {
    db.run("ROLLBACK");
    db.close();
    throw error;
  }
}

function execObjects(db, sql, params = []) {
  const stmt = db.prepare(sql, params);
  const rows = [];
  try {
    while (stmt.step()) rows.push(stmt.getAsObject());
  } finally {
    stmt.free();
  }
  return rows;
}

function tokenizeQuery(query) {
  return normalizeSearchQuery(query, { stopWords: QUERY_STOP_WORDS }).terms;
}

// CJK bigram expansion can yield 40-90 terms; files × terms scans multiply by
// each one. Keep identifier-like terms (highest signal, longest first) and fill
// the remainder with Han bigrams in query order.
const MAX_SCORING_TERMS = 24;

function capScoringTerms(terms) {
  if (terms.length <= MAX_SCORING_TERMS) return terms;
  const ident = [];
  const han = [];
  for (const term of terms) {
    (/\p{Script=Han}/u.test(term) ? han : ident).push(term);
  }
  ident.sort((a, b) => b.length - a.length);
  return [...ident, ...han].slice(0, MAX_SCORING_TERMS);
}

// Term → compiled RegExp. countTerm used to build a fresh RegExp per call —
// ~10^5 allocations per query on files × terms scans.
const _termRegexCache = new Map();

function _termRegex(term) {
  let rx = _termRegexCache.get(term);
  if (!rx) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    rx = /\p{Script=Han}/u.test(term)
      ? new RegExp(escaped, "gu")
      : new RegExp(`\\b${escaped}\\b`, "g");
    if (_termRegexCache.size > 4096) _termRegexCache.clear();
    _termRegexCache.set(term, rx);
  }
  return rx;
}

function countTerm(text, term) {
  const matches = text.match(_termRegex(term));
  return matches ? matches.length : 0;
}

function termMatchesText(text, term) {
  if (/\p{Script=Han}/u.test(term)) return text.includes(term);
  if (term.length <= 3) return countTerm(text, term) > 0;
  return text.includes(term);
}

function rawQueryTerms(query) {
  return new Set(normalizeSearchQuery(query).terms);
}

function queryIntent(terms) {
  const set = new Set(terms);
  return {
    calls: QUERY_INTENT_TERMS.calls.some((term) => set.has(term)),
    imports: QUERY_INTENT_TERMS.imports.some((term) => set.has(term)),
    routes: QUERY_INTENT_TERMS.routes.some((term) => set.has(term)),
    tests: QUERY_INTENT_TERMS.tests.some((term) => set.has(term)),
  };
}

function hasAnyTerm(terms, values) {
  const set = new Set(terms);
  return values.some((value) => set.has(value));
}

function countAnyTerm(terms, values) {
  const set = new Set(terms);
  return values.reduce((count, value) => count + (set.has(value) ? 1 : 0), 0);
}

function queryMentionsTooling(terms) {
  return hasAnyTerm(terms, TOOLING_QUERY_TERMS);
}

function queryMentionsRuntimeSurface(terms) {
  return hasAnyTerm(terms, RUNTIME_SURFACE_QUERY_TERMS);
}

function queryStronglyMentionsRuntimeSurface(terms) {
  const surfaceCount = countAnyTerm(terms, RUNTIME_SURFACE_QUERY_TERMS);
  const hasEntrypointSignal = hasAnyTerm(terms, RUNTIME_SURFACE_ENTRYPOINT_TERMS);
  return surfaceCount >= 2 && hasEntrypointSignal;
}

function isRuntimeSourcePath(path) {
  return path.startsWith("src/") || path.startsWith("app/") || path.startsWith("pages/");
}

function isServerEntrypointPath(path) {
  return /(^|\/)(server|index|main|app|route)\.[cm]?[jt]sx?$/.test(path);
}

function isToolingPath(path) {
  // src/** is product source in user repos — never demote it as "tooling".
  return path.startsWith("scripts/")
    || path.startsWith("benchmarks/")
    || path.startsWith("docs/");
}

function addScore(scores, filePath, amount, reason) {
  if (!scores.has(filePath)) {
    scores.set(filePath, {
      path: filePath,
      rawScore: 0,
      matchedTerms: new Set(),
      reasons: new Set(),
      symbols: new Map(),
      ranges: [],
    });
  }
  const entry = scores.get(filePath);
  entry.rawScore += amount;
  if (reason) entry.reasons.add(reason);
  return entry;
}

function addDirectTermHit(entry, term) {
  if (term) entry.matchedTerms.add(term);
}

function addSymbolHit(entry, symbol, amount, reason, term = "") {
  entry.rawScore += amount;
  if (reason) entry.reasons.add(reason);
  addDirectTermHit(entry, term);
  if (!entry.symbols.has(symbol.name)) entry.symbols.set(symbol.name, symbol);
}

function edgeLabel(file, symbol) {
  return symbol ? `/codebase/${file}#${symbol}` : `/codebase/${file}`;
}

function isImportEdge(edge) {
  return edge.kind === "imports" || edge.kind === "reexports";
}

function edgeSearchText(edge) {
  const parts = new Set();
  addIdentifierParts(parts, edge.from_symbol || "");
  addIdentifierParts(parts, edge.to_symbol || "");
  return [...parts].join(" ");
}

function normalizeEdgeKind(value) {
  return String(value || "").replace(/_/g, "").replace(/s$/, "");
}

const _normTermCache = new Map();

function normalizeEdgeTermCached(term) {
  let normalized = _normTermCache.get(term);
  if (normalized === undefined) {
    normalized = normalizeEdgeKind(term);
    if (_normTermCache.size > 2048) _normTermCache.clear();
    _normTermCache.set(term, normalized);
  }
  return normalized;
}

function edgeKindMatchesTerm(kind, term) {
  return normalizeEdgeKind(kind) === normalizeEdgeTermCached(term);
}

function edgeMatchesTerm(edge, term) {
  const kindNorm = edge._kindNorm ?? normalizeEdgeKind(edge.kind);
  if (kindNorm === normalizeEdgeTermCached(term)) return true;
  const text = edge._searchText ?? edgeSearchText(edge);
  return termMatchesText(text, term);
}

function edgeTermHits(edge, terms) {
  return terms.filter((term) => edgeMatchesTerm(edge, term));
}

function makeTermWeights(terms, files, symbols) {
  const fileTerms = new Map();
  for (const file of files) {
    const pathLower = file._pathLower ?? String(file.path || "").toLowerCase();
    const present = new Set();
    for (const term of terms) {
      if (pathLower.includes(term) || countTermInFile(file, term) > 0) present.add(term);
    }
    fileTerms.set(file.path, present);
  }

  for (const symbol of symbols) {
    const present = fileTerms.get(symbol.file_path);
    if (!present) continue;
    const name = symbol._nameLower ?? String(symbol.name || "").toLowerCase();
    const parts = symbol._parts ?? splitIdentifier(symbol.name || "");
    for (const term of terms) {
      if (name === term || parts.includes(term) || (term.length >= 4 && name.includes(term))) {
        present.add(term);
      }
    }
  }

  const totalFiles = Math.max(files.length, 1);
  const weights = new Map();
  for (const term of terms) {
    let df = 0;
    for (const present of fileTerms.values()) {
      if (present.has(term)) df++;
    }
    const idf = Math.log2((totalFiles + 1) / (df + 1));
    weights.set(term, Math.max(0.45, Math.min(1.8, idf + 0.55)));
  }
  return weights;
}

function termWeight(termWeights, term) {
  return termWeights.get(term) ?? 1;
}

function sumTermWeights(termWeights, terms) {
  return terms.reduce((sum, term) => sum + termWeight(termWeights, term), 0);
}

function addRangeTerm(rangeTerms, term, weight) {
  if (!term || term.length < 2) return;
  rangeTerms.set(term, Math.max(rangeTerms.get(term) || 0, weight));
}

function addRangeAliases(rangeTerms, rawTerms, rawValues, aliases, weight) {
  if (!rawValues.some((value) => rawTerms.has(value))) return;
  for (const alias of aliases) addRangeTerm(rangeTerms, alias, weight);
}

function makeRangeTerms(query, terms, termWeights) {
  const rangeTerms = new Map();
  for (const term of terms) addRangeTerm(rangeTerms, term, termWeight(termWeights, term));

  const rawTerms = rawQueryTerms(query);
  for (const group of RANGE_ALIAS_GROUPS) {
    addRangeAliases(rangeTerms, rawTerms, group.triggers, group.aliases, group.weight);
  }
  if (
    LOCAL_EXECUTOR_RANGE_TRIGGER_TERMS.some((term) => rawTerms.has(term))
    && LOCAL_EXECUTOR_RANGE_SUPPORT_TERMS.some((term) => rawTerms.has(term))
  ) {
    addRangeTerm(rangeTerms, "executor", 0.6);
  }

  if (terms.includes("restricted_exec")) {
    for (const [term, weight] of RESTRICTED_EXEC_RANGE_TERMS) addRangeTerm(rangeTerms, term, weight);
  }

  return rangeTerms;
}

function edgeMatchesIntent(edge, intent) {
  if (edge.kind === "calls") return intent.calls;
  if (isImportEdge(edge)) return intent.imports;
  if (edge.kind === "routes_to") return intent.routes;
  if (edge.kind === "tests") return intent.tests;
  return false;
}

function scoreRelevantEdge(edge, terms, intent, topPaths, termWeights) {
  const fromTop = topPaths.has(edge.from_file);
  const toTop = topPaths.has(edge.to_file);
  if (!fromTop && !toTop) return null;

  const termHits = edgeTermHits(edge, terms);
  const intentMatch = edgeMatchesIntent(edge, intent);
  const bothTop = fromTop && toTop;
  let allowed = false;

  if (isImportEdge(edge)) {
    allowed = bothTop || intentMatch || termHits.length > 0;
  } else if (edge.kind === "calls") {
    allowed = termHits.length > 0 || intentMatch;
  } else if (edge.kind === "routes_to") {
    allowed = termHits.length > 0 || intentMatch || bothTop;
  } else if (edge.kind === "tests") {
    allowed = termHits.length > 0 || intentMatch || bothTop;
  } else {
    allowed = termHits.length > 0 || intentMatch;
  }

  if (!allowed) return null;

  let score = 0;
  if (bothTop) score += isImportEdge(edge) ? 1.2 : 0.35;
  else score += 0.15;
  score += sumTermWeights(termWeights, termHits) * 0.9;
  if (intentMatch) score += 0.7;
  if (edge.kind === "routes_to") score += 0.25;
  if (edge.kind === "tests") score += 0.2;

  return { edge, score, termHits };
}

function edgeEndpoint(file, symbol, includeSymbol = true) {
  if (file.startsWith("external:")) return file;
  return edgeLabel(file, includeSymbol ? symbol : null);
}

function edgeToResult(edge) {
  if (isImportEdge(edge)) {
    return {
      from: edgeEndpoint(edge.from_file, null, false),
      to: edgeEndpoint(edge.to_file, null, false),
      kind: edge.kind,
    };
  }

  return {
    from: edgeEndpoint(edge.from_file, edge.from_symbol),
    to: edgeEndpoint(edge.to_file, edge.to_symbol),
    kind: edge.kind,
  };
}

function selectRelevantEdges(
  edges,
  terms,
  intent,
  topPaths,
  termWeights,
  maxEdges = 20,
  maxCallEdges = 4,
) {
  const seen = new Set();
  const ranked = [];

  for (const edge of edges) {
    const scored = scoreRelevantEdge(edge, terms, intent, topPaths, termWeights);
    if (!scored) continue;
    const result = edgeToResult(edge);
    const key = `${result.kind}:${result.from}->${result.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    ranked.push({ ...scored, result });
  }

  ranked.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.termHits.length !== a.termHits.length) return b.termHits.length - a.termHits.length;
    return `${a.result.kind}:${a.result.from}:${a.result.to}`.localeCompare(`${b.result.kind}:${b.result.from}:${b.result.to}`);
  });

  const selected = [];
  let callCount = 0;
  for (const item of ranked) {
    if (item.result.kind === "calls") {
      if (callCount >= maxCallEdges) continue;
      callCount++;
    }
    selected.push(item.result);
    if (selected.length >= maxEdges) break;
  }
  return selected;
}

function resultEndpointPath(endpoint) {
  return String(endpoint || "").replace(/^\/codebase\//, "").replace(/#.*$/, "");
}

function buildFileEvidence(filePath, symbols, edges, exhaustive = false) {
  const limit = exhaustive ? Number.POSITIVE_INFINITY : 8;
  const definitions = (symbols || []).slice(0, limit).map((symbol) => ({
    name: String(symbol.name || ""),
    kind: String(symbol.kind || "symbol"),
    range: [Number(symbol.line_start), Number(symbol.line_end)],
    exported: Boolean(Number(symbol.exported)),
  }));
  const related = (edges || []).filter((edge) => (
    resultEndpointPath(edge.from) === filePath || resultEndpointPath(edge.to) === filePath
  ));
  const compact = (items, edgeLimit = exhaustive ? Number.POSITIVE_INFINITY : 6) => items.slice(0, edgeLimit).map((edge) => ({
    from: edge.from,
    to: edge.to,
    kind: edge.kind,
  }));
  return {
    definitions,
    references: compact(related.filter((edge) => edge.kind === "calls")),
    imports: compact(related.filter((edge) => edge.kind === "imports")),
    exports: compact(related.filter((edge) => ["exports", "reexports"].includes(edge.kind))),
    tests: compact(related.filter((edge) => edge.kind === "tests")),
    callChain: compact(related.filter((edge) => ["calls", "routes_to"].includes(edge.kind))),
  };
}

function propagateRuntimeSurface(scores, edges, terms) {
  if (!queryMentionsRuntimeSurface(terms)) return;
  const strongSurfaceQuery = queryStronglyMentionsRuntimeSurface(terms);

  for (const edge of edges) {
    if (!isImportEdge(edge)) continue;
    if (!isRuntimeSourcePath(edge.from_file) || !isRuntimeSourcePath(edge.to_file)) continue;

    const targetScore = scores.get(edge.to_file)?.rawScore || 0;
    if (targetScore < 0.45) continue;

    const entry = addScore(
      scores,
      edge.from_file,
      Math.min(0.55, targetScore * 0.28),
      `runtime surface imports high-signal "${edge.to_file}"`,
    );
    if (isServerEntrypointPath(edge.from_file)) {
      entry.rawScore += 0.25;
      entry.reasons.add("server entrypoint for API/tool surface");
      if (strongSurfaceQuery) {
        entry.rawScore += 0.55;
        entry.reasons.add("strong runtime-surface query reaches high-signal implementation");
      }
    }
  }
}

function applyPathRoleAdjustments(scores, terms) {
  const mentionsTooling = queryMentionsTooling(terms);
  const mentionsSurface = queryMentionsRuntimeSurface(terms);
  const strongSurfaceQuery = queryStronglyMentionsRuntimeSurface(terms);

  for (const entry of scores.values()) {
    if (!mentionsTooling && isToolingPath(entry.path)) {
      entry.rawScore *= 0.42;
      entry.reasons.add("deprioritized tooling path for runtime query");
    }

    if (mentionsSurface && isRuntimeSourcePath(entry.path)) {
      entry.rawScore += 0.08;
    }

    if (mentionsSurface && isServerEntrypointPath(entry.path)) {
      entry.rawScore += strongSurfaceQuery ? 0.42 : 0.22;
      entry.reasons.add("runtime API/tool entrypoint");
    }
  }
}

function mergeRanges(ranges, maxRanges = 6) {
  const sorted = ranges
    .filter(([start, end]) => Number.isInteger(start) && Number.isInteger(end) && start >= 1 && end >= start)
    .sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [start, end] of sorted) {
    const last = merged[merged.length - 1];
    if (!last || start > last[1] + 5) {
      merged.push([start, end]);
    } else {
      last[1] = Math.max(last[1], end);
    }
    if (merged.length >= maxRanges) break;
  }
  return merged;
}

function expandSymbolRange(symbol, lineCount) {
  const start = Number(symbol.line_start);
  const end = Number(symbol.line_end);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) return null;
  return [Math.max(1, start - 2), Math.min(lineCount, end + 4)];
}

function rangesOverlapOrClose(a, b, gap = 8) {
  return a[0] <= b[1] + gap && b[0] <= a[1] + gap;
}

function selectOutputRanges(termRanges, symbolRanges, preferSymbols, maxRanges = 6) {
  if (!preferSymbols || !symbolRanges.length) {
    return mergeRanges([...termRanges, ...symbolRanges], maxRanges);
  }

  const distantTermRanges = termRanges.filter((range) => (
    !symbolRanges.some((symbolRange) => rangesOverlapOrClose(range, symbolRange, 12))
  ));
  return mergeRanges([...symbolRanges, ...distantTermRanges], maxRanges);
}

function isPromptLikeLine(trimmed) {
  return /^[-#*>]/.test(trimmed)
    || /^\[TOOL_CALLS\]/.test(trimmed)
    || /^"?(?:command\d+|include|exclude|required|optional)\b/i.test(trimmed);
}

function isCommentLikeLine(trimmed) {
  return /^\/\//.test(trimmed) || /^\/?\*/.test(trimmed);
}

function isCodeLikeLine(trimmed) {
  return /^(?:const|let|var|if|else if|for|while|switch|case|return|await|try|catch|throw|function|class|import|export)\b/.test(trimmed)
    || /[{};=]/.test(trimmed);
}

const LOW_SIGNAL_SINGLE_RANGE_TERMS = new Set(["id", "key"]);

function lineRangeScore(line, rangeTerms, lowerPrecomputed = null) {
  const lower = lowerPrecomputed ?? line.toLowerCase();
  const hits = [];
  let score = 0;

  for (const [term, weight] of rangeTerms) {
    // Substring prefilter: countTerm/termMatchesText can only hit when the
    // term appears verbatim — skip the regex machinery for the ~90% misses.
    if (!lower.includes(term)) continue;
    const exactMatches = countTerm(lower, term);
    if (exactMatches) {
      hits.push(term);
      score += weight * (1.1 + Math.min(exactMatches, 3) * 0.18);
    } else if (termMatchesText(lower, term)) {
      hits.push(term);
      score += weight * 0.58;
    }
  }

  if (!score) return null;

  const trimmed = line.trim();
  const codeLike = isCodeLikeLine(trimmed);
  if (isCommentLikeLine(trimmed)) score *= 0.5;
  if (isPromptLikeLine(trimmed)) score *= 0.38;
  if (codeLike) score *= 1.35;
  if (hits.length === 1 && LOW_SIGNAL_SINGLE_RANGE_TERMS.has(hits[0])) score *= 0.18;

  if (codeLike && /\bif\s*\(.*===/.test(trimmed)) score += 0.9;
  if (codeLike && /\bawait\b.*\(/.test(trimmed)) score += 0.65;
  if (codeLike && /\b(?:const|let|var)\b.*=/.test(trimmed)) score += 0.25;
  if (hits.length > 1) score += (hits.length - 1) * 0.4;

  return score >= 0.25 ? { score, hits } : null;
}

function selectScoredRangeWindows(hits, lineCount, maxRanges = 6) {
  const candidates = hits.map((hit) => {
    let aggregateScore = hit.score;
    for (const other of hits) {
      if (other === hit) continue;
      const distance = Math.abs(other.line - hit.line);
      if (distance <= 12) aggregateScore += other.score * (1 - distance / 16) * 0.7;
      else if (distance <= 40) aggregateScore += other.score * 0.12;
    }
    return {
      start: Math.max(1, hit.line - 20),
      end: Math.min(lineCount, hit.line + 40),
      line: hit.line,
      score: aggregateScore,
    };
  });

  candidates.sort((a, b) => b.score - a.score || a.line - b.line);

  const selected = [];
  for (const candidate of candidates) {
    const overlapsSelected = selected.some((range) => candidate.start <= range.end && candidate.end >= range.start);
    if (overlapsSelected) continue;
    selected.push(candidate);
    if (selected.length >= maxRanges) break;
  }

  return mergeRanges(selected.map((range) => [range.start, range.end]), maxRanges);
}

// Range computation re-reads candidate files every query; cache split +
// lowercased lines keyed by size+mtime (stat is cheap, re-read isn't).
const _fileLinesCache = new Map(); // absPath -> { key, lines, linesLower }
const FILE_LINES_CACHE_MAX = 256;

function cachedFileLines(absPath) {
  const key = statKeyCached(absPath);
  if (!key) return null;
  const hit = _fileLinesCache.get(absPath);
  if (hit && hit.key === key) return hit;
  let text;
  try {
    text = readFileSync(absPath, "utf8");
  } catch {
    return null;
  }
  const lines = text.split(/\r?\n/);
  const entry = { key, lines, linesLower: lines.map((line) => line.toLowerCase()) };
  _fileLinesCache.set(absPath, entry);
  if (_fileLinesCache.size > FILE_LINES_CACHE_MAX) {
    _fileLinesCache.delete(_fileLinesCache.keys().next().value);
  }
  return entry;
}

function findTermRanges(projectRoot, filePath, query, terms, termWeights, precomputedRangeTerms = null, maxRanges = 6) {
  const cached = cachedFileLines(resolve(projectRoot, filePath));
  if (!cached) return [];
  const { lines, linesLower } = cached;
  // rangeTerms is query-invariant — callers scoring many files pass it in once.
  const rangeTerms = precomputedRangeTerms || makeRangeTerms(query, terms, termWeights);
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    const scored = lineRangeScore(lines[i], rangeTerms, linesLower[i]);
    if (!scored) continue;
    hits.push({ line: i + 1, score: scored.score, hits: scored.hits });
  }

  return selectScoredRangeWindows(hits, lines.length, maxRanges);
}

export async function queryNativeJsGraphIndex(projectRoot, query, opts = {}) {
  const clauses = splitSearchQuery(query);
  if (!opts._singleClause && clauses.length > 1) {
    const results = [];
    for (const clause of clauses) {
      results.push(await queryNativeJsGraphIndex(projectRoot, clause, { ...opts, _singleClause: true }));
    }
    return fuseClauseResults(query, clauses, results, { maxResults: opts.maxFiles });
  }
  const root = resolve(projectRoot);
  const dbPath = getDbPath(root, opts);
  if (!existsSync(dbPath)) {
    return {
      usable: false,
      confidence: "low",
      files: [],
      edges: [],
      notes: [`native JS graph index not found at ${dbPath}`],
    };
  }

  // 中文查询附加英文桥接词：本地词法打分对中文近乎失明，桥接词补上信号。
  const normalizedQuery = normalizeSearchQuery(query, {
    stopWords: QUERY_STOP_WORDS,
    maxTerms: opts.exhaustive ? Number.POSITIVE_INFINITY : 96,
    clauseMaxTerms: opts.exhaustive ? Number.POSITIVE_INFINITY : 96,
  });
  const discoveredTerms = [...new Set([
    ...normalizedQuery.terms,
    ...bridgeQueryTerms(query, {
      maxTerms: opts.exhaustive ? Number.MAX_SAFE_INTEGER : undefined,
    }),
  ])];
  const terms = opts.exhaustive ? discoveredTerms : capScoringTerms(discoveredTerms);
  if (!terms.length) {
    return {
      usable: false,
      confidence: "low",
      files: [],
      edges: [],
      notes: ["query did not contain searchable code terms"],
    };
  }

  // LOCUS_GRAPH_TIMING=1 打印分段耗时（诊断用）
  const timing = process.env.LOCUS_GRAPH_TIMING ? [] : null;
  let timingLast = timing ? performance.now() : 0;
  const mark = (label) => {
    if (!timing) return;
    const now = performance.now();
    timing.push(`${label}=${(now - timingLast).toFixed(1)}`);
    timingLast = now;
  };

  const { db } = await openDatabaseCached(dbPath);
  createSchema(db);
  const metadata = readMetadata(db);
  if (metadata.index_version !== INDEX_VERSION || metadata.project_root !== root) {
    return {
      usable: false,
      confidence: "low",
      files: [],
      edges: [],
      notes: ["native JS graph index metadata does not match this project"],
    };
  }
  mark("open");

  const { files, symbols, edges, fileByPath, symbolsByFile } = loadGraphRows(db, dbPath);
  mark("rows");

  const scores = new Map();
  const intent = queryIntent(terms);
  const termWeights = makeTermWeights(terms, files, symbols);
  mark("weights");

  for (const file of files) {
    const pathLower = file._pathLower;
    for (const term of terms) {
      const weight = termWeight(termWeights, term);
      if (pathLower.includes(term)) {
        const entry = addScore(scores, file.path, 0.34 * weight, `path matched "${term}"`);
        addDirectTermHit(entry, term);
      }
      const occurrences = countTermInFile(file, term);
      if (occurrences) {
        const entry = addScore(
          scores,
          file.path,
          Math.min(0.24, occurrences * 0.08) * weight,
          `indexed text matched "${term}"`,
        );
        addDirectTermHit(entry, term);
      }
    }
  }

  for (const symbol of symbols) {
    const name = symbol._nameLower ?? String(symbol.name).toLowerCase();
    const parts = symbol._parts ?? splitIdentifier(symbol.name);
    for (const term of terms) {
      const weight = termWeight(termWeights, term);
      if (name === term) {
        const entry = scores.get(symbol.file_path) || addScore(scores, symbol.file_path, 0, "");
        addSymbolHit(entry, symbol, 0.58 * weight, `symbol "${symbol.name}" matched exactly`, term);
      } else if (parts.includes(term) || (term.length >= 4 && name.includes(term))) {
        const entry = scores.get(symbol.file_path) || addScore(scores, symbol.file_path, 0, "");
        addSymbolHit(entry, symbol, 0.32 * weight, `symbol "${symbol.name}" matched "${term}"`, term);
      }
    }
  }

  for (const edge of edges) {
    const termHits = edgeTermHits(edge, terms);
    const fromHadPositiveScore = (scores.get(edge.from_file)?.rawScore || 0) > 0;
    const toHadPositiveScore = (scores.get(edge.to_file)?.rawScore || 0) > 0;
    let fromEntry = fileByPath.has(edge.from_file) ? scores.get(edge.from_file) || null : null;
    let toEntry = fileByPath.has(edge.to_file) ? scores.get(edge.to_file) || null : null;

    for (const term of termHits) {
      const weight = termWeight(termWeights, term);
      if (!fromEntry && fileByPath.has(edge.from_file)) fromEntry = addScore(scores, edge.from_file, 0, "");
      if (!toEntry && fileByPath.has(edge.to_file)) toEntry = addScore(scores, edge.to_file, 0, "");
      if (fromEntry) {
        fromEntry.rawScore += 0.12 * weight;
        fromEntry.reasons.add(`${edge.kind} edge matched "${term}"`);
        addDirectTermHit(fromEntry, term);
      }
      if (toEntry) {
        toEntry.rawScore += 0.12 * weight;
        toEntry.reasons.add(`incoming ${edge.kind} edge matched "${term}"`);
        addDirectTermHit(toEntry, term);
      }
    }

    const intentMatch = edgeMatchesIntent(edge, intent);
    if (intentMatch && (termHits.length || fromHadPositiveScore || toHadPositiveScore)) {
      if (!fromEntry && fileByPath.has(edge.from_file)) fromEntry = addScore(scores, edge.from_file, 0, "");
      if (!toEntry && fileByPath.has(edge.to_file)) toEntry = addScore(scores, edge.to_file, 0, "");
      if (fromEntry) {
        fromEntry.rawScore += 0.2;
        fromEntry.reasons.add(`${edge.kind} edge matches query intent`);
      }
      if (toEntry) {
        toEntry.rawScore += 0.2;
        toEntry.reasons.add(`incoming ${edge.kind} edge matches query intent`);
      }
    }
  }

  mark("score-loops");
  propagateRuntimeSurface(scores, edges, terms);
  applyPathRoleAdjustments(scores, terms);
  mark("propagate");

  const sortedCandidates = [...scores.values()]
    .filter((entry) => entry.rawScore > 0)
    .sort((a, b) => b.rawScore - a.rawScore || a.path.localeCompare(b.path));
  const topRawScore = sortedCandidates[0]?.rawScore || 0;
  const minRawScore = Math.max(0.16, topRawScore * 0.08);
  const mentionsTooling = queryMentionsTooling(terms);
  const candidates = sortedCandidates
    .filter((entry) => {
      if (entry.rawScore < minRawScore) return false;
      if (!mentionsTooling && isToolingPath(entry.path) && entry.rawScore < topRawScore * 0.25) return false;
      return true;
    })
    .slice(0, opts.exhaustive ? Number.POSITIVE_INFINITY : Math.max(24, (opts.maxFiles ?? 12) * 3));

  if (!candidates.length) {
    return {
      usable: false,
      confidence: "low",
      files: [],
      edges: [],
      notes: [`native JS graph found no candidates for terms: ${terms.join(", ")}`],
    };
  }

  const topScore = candidates[0].rawScore;
  const secondScore = candidates[1]?.rawScore || 0;
  const matchedTerms = [...candidates[0].matchedTerms];
  const totalQueryWeight = sumTermWeights(termWeights, terms);
  const matchedQueryWeight = sumTermWeights(termWeights, matchedTerms);
  const queryCoverage = totalQueryWeight > 0 ? matchedQueryWeight / totalQueryWeight : 0;
  const matchedTermCount = matchedTerms.length;
  const highCoverageFloor = terms.length <= 1 ? 0.9 : 0.52;
  const mediumCoverageFloor = terms.length <= 1 ? 0.55 : 0.24;
  const highMatchedFloor = terms.length <= 1 ? 1 : 2;
  let confidence = "low";
  if (topScore >= 0.8 && queryCoverage >= highCoverageFloor && matchedTermCount >= highMatchedFloor) {
    confidence = "high";
  } else if (topScore >= 0.34 && queryCoverage >= mediumCoverageFloor && matchedTermCount >= 1) {
    confidence = "medium";
  }
  const topPaths = new Set(candidates.map((candidate) => candidate.path));

  // Line-range extraction re-reads and line-scores each candidate file — defer
  // it until after ranking so it runs for the final <=12 picks, not all ~36
  // candidates (ranking never consumes ranges; result-policy only merges them).
  const rangeMetaByPath = new Map();
  const filesResult = candidates.map((entry) => {
    const matchedSymbols = [...entry.symbols.values()];
    const lineCount = Number(fileByPath.get(entry.path)?.line_count || 1);
    rangeMetaByPath.set(entry.path, { matchedSymbols, lineCount });
    return {
      path: entry.path,
      score: Math.min(1, entry.rawScore / Math.max(topScore, 1)),
      reason: [...entry.reasons].filter(Boolean).slice(0, opts.exhaustive ? Number.POSITIVE_INFINITY : 4).join("; "),
      matchedTerms: [...entry.matchedTerms],
      ranges: [],
      symbols: matchedSymbols.map((symbol) => symbol.name).slice(0, opts.exhaustive ? Number.POSITIVE_INFINITY : 8),
    };
  });

  mark("candidates");
  const edgeLimit = opts.exhaustive ? Number.POSITIVE_INFINITY : (opts.maxEdges ?? 20);
  const callEdgeLimit = opts.exhaustive ? Number.POSITIVE_INFINITY : (opts.maxCallEdges ?? 4);
  const edgesResult = selectRelevantEdges(
    edges,
    terms,
    intent,
    topPaths,
    termWeights,
    edgeLimit,
    callEdgeLimit,
  );
  const evidencedFiles = filesResult.map((file) => ({
    ...file,
    evidence: buildFileEvidence(file.path, symbolsByFile.get(file.path) || [], edgesResult, opts.exhaustive),
  }));
  mark("evidence");
  const rankedFiles = rankAndSelectFiles(evidencedFiles, {
    query,
    maxResults: opts.maxFiles ?? 12,
    confidence,
    edges: edgesResult,
    exhaustive: opts.exhaustive,
  });
  mark("rank");

  const sharedRangeTerms = makeRangeTerms(query, terms, termWeights);
  const rangeLimit = opts.includeAllRanges || opts.exhaustive ? Number.POSITIVE_INFINITY : 6;
  const selectedFiles = rankedFiles.map((file) => {
    const meta = rangeMetaByPath.get(file.path);
    if (!meta) return file;
    const termRanges = findTermRanges(root, file.path, query, terms, termWeights, sharedRangeTerms, rangeLimit);
    const fileSymbols = [...meta.matchedSymbols];
    if (!fileSymbols.length && !termRanges.length) {
      for (const symbol of (symbolsByFile.get(file.path) || []).slice(0, opts.exhaustive ? Number.POSITIVE_INFINITY : 3)) fileSymbols.push(symbol);
    }
    const symbolRanges = fileSymbols
      .slice(0, rangeLimit)
      .map((symbol) => expandSymbolRange(symbol, meta.lineCount))
      .filter(Boolean);
    const mergedRanges = selectOutputRanges(termRanges, symbolRanges, meta.matchedSymbols.length > 0, rangeLimit);
    if (!mergedRanges.length) {
      mergedRanges.push([1, Math.min(meta.lineCount, 160)]);
    }
    return {
      ...file,
      ranges: mergedRanges,
      symbols: fileSymbols.map((symbol) => symbol.name).slice(0, opts.exhaustive ? Number.POSITIVE_INFINITY : 8),
    };
  });

  mark("ranges");
  if (timing) console.error(`[graph-timing] ${timing.join(" ")}`);

  return {
    usable: confidence !== "low",
    confidence,
    queryCoverage,
    matchedTermCount,
    queryTermCount: terms.length,
    topRawScore: topScore,
    scoreMargin: Math.max(0, topScore - secondScore),
    files: selectedFiles,
    edges: edgesResult,
    notes: [
      `native JS graph index: ${metadata.file_count || files.length} files, ${metadata.symbol_count || symbols.length} symbols, ${metadata.edge_count || edges.length} edges`,
      `query terms: ${terms.join(", ")}`,
    ],
    queryDiagnostics: (() => {
      const omittedTerms = [...new Set([
        ...(normalizedQuery.diagnostics?.omittedTerms || []),
        ...discoveredTerms.filter((term) => !terms.includes(term)),
      ])];
      return {
        usedTerms: terms,
        omittedTerms,
        complete: omittedTerms.length === 0,
      };
    })(),
    totalCandidates: candidates.length,
    indexCoverage: (() => {
      try {
        return JSON.parse(metadata.coverage || "");
      } catch {
        return { complete: false, issues: ["coverage_metadata_unavailable"] };
      }
    })(),
  };
}

/**
 * Expose persisted symbol boundaries to Locus Hybrid so both local indexes use
 * the same structural units. Returns an empty map when the graph is absent or
 * belongs to another project/version.
 */
export async function loadNativeJsGraphSymbolRanges(projectRoot, opts = {}) {
  const root = resolve(projectRoot);
  const dbPath = getDbPath(root, opts);
  if (!existsSync(dbPath)) return new Map();

  try {
    // Shared cached handle — must not be closed here.
    const { db } = await openDatabaseCached(dbPath);
    createSchema(db);
    const metadata = readMetadata(db);
    if (metadata.index_version !== INDEX_VERSION || metadata.project_root !== root) return new Map();
    const rows = execObjects(
      db,
      "SELECT file_path, name, kind, line_start, line_end, exported FROM symbols ORDER BY file_path, line_start",
    );
    const result = new Map();
    for (const row of rows) {
      const path = toPosixPath(String(row.file_path || ""));
      if (!path) continue;
      if (!result.has(path)) result.set(path, []);
      result.get(path).push({
        name: String(row.name || ""),
        kind: String(row.kind || "symbol"),
        lineStart: Number(row.line_start),
        lineEnd: Number(row.line_end),
        exported: Boolean(Number(row.exported)),
      });
    }
    return result;
  } catch {
    return new Map();
  }
}

export async function getNativeJsGraphStatus(projectRoot, opts = {}) {
  const root = resolve(projectRoot);
  const dbPath = getDbPath(root, opts);
  if (!existsSync(dbPath)) {
    return { exists: false, usable: false, stale: true, dbPath, reason: "index does not exist" };
  }

  const { db } = await openDatabaseCached(dbPath);
  createSchema(db);
  const metadata = readMetadata(db);

  if (metadata.index_version !== INDEX_VERSION) {
    return { exists: true, usable: false, stale: true, dbPath, reason: "index version mismatch", metadata };
  }
  if (metadata.project_root !== root) {
    return { exists: true, usable: false, stale: true, dbPath, reason: "project root mismatch", metadata };
  }

  const indexedAtMs = Number(metadata.indexed_at_ms || 0);
  const { snapshot } = scanSourceFilesCached(root, opts);
  const stale = metadata.source_signature
    ? metadata.source_signature !== snapshot.signature
    : snapshot.newestSourceMtime > indexedAtMs + 1;
  return {
    exists: true,
    usable: !stale,
    stale,
    dbPath,
    reason: stale ? "source files changed after index build" : "ok",
    metadata,
    sourceSignature: snapshot.signature,
    sourceFileCount: snapshot.fileCount,
    sourceTotalSize: snapshot.totalSize,
    newestSourceMtime: snapshot.newestSourceMtime,
    indexedAtMs,
    ignoreFiles: (() => {
      try { return JSON.parse(metadata.ignore_files || "[]"); } catch { return []; }
    })(),
  };
}

export function createNativeJsGraphProvider(opts = {}) {
  const autoBuild = opts.autoBuild ?? false;
  const rebuild = opts.rebuild ?? false;

  return {
    async status(projectRoot) {
      return getNativeJsGraphStatus(projectRoot, opts);
    },

    async buildContext({ query, projectRoot, maxFiles, exhaustive, includeAllRanges }) {
      let status = await getNativeJsGraphStatus(projectRoot, opts);
      if (rebuild || (!status.usable && autoBuild)) {
        if (rebuild) await buildNativeJsGraphIndex(projectRoot, opts);
        else await syncNativeJsGraphIndex(projectRoot, opts);
        status = await getNativeJsGraphStatus(projectRoot, opts);
      }

      if (!status.usable) {
        return {
          usable: false,
          confidence: "low",
          files: [],
          edges: [],
          notes: [`native JS graph unavailable: ${status.reason}`],
        };
      }

      return queryNativeJsGraphIndex(projectRoot, query, {
        ...opts,
        maxFiles,
        exhaustive,
        includeAllRanges,
      });
    },
  };
}
