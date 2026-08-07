/**
 * Locus-owned local hybrid retrieval.
 *
 * The provider is intentionally self-contained: it scans the target project,
 * maintains an incremental index under .locus-mcp/index, and combines BM25,
 * identifier/subword similarity, and path ranking with reciprocal-rank fusion.
 * No external CLI, MCP server, or background service is required.
 */

import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  watch,
  writeFileSync,
} from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";

import { loadNativeJsGraphSymbolRanges } from "../graph/native-js-provider.mjs";
import {
  expandCodeToken,
  extractIndexTerms,
  normalizeSearchQuery,
} from "../search/query-normalizer.mjs";
import { createProjectIgnoreMatcher } from "./project-ignore.mjs";
import { rankAndSelectFiles } from "./result-policy.mjs";
import { bridgeQueryTerms } from "../search/query-bridge.mjs";
import { splitSearchQuery } from "../search/query-normalizer.mjs";
import { fuseClauseResults } from "../search/clause-fusion.mjs";
import { MAX_RESIDENT_PROJECTS } from "../resource-limits.mjs";

// v4: persist chunking configuration and content hashes so cache reuse can be
// verified without replacing Locus's syntax-aware chunks with coarse blobs.
const INDEX_VERSION = "locus-native-hybrid-v4";
const DEFAULT_INDEX_DIR = ".locus-mcp/index";
const DEFAULT_INDEX_FILE = "hybrid-index.json";
const DEFAULT_MAX_INDEX_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_FILES = 6000;
const DEFAULT_MAX_FILE_BYTES = 1_000_000;
const DEFAULT_CHUNK_LINES = 72;
const DEFAULT_CHUNK_OVERLAP = 16;
const DEFAULT_INDEX_CHECK_INTERVAL_MS = 2_000;
const DEFAULT_WATCH_FALLBACK_MS = 15_000;
const DEFAULT_CONTENT_VERIFY_INTERVAL_MS = 5 * 60_000;

export const DEFAULT_HYBRID_HINT_BUDGET = 5000;
export const DEFAULT_HYBRID_TOP_K = 8;
export const DEFAULT_HYBRID_MAX_SNIPPET_LINES = 10;

const SOURCE_EXTENSIONS = new Set([
  ".c", ".cc", ".cpp", ".cs", ".css", ".dart", ".go", ".graphql", ".h", ".hpp",
  ".html", ".java", ".js", ".jsx", ".kt", ".kts", ".lua", ".md", ".mdx", ".mjs",
  ".php", ".proto", ".py", ".rb", ".rs", ".scss", ".sh", ".sql", ".svelte", ".swift",
  ".toml", ".ts", ".tsx", ".vue", ".xml", ".yaml", ".yml",
]);

const CONFIG_FILE_NAMES = new Set([
  "dockerfile", "makefile", "gemfile", "procfile", ".gitignore", ".dockerignore",
]);

const EXCLUDED_DIRS = new Set([
  ".ace-tool", ".codegraph", ".git", ".hg", ".locus-mcp", ".next", ".nuxt",
  ".svn", ".svelte-kit", ".turbo", ".venv", "build", "coverage", "deps", "dist",
  "node_modules", "out", "target", "third_party", "vendor", "venv",
]);

const STOP_WORDS = new Set([
  "a", "all", "and", "are", "be", "by", "code", "does", "file", "files", "find", "for",
  "from", "how", "in", "is", "it", "of", "on", "or", "the", "this", "to", "where", "with",
]);

const CONCEPT_GROUPS = [
  ["auth", "authenticate", "authentication", "authorize", "authorization", "login", "logout", "jwt", "session", "token", "登录", "登陆", "鉴权", "认证", "授权"],
  ["cache", "cached", "caching", "memo", "redis", "ttl", "缓存"],
  ["config", "configuration", "env", "environment", "option", "setting", "settings", "配置", "环境变量"],
  ["database", "db", "migration", "orm", "pool", "query", "repository", "sql", "数据库", "数据访问"],
  ["error", "exception", "failure", "panic", "retry", "异常", "错误", "失败", "重试"],
  ["event", "log", "logging", "metric", "observability", "telemetry", "trace", "日志", "监控", "埋点", "追踪"],
  ["handler", "middleware", "request", "response", "route", "router", "server", "中间件", "请求", "响应", "路由"],
  ["limit", "quota", "rate", "ratelimit", "throttle", "限流", "配额", "频率"],
  ["search", "index", "rank", "ranking", "retrieval", "semantic", "检索", "搜索", "排序", "索引", "语义"],
  ["test", "testing", "spec", "fixture", "mock", "测试", "样本"],
  ["user", "account", "member", "profile", "用户", "账号", "成员"],
];

const conceptByTerm = new Map();
for (const group of CONCEPT_GROUPS) {
  for (const term of group) conceptByTerm.set(term, group);
}

/** @type {Map<string, { signature: string, configHash: string, index: Object, checkedAtMs: number }>} */
const memoryIndexCache = new Map();
/** @type {WeakMap<Object, { rows: Object[], vocabulary: { term: string, grams: Set<string> }[] }>} */
const retrievalStateCache = new WeakMap();
/** @type {Map<string, Object>} */
const watcherState = new Map();
/** @type {Map<string, true>} */
const residentProjectRoots = new Map();

function closeHybridWatcher(root) {
  const state = watcherState.get(root);
  if (!state) return;
  try { state.handle?.close(); } catch { /* already closed */ }
  watcherState.delete(root);
}

function touchResidentProject(root) {
  residentProjectRoots.delete(root);
  residentProjectRoots.set(root, true);
  while (residentProjectRoots.size > MAX_RESIDENT_PROJECTS) {
    const oldestRoot = residentProjectRoots.keys().next().value;
    residentProjectRoots.delete(oldestRoot);
    memoryIndexCache.delete(oldestRoot);
    closeHybridWatcher(oldestRoot);
  }
}

function normalizeRelPath(path) {
  return String(path || "").replace(/\\/g, "/").replace(/^\/+/, "");
}

function indexPath(projectRoot, opts = {}) {
  return resolve(projectRoot, opts.indexDir || DEFAULT_INDEX_DIR, opts.indexFile || DEFAULT_INDEX_FILE);
}

function chunkingConfig(opts = {}) {
  const chunkLines = Math.max(24, opts.chunkLines || DEFAULT_CHUNK_LINES);
  const chunkOverlap = Math.min(
    chunkLines - 1,
    Math.max(0, opts.chunkOverlap ?? DEFAULT_CHUNK_OVERLAP),
  );
  return {
    chunkLines,
    chunkOverlap,
    contentPolicy: "sanitized-text-v1",
  };
}

function indexConfigHash(opts = {}) {
  return createHash("sha256")
    .update(JSON.stringify(chunkingConfig(opts)))
    .digest("hex");
}

function isSourceFile(name) {
  const lower = name.toLowerCase();
  return SOURCE_EXTENSIONS.has(extname(lower)) || CONFIG_FILE_NAMES.has(lower);
}

function scanProjectFiles(projectRoot, opts = {}) {
  const root = resolve(projectRoot);
  const maxFiles = Math.max(1, opts.maxFiles || DEFAULT_MAX_FILES);
  const maxFileBytes = Math.max(1024, opts.maxFileBytes || DEFAULT_MAX_FILE_BYTES);
  const ignoreMatcher = createProjectIgnoreMatcher(root, {
    hardExcludes: [...EXCLUDED_DIRS].map((name) => `${name}/`),
  });
  const files = [];
  const coverage = {
    maxFiles,
    maxFileBytes,
    sourceFilesSeen: 0,
    skippedByFileLimit: 0,
    skippedTooLarge: 0,
    skippedBinary: 0,
    readFailures: 0,
  };
  const pending = [root];

  while (pending.length) {
    const dir = pending.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      coverage.readFailures += 1;
      continue;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      const fullPath = join(dir, entry.name);
      const relPath = normalizeRelPath(relative(root, fullPath));
      if (entry.isDirectory()) {
        if (!entry.isSymbolicLink() && !ignoreMatcher.isIgnored(relPath, true)) {
          ignoreMatcher.loadDirectory(fullPath);
          pending.push(fullPath);
        }
        continue;
      }
      if (!entry.isFile() || !isSourceFile(entry.name)) continue;
      if (ignoreMatcher.isIgnored(relPath, false)) continue;
      coverage.sourceFilesSeen += 1;

      let stats;
      try {
        stats = statSync(fullPath);
      } catch {
        coverage.readFailures += 1;
        continue;
      }
      if (stats.size <= 0) continue;
      if (stats.size > maxFileBytes) {
        coverage.skippedTooLarge += 1;
        continue;
      }
      if (files.length >= maxFiles) {
        coverage.skippedByFileLimit += 1;
        continue;
      }
      files.push({
        path: relPath,
        fullPath,
        size: stats.size,
        mtimeMs: Math.round(stats.mtimeMs),
      });
    }
  }

  return {
    files: files.sort((a, b) => a.path.localeCompare(b.path)),
    ignore: ignoreMatcher.status(),
    coverage: {
      ...coverage,
      indexedFiles: files.length,
      complete: coverage.skippedByFileLimit === 0 && coverage.skippedTooLarge === 0 && coverage.readFailures === 0,
    },
  };
}

function sourceSignature(files, configHash) {
  const fileSignature = files.map((file) => `${file.path}\0${file.size}\0${file.mtimeMs}`).join("\n");
  return `${configHash}\n${fileSignature}`;
}

function finalizeCoverage(coverage, indexedFiles, skippedBinary = coverage.skippedBinary || 0) {
  const finalized = {
    ...coverage,
    indexedFiles,
    skippedBinary,
  };
  finalized.complete = (
    finalized.skippedByFileLimit === 0
    && finalized.skippedTooLarge === 0
    && finalized.skippedBinary === 0
    && finalized.readFailures === 0
  );
  return finalized;
}

function contentHash(path, text) {
  return createHash("sha256")
    .update(String(path.length))
    .update(":")
    .update(path)
    .update(String(text.length))
    .update(":")
    .update(text)
    .digest("hex");
}

function prepareSourceText(file) {
  let text;
  try {
    text = readFileSync(file.fullPath, "utf8");
  } catch {
    return { ok: false, reason: "read" };
  }
  if (text.includes("\0")) return { ok: false, reason: "binary" };

  let total = 0;
  let nonPrintable = 0;
  for (const character of text) {
    total += 1;
    const code = character.codePointAt(0);
    if (code <= 0x08 || (code >= 0x0e && code <= 0x1f) || code === 0x7f) {
      nonPrintable += 1;
    }
  }
  if (total > 0 && nonPrintable > total / 10) {
    return { ok: false, reason: "binary" };
  }

  const sanitized = text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
  return {
    ok: true,
    text: sanitized,
    contentHash: contentHash(file.path, sanitized),
  };
}

function addCount(counts, term, amount = 1) {
  if (!term || STOP_WORDS.has(term)) return;
  counts[term] = Math.min(255, (counts[term] || 0) + amount);
}

function tokenCountsForText(text, path) {
  const counts = Object.create(null);
  const source = String(text || "");
  const rawTokens = source.match(/[A-Za-z_$][\w$]{1,}|\p{Script=Han}{2,}/gu) || [];
  for (const raw of rawTokens) {
    for (const term of expandCodeToken(raw, STOP_WORDS)) addCount(counts, term);
  }

  // Keep CJK segmentation aligned with query normalization without retaining source text.
  for (const term of extractIndexTerms(source, { maxTerms: Number.POSITIVE_INFINITY, stopWords: STOP_WORDS })) {
    if (!(term in counts)) addCount(counts, term);
  }
  for (const term of normalizeSearchQuery(path, { maxTerms: 80, stopWords: STOP_WORDS }).terms) {
    addCount(counts, term, 2);
  }
  return counts;
}

function markdownRanges(lines) {
  const headings = [];
  for (let index = 0; index < lines.length; index++) {
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(lines[index]);
    if (match) headings.push({ line: index + 1, level: match[1].length, name: match[2].trim() });
  }
  return headings.map((heading, index) => {
    let endLine = lines.length;
    for (let next = index + 1; next < headings.length; next++) {
      if (headings[next].level <= heading.level) {
        endLine = headings[next].line - 1;
        break;
      }
    }
    return { startLine: heading.line, endLine, kind: "section", name: heading.name };
  });
}

function lightweightSymbolRanges(lines, extension) {
  const patterns = [];
  if ([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"].includes(extension)) {
    patterns.push(
      [/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\b/, "function"],
      [/^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)\b/, "class"],
      [/^\s*(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)\b/, "type"],
      [/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/, "function"],
    );
  } else if (extension === ".py") {
    patterns.push([/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\b/, "function"], [/^\s*class\s+([A-Za-z_]\w*)\b/, "class"]);
  } else if (extension === ".go") {
    patterns.push([/^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\b/, "function"], [/^\s*type\s+([A-Za-z_]\w*)\s+/, "type"]);
  } else if (extension === ".rs") {
    patterns.push([/^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)\b/, "function"], [/^\s*(?:pub\s+)?(?:struct|enum|trait|impl)\s+([A-Za-z_]\w*)\b/, "type"]);
  } else if ([".java", ".kt", ".kts", ".cs", ".c", ".cc", ".cpp", ".h", ".hpp"].includes(extension)) {
    patterns.push(
      [/^\s*(?:(?:public|private|protected|internal|static|final|abstract|async|virtual|override)\s+)*(?:class|interface|struct|enum|record)\s+([A-Za-z_]\w*)\b/, "type"],
      [/^\s*(?:(?:public|private|protected|internal|static|final|async|virtual|override|inline|constexpr)\s+)*[\w:<>,?\[\]*&\s]+\s+([A-Za-z_]\w*)\s*\([^;]*\)\s*(?:\{|=>)/, "function"],
    );
  } else if ([".rb", ".php"].includes(extension)) {
    patterns.push([/^\s*(?:def|function)\s+([A-Za-z_]\w*)\b/, "function"], [/^\s*class\s+([A-Za-z_]\w*)\b/, "class"]);
  }

  const starts = [];
  for (let index = 0; index < lines.length; index++) {
    for (const [pattern, kind] of patterns) {
      const match = pattern.exec(lines[index]);
      if (!match) continue;
      starts.push({ startLine: index + 1, kind, name: match[1] });
      break;
    }
  }
  return starts.map((item, index) => ({
    ...item,
    endLine: Math.max(item.startLine, (starts[index + 1]?.startLine || lines.length + 1) - 1),
  }));
}

function structuredRanges(file, lines, graphSymbolRanges) {
  const extension = extname(file.path).toLowerCase();
  if ([".md", ".mdx"].includes(extension)) return markdownRanges(lines);
  const graphRanges = graphSymbolRanges?.get(normalizeRelPath(file.path));
  if (graphRanges?.length) {
    return graphRanges.map((symbol) => ({
      startLine: symbol.lineStart,
      endLine: symbol.lineEnd,
      kind: symbol.kind || "symbol",
      name: symbol.name || "",
    }));
  }
  return lightweightSymbolRanges(lines, extension);
}

function makeChunk(lines, file, startLine, endLine, kind = "window", name = "") {
  const start = Math.max(1, startLine);
  const end = Math.min(lines.length, Math.max(start, endLine));
  const chunkText = lines.slice(start - 1, end).join("\n");
  const termCounts = tokenCountsForText(`${name}\n${chunkText}`, file.path);
  const length = Object.values(termCounts).reduce((sum, value) => sum + Number(value || 0), 0);
  if (!length) return null;
  return { startLine: start, endLine: end, kind, name, length, termCounts };
}

function splitStructuredRange(range, lines, file, chunkLines, overlap) {
  const chunks = [];
  const step = Math.max(1, chunkLines - overlap);
  for (let start = range.startLine; start <= range.endLine; start += step) {
    const end = Math.min(range.endLine, start + chunkLines - 1);
    const chunk = makeChunk(lines, file, start, end, range.kind, range.name);
    if (chunk) chunks.push(chunk);
    if (end >= range.endLine) break;
  }
  return chunks;
}

function makeChunks(file, text, opts = {}, graphSymbolRanges = null) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const { chunkLines, chunkOverlap: overlap } = chunkingConfig(opts);
  const step = Math.max(1, chunkLines - overlap);
  const chunks = [];

  const ranges = structuredRanges(file, lines, graphSymbolRanges)
    .filter((range) => range.startLine >= 1 && range.endLine >= range.startLine)
    .sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);

  if (ranges.length) {
    const firstStart = ranges[0].startLine;
    if (firstStart > 1) {
      const moduleChunk = makeChunk(lines, file, 1, Math.min(lines.length, Math.max(24, firstStart - 1)), "module", "module scope");
      if (moduleChunk) chunks.push(moduleChunk);
    }
    const seen = new Set();
    for (const range of ranges) {
      for (const chunk of splitStructuredRange(range, lines, file, chunkLines, overlap)) {
        const key = `${chunk.startLine}:${chunk.endLine}:${chunk.name}`;
        if (!seen.has(key)) {
          seen.add(key);
          chunks.push(chunk);
        }
      }
    }
  } else {
    for (let start = 0; start < lines.length; start += step) {
      const end = Math.min(lines.length, start + chunkLines);
      const chunk = makeChunk(lines, file, start + 1, end, "window", "");
      if (chunk) chunks.push(chunk);
      if (end >= lines.length) break;
    }
  }
  return chunks;
}

function readIndexCandidate(candidatePath, root, configHash, maxIndexBytes) {
  if (!existsSync(candidatePath)) return null;
  try {
    const stats = statSync(candidatePath);
    if (!stats.isFile() || stats.size > maxIndexBytes) return null;
    const parsed = JSON.parse(readFileSync(candidatePath, "utf8"));
    if (parsed?.version !== INDEX_VERSION || resolve(parsed.projectRoot || "") !== root) return null;
    if (parsed?.configHash !== configHash) return null;
    if (!Array.isArray(parsed.files)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function readPersistedIndex(dbPath, root, configHash, opts = {}) {
  const maxIndexBytes = Math.max(1024, opts.maxIndexBytes || DEFAULT_MAX_INDEX_BYTES);
  return readIndexCandidate(dbPath, root, configHash, maxIndexBytes)
    || readIndexCandidate(`${dbPath}.bak`, root, configHash, maxIndexBytes);
}

function persistIndex(dbPath, index) {
  const temporaryPath = `${dbPath}.${process.pid}.${Date.now()}.tmp`;
  const backupPath = `${dbPath}.bak`;
  try {
    mkdirSync(dirname(dbPath), { recursive: true });
    writeFileSync(temporaryPath, JSON.stringify(index), "utf8");
    if (existsSync(dbPath)) {
      rmSync(backupPath, { force: true });
      copyFileSync(dbPath, backupPath);
    }
    try {
      renameSync(temporaryPath, dbPath);
      return true;
    } catch (error) {
      if (!existsSync(dbPath)) throw error;
    }

    rmSync(dbPath, { force: true });
    try {
      renameSync(temporaryPath, dbPath);
      return true;
    } catch (error) {
      if (!existsSync(dbPath) && existsSync(backupPath)) {
        copyFileSync(backupPath, dbPath);
      }
      throw error;
    }
  } catch {
    // Read-only projects still benefit from the in-memory index for this process.
    try {
      rmSync(temporaryPath, { force: true });
    } catch {
      // Best-effort cleanup only.
    }
    return false;
  }
}

function publicWatcherStatus(state) {
  if (!state) return { mode: "scan", active: false, dirty: false, eventCount: 0 };
  return {
    mode: state.active ? "watch+scan-fallback" : "scan-fallback",
    active: state.active,
    dirty: state.dirty,
    eventCount: state.eventCount,
    dirtyPathCount: state.dirtyAll ? null : state.dirtyPaths.size,
    lastEventAtMs: state.lastEventAtMs || 0,
    lastSyncAtMs: state.lastSyncAtMs || 0,
    error: state.error || null,
  };
}

function ensureNativeHybridWatcher(projectRoot, opts = {}) {
  const root = resolve(projectRoot);
  if (opts.watch === false) return null;
  if (watcherState.has(root)) return watcherState.get(root);

  const state = {
    active: false,
    dirty: false,
    dirtyAll: false,
    dirtyPaths: new Set(),
    eventCount: 0,
    lastEventAtMs: 0,
    lastSyncAtMs: 0,
    error: null,
    handle: null,
  };
  try {
    state.handle = watch(root, { recursive: true, persistent: false }, (_eventType, fileName) => {
      const path = normalizeRelPath(fileName || "");
      if (path === ".locus-mcp" || path.startsWith(".locus-mcp/")) return;
      state.dirty = true;
      if (path) state.dirtyPaths.add(path);
      else state.dirtyAll = true;
      state.eventCount += 1;
      state.lastEventAtMs = Date.now();
    });
    state.handle.unref?.();
    state.handle.on("error", (error) => {
      state.active = false;
      state.error = error?.message || String(error);
    });
    state.active = true;
  } catch (error) {
    state.error = error?.message || String(error);
  }
  watcherState.set(root, state);
  return state;
}

function markWatcherSynced(state, handledEventCount) {
  if (!state) return;
  state.lastSyncAtMs = Date.now();
  if (state.eventCount !== handledEventCount) {
    state.dirty = true;
    return;
  }
  state.dirty = false;
  state.dirtyAll = false;
  state.dirtyPaths.clear();
}

function matchesDirtyPath(path, dirtyPaths) {
  for (const dirtyPath of dirtyPaths) {
    if (path === dirtyPath || path.startsWith(`${dirtyPath.replace(/\/$/, "")}/`)) return true;
  }
  return false;
}

function contentVerificationDue(index, opts = {}) {
  if (opts.verifyContentHashes === true) return true;
  if (opts.verifyContentHashes === false) return false;
  const intervalMs = Math.max(
    0,
    opts.contentVerifyIntervalMs ?? DEFAULT_CONTENT_VERIFY_INTERVAL_MS,
  );
  return Date.now() - Number(index?.contentVerifiedAtMs || 0) >= intervalMs;
}

export function clearNativeHybridCache() {
  memoryIndexCache.clear();
  for (const state of watcherState.values()) {
    try { state.handle?.close(); } catch { /* already closed */ }
  }
  watcherState.clear();
  residentProjectRoots.clear();
}

export function getNativeHybridCacheStatus() {
  return {
    maxResidentProjects: MAX_RESIDENT_PROJECTS,
    residentRoots: [...residentProjectRoots.keys()],
    memoryIndexRoots: [...memoryIndexCache.keys()],
    watcherRoots: [...watcherState.keys()],
  };
}

export async function syncNativeHybridIndex(projectRoot, opts = {}) {
  const root = resolve(projectRoot);
  touchResidentProject(root);
  const dbPath = indexPath(root, opts);
  const configHash = indexConfigHash(opts);
  const memoryCached = memoryIndexCache.get(root);
  const cached = memoryCached?.configHash === configHash ? memoryCached : null;
  const watcher = ensureNativeHybridWatcher(root, opts);
  const configuredCheckIntervalMs = Math.max(
    0,
    opts.indexCheckIntervalMs ?? DEFAULT_INDEX_CHECK_INTERVAL_MS,
  );
  const checkIntervalMs = watcher?.active
    ? Math.max(configuredCheckIntervalMs, opts.watchFallbackMs ?? DEFAULT_WATCH_FALLBACK_MS)
    : configuredCheckIntervalMs;
  const verificationDue = contentVerificationDue(cached?.index, opts);
  if (
    cached
    && !watcher?.dirty
    && !verificationDue
    && Date.now() - cached.checkedAtMs < checkIntervalMs
  ) {
    return {
      index: cached.index,
      changedFileCount: 0,
      reusedFileCount: cached.index.files?.length || 0,
      verifiedFileCount: 0,
      metadataRefreshedFileCount: 0,
      cached: true,
      watcher: publicWatcherStatus(watcher),
    };
  }

  const dirtyPaths = new Set(watcher?.dirtyPaths || []);
  const dirtyAll = Boolean(watcher?.dirtyAll);
  const handledEventCount = watcher?.eventCount || 0;
  const scanned = scanProjectFiles(root, opts);
  const files = scanned.files;
  const signature = sourceSignature(files, configHash);
  if (cached?.signature === signature && !watcher?.dirty && !verificationDue) {
    const reusedCoverage = finalizeCoverage(
      scanned.coverage,
      cached.index.files?.length || 0,
      cached.index.coverage?.skippedBinary || 0,
    );
    const coverageChanged = JSON.stringify(cached.index.coverage || null) !== JSON.stringify(reusedCoverage);
    const ignoreChanged = JSON.stringify(cached.index.ignore || null) !== JSON.stringify(scanned.ignore);
    if (coverageChanged || ignoreChanged) {
      cached.index = {
        ...cached.index,
        coverage: reusedCoverage,
        ignore: scanned.ignore,
      };
      persistIndex(dbPath, cached.index);
    }
    cached.checkedAtMs = Date.now();
    markWatcherSynced(watcher, handledEventCount);
    return {
      index: cached.index,
      changedFileCount: 0,
      reusedFileCount: cached.index.files?.length || 0,
      verifiedFileCount: 0,
      metadataRefreshedFileCount: 0,
      cached: true,
      watcher: publicWatcherStatus(watcher),
    };
  }

  const previous = cached?.index || readPersistedIndex(dbPath, root, configHash, opts);
  const previousByPath = new Map((previous?.files || []).map((file) => [file.path, file]));
  const indexedFiles = [];
  let changedFileCount = 0;
  let reusedFileCount = 0;
  let verifiedFileCount = 0;
  let metadataRefreshedFileCount = 0;
  let fullVerificationSucceeded = true;
  const verifyAll = !previous || dirtyAll || contentVerificationDue(previous, opts);
  const graphSymbolRanges = await loadNativeJsGraphSymbolRanges(root, opts.graph || {});

  for (const file of files) {
    const old = previousByPath.get(file.path);
    const metadataMatches = old
      && Number(old.size) === file.size
      && Number(old.mtimeMs) === file.mtimeMs;
    const verifyContent = verifyAll || matchesDirtyPath(file.path, dirtyPaths);
    if (metadataMatches && !verifyContent) {
      indexedFiles.push(old);
      reusedFileCount += 1;
      continue;
    }

    const prepared = prepareSourceText(file);
    if (!prepared.ok) {
      if (prepared.reason === "binary") {
        scanned.coverage.skippedBinary += 1;
        if (old) changedFileCount += 1;
      } else {
        scanned.coverage.readFailures += 1;
        fullVerificationSucceeded = false;
        if (old) {
          indexedFiles.push(old);
          reusedFileCount += 1;
        }
      }
      continue;
    }

    if (verifyContent) verifiedFileCount += 1;
    if (old?.contentHash === prepared.contentHash) {
      indexedFiles.push({
        ...old,
        size: file.size,
        mtimeMs: file.mtimeMs,
        contentHash: prepared.contentHash,
      });
      reusedFileCount += 1;
      if (!metadataMatches) metadataRefreshedFileCount += 1;
      continue;
    }

    indexedFiles.push({
      path: file.path,
      size: file.size,
      mtimeMs: file.mtimeMs,
      contentHash: prepared.contentHash,
      chunks: makeChunks(file, prepared.text, opts, graphSymbolRanges),
    });
    changedFileCount += 1;
  }

  const currentPaths = new Set(files.map((file) => file.path));
  const deletedFileCount = (previous?.files || []).filter((file) => !currentPaths.has(file.path)).length;
  scanned.coverage = finalizeCoverage(scanned.coverage, indexedFiles.length);
  const contentVerifiedAtMs = (!previous || (verifyAll && fullVerificationSucceeded))
    ? Date.now()
    : Number(previous.contentVerifiedAtMs || 0);
  const index = {
    version: INDEX_VERSION,
    configHash,
    projectRoot: root,
    indexedAtMs: Date.now(),
    contentVerifiedAtMs,
    sourceSignature: signature,
    ignore: scanned.ignore,
    coverage: scanned.coverage,
    files: indexedFiles,
  };
  const metadataChanged = (
    JSON.stringify(previous?.coverage || null) !== JSON.stringify(scanned.coverage)
    || JSON.stringify(previous?.ignore || null) !== JSON.stringify(scanned.ignore)
  );
  const verificationChanged = Number(previous?.contentVerifiedAtMs || 0) !== contentVerifiedAtMs;
  if (
    changedFileCount
    || deletedFileCount
    || metadataRefreshedFileCount
    || !previous
    || metadataChanged
    || verificationChanged
  ) {
    persistIndex(dbPath, index);
  }
  memoryIndexCache.set(root, { signature, configHash, index, checkedAtMs: Date.now() });
  touchResidentProject(root);
  markWatcherSynced(watcher, handledEventCount);

  return {
    index,
    dbPath,
    fileCount: indexedFiles.length,
    chunkCount: indexedFiles.reduce((sum, file) => sum + (file.chunks?.length || 0), 0),
    changedFileCount,
    deletedFileCount,
    reusedFileCount,
    verifiedFileCount,
    metadataRefreshedFileCount,
    cached: false,
    watcher: publicWatcherStatus(watcher),
  };
}

export async function getNativeHybridIndexStatus(projectRoot, opts = {}) {
  const root = resolve(projectRoot);
  touchResidentProject(root);
  const configHash = indexConfigHash(opts);
  const synced = opts.sync === false
    ? null
    : await syncNativeHybridIndex(root, opts);
  const memoryCached = memoryIndexCache.get(root);
  const cached = memoryCached?.configHash === configHash ? memoryCached : null;
  const index = synced?.index
    || cached?.index
    || readPersistedIndex(indexPath(root, opts), root, configHash, opts);
  const watcher = watcherState.get(root) || ensureNativeHybridWatcher(root, opts);
  return {
    exists: Boolean(index),
    usable: Boolean(index?.files?.length),
    version: index?.version || null,
    configHash: index?.configHash || null,
    dbPath: indexPath(root, opts),
    indexedAtMs: index?.indexedAtMs || 0,
    contentVerifiedAtMs: index?.contentVerifiedAtMs || 0,
    ageMs: index?.indexedAtMs ? Math.max(0, Date.now() - index.indexedAtMs) : null,
    fileCount: index?.files?.length || 0,
    chunkCount: (index?.files || []).reduce((sum, file) => sum + (file.chunks?.length || 0), 0),
    structuredChunkCount: (index?.files || []).reduce(
      (sum, file) => sum + (file.chunks || []).filter((chunk) => chunk.kind && chunk.kind !== "window").length,
      0,
    ),
    ignore: index?.ignore || null,
    watcher: publicWatcherStatus(watcher),
    sync: synced ? {
      changedFileCount: synced.changedFileCount || 0,
      deletedFileCount: synced.deletedFileCount || 0,
      reusedFileCount: synced.reusedFileCount || 0,
      verifiedFileCount: synced.verifiedFileCount || 0,
      metadataRefreshedFileCount: synced.metadataRefreshedFileCount || 0,
      cached: Boolean(synced.cached),
    } : null,
  };
}

function expandedQuery(query, opts = {}) {
  const normalized = normalizeSearchQuery(query, {
    maxTerms: opts.exhaustive ? Number.POSITIVE_INFINITY : 64,
    clauseMaxTerms: opts.exhaustive ? Number.POSITIVE_INFINITY : 64,
    stopWords: STOP_WORDS,
  });
  const originalTerms = normalized.terms;
  const terms = new Set(originalTerms);
  // 中英桥接词只进扩展词集（提升打分召回），不计入 originalTerms，
  // coverage/matched 统计仍以用户原词为准，门槛语义不变。
  for (const bridged of bridgeQueryTerms(query, {
    maxTerms: opts.exhaustive ? Number.MAX_SAFE_INTEGER : 24,
  })) terms.add(bridged);
  const lower = String(query || "").toLowerCase();
  for (const [key, group] of conceptByTerm) {
    if (!terms.has(key) && !lower.includes(key)) continue;
    for (const related of group) terms.add(related);
  }
  const expanded = [...terms];
  const usedTerms = opts.exhaustive ? expanded : expanded.slice(0, 120);
  const omittedTerms = [...new Set([
    ...(normalized.diagnostics?.omittedTerms || []),
    ...expanded.filter((term) => !usedTerms.includes(term)),
  ])];
  return {
    originalTerms,
    terms: usedTerms,
    diagnostics: {
      ...normalized.diagnostics,
      usedTerms,
      omittedTerms,
      complete: omittedTerms.length === 0,
    },
  };
}

function ngrams(value) {
  const text = `^${String(value || "").toLowerCase()}$`;
  const result = new Set();
  const size = text.length < 6 ? 2 : 3;
  for (let i = 0; i <= text.length - size; i++) result.add(text.slice(i, i + size));
  return result;
}

function buildRetrievalState(index) {
  const cached = retrievalStateCache.get(index);
  if (cached) return cached;

  const rows = [];
  const vocabulary = new Set();
  for (const file of index.files || []) {
    for (let i = 0; i < (file.chunks || []).length; i++) {
      const row = {
        id: `${file.path}\0${i}`,
        path: file.path,
        ...file.chunks[i],
      };
      rows.push(row);
      for (const term of Object.keys(row.termCounts)) {
        if (term.length >= 4 && /^[a-z0-9_$]+$/i.test(term)) vocabulary.add(term);
      }
    }
  }
  const state = {
    rows,
    vocabulary: [...vocabulary].map((term) => ({ term, grams: ngrams(term) })),
  };
  retrievalStateCache.set(index, state);
  return state;
}

function bm25Scores(rows, queryTerms) {
  const documentCount = rows.length;
  const averageLength = rows.reduce((sum, row) => sum + row.length, 0) / Math.max(1, documentCount);
  const documentFrequency = new Map(queryTerms.map((term) => [term, 0]));
  for (const row of rows) {
    for (const term of queryTerms) {
      if (row.termCounts[term]) documentFrequency.set(term, documentFrequency.get(term) + 1);
    }
  }

  const scores = new Map();
  const k1 = 1.35;
  const b = 0.72;
  for (const row of rows) {
    let score = 0;
    for (const term of queryTerms) {
      const frequency = Number(row.termCounts[term] || 0);
      if (!frequency) continue;
      const df = documentFrequency.get(term) || 0;
      const idf = Math.log(1 + (documentCount - df + 0.5) / (df + 0.5));
      const denominator = frequency + k1 * (1 - b + b * row.length / Math.max(1, averageLength));
      score += idf * (frequency * (k1 + 1)) / denominator;
    }
    if (score > 0) scores.set(row.id, score);
  }
  return scores;
}

function subwordScores(state, queryTerms) {
  const candidates = queryTerms.filter((term) => term.length >= 4 && /^[a-z0-9_$]+$/i.test(term));
  const scores = new Map();
  if (!candidates.length) return scores;

  const matchesByTerm = new Map();
  for (let queryIndex = 0; queryIndex < candidates.length; queryIndex++) {
    const queryTerm = candidates[queryIndex];
    const queryGrams = ngrams(queryTerm);
    for (const candidate of state.vocabulary) {
      const documentTerm = candidate.term;
      let similarity = 0;
      if (documentTerm === queryTerm) {
        similarity = 1;
      } else if (documentTerm.includes(queryTerm) || queryTerm.includes(documentTerm)) {
        similarity = 0.82;
      } else if (Math.abs(documentTerm.length - queryTerm.length) <= Math.max(5, queryTerm.length)) {
        let overlap = 0;
        for (const gram of queryGrams) if (candidate.grams.has(gram)) overlap += 1;
        similarity = (2 * overlap) / Math.max(1, queryGrams.size + candidate.grams.size);
      }
      if (similarity < 0.42) continue;
      const matches = matchesByTerm.get(documentTerm) || [];
      matches.push([queryIndex, similarity]);
      matchesByTerm.set(documentTerm, matches);
    }
  }

  for (const row of state.rows) {
    const best = new Array(candidates.length).fill(0);
    for (const documentTerm of Object.keys(row.termCounts)) {
      for (const [queryIndex, similarity] of matchesByTerm.get(documentTerm) || []) {
        if (similarity > best[queryIndex]) best[queryIndex] = similarity;
      }
    }
    const total = best.reduce((sum, value) => sum + value, 0);
    if (total > 0) scores.set(row.id, total / candidates.length);
  }
  return scores;
}

function pathScores(rows, queryTerms) {
  const scores = new Map();
  for (const row of rows) {
    const path = row.path.toLowerCase();
    let score = 0;
    for (const term of queryTerms) {
      if (path.includes(term)) score += path.endsWith(`/${term}`) ? 1.4 : 1;
    }
    if (score > 0) scores.set(row.id, score);
  }
  return scores;
}

function rankedIds(scoreMap, limit = 160) {
  return [...scoreMap.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([id]) => id);
}

function reciprocalRankFusion(rows, scoreSets, originalTerms, rankingLimit = 160) {
  const rowById = new Map(rows.map((row) => [row.id, row]));
  const fused = new Map();
  const weights = { bm25: 1.15, subword: 0.85, path: 0.9 };
  const rankings = Object.entries(scoreSets).map(([name, scores]) => [name, rankedIds(scores, rankingLimit)]);

  for (const [name, ids] of rankings) {
    for (let rank = 0; rank < ids.length; rank++) {
      const id = ids[rank];
      const entry = fused.get(id) || { id, fusion: 0, sources: [] };
      entry.fusion += (weights[name] || 1) / (24 + rank + 1);
      entry.sources.push(name);
      fused.set(id, entry);
    }
  }

  const candidates = [...fused.values()]
    .map((entry) => ({ ...entry, row: rowById.get(entry.id) }))
    .filter((entry) => entry.row)
    .sort((a, b) => b.fusion - a.fusion || a.id.localeCompare(b.id));
  const topFusion = candidates[0]?.fusion || 1;
  const topBm25 = Math.max(0, ...scoreSets.bm25.values());
  const topSubword = Math.max(0, ...scoreSets.subword.values());

  return candidates.map((entry) => {
    const row = entry.row;
    const path = row.path.toLowerCase();
    const matchedTerms = originalTerms.filter((term) => row.termCounts[term] || path.includes(term));
    const matched = matchedTerms.length;
    const coverage = matched / Math.max(1, originalTerms.length);
    const bm25 = (scoreSets.bm25.get(entry.id) || 0) / Math.max(1, topBm25);
    const subword = (scoreSets.subword.get(entry.id) || 0) / Math.max(1, topSubword);
    const agreement = entry.sources.length >= 2 ? 0.08 : 0;
    const confidence = Math.min(
      0.96,
      0.18 + coverage * 0.46 + bm25 * 0.16 + subword * 0.1 + agreement,
    );
    return {
      ...row,
      score: confidence * (0.72 + 0.28 * entry.fusion / topFusion),
      matchedTermCount: matched,
      matchedTerms,
      queryCoverage: coverage,
      rankSources: entry.sources,
    };
  });
}

function readSnippet(projectRoot, file, maxLines = DEFAULT_HYBRID_MAX_SNIPPET_LINES) {
  try {
    const lines = readFileSync(resolve(projectRoot, file.path), "utf8").replace(/\r\n/g, "\n").split("\n");
    const start = Math.max(0, file.startLine - 1);
    return lines.slice(start, start + maxLines).join("\n").trimEnd().slice(0, 1200);
  } catch {
    return "";
  }
}

function collapseByFile(projectRoot, ranked, maxFiles, maxRanges = 3) {
  const byPath = new Map();
  const symbolLimit = maxRanges === Number.POSITIVE_INFINITY ? Number.POSITIVE_INFINITY : 8;
  for (const chunk of ranked) {
    let file = byPath.get(chunk.path);
    if (!file) {
      file = {
        path: chunk.path,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        ranges: [],
        score: chunk.score,
        matchedTermCount: chunk.matchedTermCount,
        matchedTerms: chunk.matchedTerms || [],
        queryCoverage: chunk.queryCoverage,
        rankSources: chunk.rankSources,
        symbols: [],
        evidence: { definitions: [] },
        reason: "Locus native hybrid (structured BM25+subword+RRF)",
      };
      byPath.set(chunk.path, file);
    }
    if (file.ranges.length < maxRanges) file.ranges.push([chunk.startLine, chunk.endLine]);
    file.matchedTerms = [...new Set([...file.matchedTerms, ...(chunk.matchedTerms || [])])];
    if (chunk.name && !file.symbols.includes(chunk.name) && file.symbols.length < symbolLimit) {
      file.symbols.push(chunk.name);
      file.evidence.definitions.push({
        name: chunk.name,
        kind: chunk.kind || "symbol",
        range: [chunk.startLine, chunk.endLine],
      });
    }
    if (byPath.size >= maxFiles && [...byPath.values()].every((entry) => entry.ranges.length >= 1)) break;
  }

  return [...byPath.values()]
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, maxFiles)
    .map((file) => ({ ...file, snippet: readSnippet(projectRoot, file) }));
}

export async function queryNativeHybridIndex(projectRoot, query, opts = {}) {
  const clauses = splitSearchQuery(query);
  if (!opts._singleClause && clauses.length > 1) {
    const results = [];
    for (const clause of clauses) {
      results.push(await queryNativeHybridIndex(projectRoot, clause, { ...opts, _singleClause: true }));
    }
    const fused = fuseClauseResults(query, clauses, results, { maxResults: opts.maxFiles });
    fused.index = results[0]?.index || null;
    return fused;
  }
  const root = resolve(projectRoot);
  const indexOpts = { ...opts };
  delete indexOpts.maxFiles;
  delete indexOpts.exhaustive;
  delete indexOpts.includeAllRanges;
  delete indexOpts._singleClause;
  if (opts.indexMaxFiles != null) indexOpts.maxFiles = opts.indexMaxFiles;
  const synced = await syncNativeHybridIndex(root, indexOpts);
  const state = buildRetrievalState(synced.index);
  const rows = state.rows;
  const { originalTerms, terms, diagnostics: queryDiagnostics } = expandedQuery(query, opts);
  if (!rows.length || !terms.length) {
    return { usable: false, reason: "no searchable local content", files: [], query };
  }

  const scoreSets = {
    bm25: bm25Scores(rows, terms),
    subword: subwordScores(state, terms),
    path: pathScores(rows, terms),
  };
  const ranked = reciprocalRankFusion(
    rows,
    scoreSets,
    originalTerms,
    opts.exhaustive ? Number.POSITIVE_INFINITY : 160,
  );
  const maxFiles = Math.max(1, opts.maxFiles || DEFAULT_HYBRID_TOP_K);
  const candidateFileLimit = opts.exhaustive ? Number.POSITIVE_INFINITY : Math.max(24, maxFiles * 4);
  const candidatePool = collapseByFile(
    root,
    ranked,
    candidateFileLimit,
    opts.exhaustive ? Number.POSITIVE_INFINITY : 3,
  );
  const confidence = candidatePool[0]?.score >= 0.7 ? "high" : candidatePool[0]?.score >= 0.4 ? "medium" : "low";
  const files = rankAndSelectFiles(candidatePool, {
    query,
    maxResults: maxFiles,
    confidence,
    exhaustive: opts.exhaustive,
  });
  return {
    usable: files.length > 0,
    reason: files.length ? "ok" : "no relevant native candidates",
    files,
    query,
    queryDiagnostics,
    totalCandidates: candidatePool.length,
    index: {
      fileCount: synced.index.files.length,
      chunkCount: rows.length,
      changedFileCount: synced.changedFileCount || 0,
      deletedFileCount: synced.deletedFileCount || 0,
      reusedFileCount: synced.reusedFileCount || 0,
      indexedAtMs: synced.index.indexedAtMs || 0,
      ignore: synced.index.ignore || null,
      coverage: synced.index.coverage || null,
      watcher: synced.watcher || null,
    },
  };
}

function toCodebasePath(path) {
  return `/codebase/${normalizeRelPath(path)}`;
}

export function formatHybridHints(result, opts = {}) {
  const maxChars = opts.maxChars ?? DEFAULT_HYBRID_HINT_BUDGET;
  const maxFiles = opts.maxFiles ?? DEFAULT_HYBRID_TOP_K;
  const lines = [
    "Locus Local Index Hints (native BM25+subword+RRF; verify with restricted_exec before answering):",
    "Prefer these candidates for first-round rg/readfile and confirm ranges before final ANSWER.",
    "",
    "Candidates:",
  ];

  for (const file of (result.files || []).slice(0, maxFiles)) {
    const role = file.role ? ` | role=${file.role}` : "";
    const symbols = file.symbols?.length ? ` | sym=${file.symbols.slice(0, 4).join(",")}` : "";
    lines.push(`- ${toCodebasePath(file.path)}:${file.startLine}-${file.endLine} | s=${file.score.toFixed(3)}${role}${symbols}`);
    for (const snippetLine of String(file.snippet || "").split("\n")) {
      if (snippetLine) lines.push(`    ${snippetLine}`);
    }
  }

  const accepted = [];
  let length = 0;
  for (const line of lines) {
    const next = length + line.length + 1;
    if (next > maxChars) {
      accepted.push("[truncated: local index hints exceeded budget]");
      break;
    }
    accepted.push(line);
    length = next;
  }
  return accepted.join("\n");
}

// Acceptance floor for injecting hints into the remote prompt. The confidence
// formula bottoms out around 0.18 for any single-term match, so `score > 0`
// would accept junk and anchor the model's first round on it. Mirrors the
// graph path's "medium" minConfidence gate.
const HYBRID_HINT_MIN_SCORE = (() => {
  const parsed = Number.parseFloat(process.env.LOCUS_HYBRID_HINT_MIN_SCORE ?? "");
  if (Number.isFinite(parsed)) return Math.min(0.95, Math.max(0, parsed));
  return 0.4;
})();

export function evaluateHybridContext(raw, projectRoot, opts = {}) {
  const root = resolve(projectRoot);
  const files = (raw?.files || [])
    .filter((file) => {
      const fullPath = resolve(root, file.path || "");
      const rel = relative(root, fullPath);
      return rel !== ".." && !rel.startsWith("../") && !rel.startsWith("..\\") && existsSync(fullPath);
    })
    .slice(0, opts.exhaustive ? Number.POSITIVE_INFINITY : (opts.maxFiles || DEFAULT_HYBRID_TOP_K));
  const top = files[0] || null;
  const result = { ...raw, files };
  const hintBlock = files.length ? formatHybridHints(result, opts) : "";
  const strongEnough = Boolean(
    top &&
    (top.score >= HYBRID_HINT_MIN_SCORE ||
      ((top.queryCoverage ?? 0) >= 0.3 && (top.matchedTermCount ?? 0) >= 2)),
  );
  return {
    accepted: Boolean(raw?.usable && top && strongEnough && hintBlock),
    result,
    hintBlock,
    reason: !files.length
      ? raw?.reason || "no candidate files"
      : strongEnough
        ? "accepted"
        : `below hint floor (top=${top ? top.score.toFixed(3) : "n/a"} < ${HYBRID_HINT_MIN_SCORE})`,
  };
}

export function createNativeHybridProvider(opts = {}) {
  return {
    async buildContext(input) {
      return queryNativeHybridIndex(input.projectRoot, input.query, {
        ...opts,
        maxFiles: input.maxFiles ?? opts.maxFiles ?? DEFAULT_HYBRID_TOP_K,
        exhaustive: input.exhaustive ?? opts.exhaustive ?? false,
        includeAllRanges: input.includeAllRanges ?? opts.includeAllRanges ?? false,
      });
    },
  };
}

export async function buildHybridHintBlock({
  provider,
  query,
  projectRoot,
  maxFiles = DEFAULT_HYBRID_TOP_K,
  maxChars = DEFAULT_HYBRID_HINT_BUDGET,
  exhaustive = false,
  includeAllRanges = false,
}) {
  if (!provider || typeof provider.buildContext !== "function") {
    return {
      hintBlock: "",
      result: null,
      meta: { enabled: false, used: false, status: "disabled", reason: "no native hybrid provider" },
    };
  }

  try {
    const raw = await provider.buildContext({
      query,
      projectRoot,
      maxFiles,
      maxChars,
      exhaustive,
      includeAllRanges,
    });
    const evaluated = evaluateHybridContext(raw, projectRoot, {
      maxFiles,
      maxChars,
      exhaustive,
      includeAllRanges,
    });
    const top = evaluated.result.files[0] || null;
    if (!evaluated.accepted) {
      return {
        hintBlock: "",
        result: evaluated.result,
        meta: {
          enabled: true,
          used: false,
          status: "rejected",
          reason: evaluated.reason,
          candidates: evaluated.result.files.length,
        },
      };
    }
    return {
      hintBlock: evaluated.hintBlock,
      result: evaluated.result,
      meta: {
        enabled: true,
        used: true,
        status: "ok",
        reason: "accepted",
        candidates: evaluated.result.files.length,
        topPath: top.path,
        topScore: top.score,
        queryCoverage: top.queryCoverage,
        matchedTermCount: top.matchedTermCount,
        queryTermCount: expandedQuery(query).originalTerms.length,
        index: evaluated.result.index || null,
        queryDiagnostics: evaluated.result.queryDiagnostics || null,
        totalCandidates: evaluated.result.totalCandidates || evaluated.result.files.length,
      },
    };
  } catch (error) {
    return {
      hintBlock: "",
      result: null,
      meta: {
        enabled: true,
        used: false,
        status: "error",
        reason: error?.message || "native hybrid retrieval failed",
        code: error?.code || "LOCUS_NATIVE_HYBRID_ERROR",
      },
    };
  }
}
