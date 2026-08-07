/**
 * Local vector radar (ACE-style): chunks are the graph index's symbol ranges
 * (JS/TS/Go), embedded with the static potion-code model and persisted under
 * .locus-mcp/vector/. Queries embed in <1ms and score all chunks by dot
 * product — semantic recall for English/identifier-morphology queries that
 * pure lexical scoring misses ("token refresh" → refreshAccessToken).
 *
 * 中文跨语言对齐弱是该模型的已知局限——中文语义查询依旧由 CJK 守卫送远程验证。
 * 模型文件缺失或 LOCUS_VECTOR=off 时整个雷达静默停用，不影响其他路径。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadNativeJsGraphSymbolRanges } from "../graph/native-js-provider.mjs";
import { loadEmbedderCached, resolveModelDir } from "./vector-embedder.mjs";
import { bridgeQuery } from "../search/query-bridge.mjs";
import { createProjectIgnoreMatcher } from "./project-ignore.mjs";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const VECTOR_DIR = join(".locus-mcp", "vector");
// v3: long symbols are split into complete line/character-bounded chunks.
// v2 embedded only the first 60 lines / 4,000 characters of each symbol while
// recording the full symbol range in metadata.
const INDEX_VERSION = "vector-v3";
const MAX_CHUNK_LINES = 60;
const MAX_CHUNK_CHARS = 4000;
const MAX_CHUNKS_PER_FILE = 80;
const MAX_FILES = 2000;

const CONFIG_MAX_FILES = 150;
const CONFIG_MAX_BYTES = 100 * 1024;
const CONFIG_WALK_DEPTH = 3;
const CONFIG_EXT_RE = /\.(ya?ml|toml)$/i;
const CONFIG_NAME_RE = /^(dockerfile|caddyfile)/i;

export function isConfigFileName(name) {
  const base = name.toLowerCase();
  return (
    CONFIG_EXT_RE.test(base) ||
    CONFIG_NAME_RE.test(base) ||
    base === "package.json" ||
    (base.startsWith("tsconfig") && base.endsWith(".json")) ||
    base.endsWith(".env.example") ||
    base === ".env.example"
  );
}

export function discoverConfigFiles(root) {
  const matcher = createProjectIgnoreMatcher(root);
  const files = [];
  let discoveredFiles = 0;
  let readFailures = 0;
  const walk = (dir, depth) => {
    if (depth > CONFIG_WALK_DEPTH) return;
    let dirents;
    try {
      dirents = readdirSync(join(root, dir), { withFileTypes: true });
    } catch {
      readFailures += 1;
      return;
    }
    for (const dirent of dirents) {
      const rel = dir ? `${dir}/${dirent.name}` : dirent.name;
      if (dirent.isDirectory()) {
        if (!matcher.isIgnored(rel, true)) walk(rel, depth + 1);
        continue;
      }
      if (!isConfigFileName(dirent.name) || matcher.isIgnored(rel, false)) continue;
      discoveredFiles += 1;
      if (files.length < CONFIG_MAX_FILES) files.push(rel);
    }
  };
  walk("", 0);
  const omittedFiles = Math.max(0, discoveredFiles - files.length);
  Object.defineProperty(files, "coverage", {
    value: {
      complete: omittedFiles === 0 && readFailures === 0,
      discoveredFiles,
      omittedFiles,
      readFailures,
    },
    enumerable: false,
  });
  return files;
}

/** 配置文件按顶格行（新顶层键/段）切块，块长 3-40 行。 */
export function configChunks(relPath, lines, opts = {}) {
  const chunks = [];
  const maxChunks = Math.max(1, Number.parseInt(opts.maxChunks ?? 20, 10) || 20);
  let discoveredChunks = 0;
  let start = 0;
  for (let i = 1; i <= lines.length; i++) {
    const boundary =
      i === lines.length ||
      (/^[^\s#]/.test(lines[i] || "") && i - start >= 3) ||
      i - start >= 40;
    if (!boundary) continue;
    const slice = lines.slice(start, i);
    if (slice.join("").trim()) {
      discoveredChunks += 1;
      const name = (slice.find((line) => line.trim()) || relPath).trim().slice(0, 60);
      if (chunks.length < maxChunks) {
        chunks.push({ name, lineStart: start + 1, lineEnd: i });
      }
    }
    start = i;
  }
  const omittedChunks = Math.max(0, discoveredChunks - chunks.length);
  Object.defineProperty(chunks, "coverage", {
    value: {
      complete: omittedChunks === 0,
      discoveredChunks,
      omittedChunks,
    },
    enumerable: false,
  });
  return chunks;
}

const VECTOR_ENABLED = !["0", "false", "no", "off"].includes(
  String(process.env.LOCUS_VECTOR ?? "on").trim().toLowerCase(),
);

// 接受门槛：sanity 实测语义相关 0.5+，无关 ~0；0.42 以下不注入 hint。
const HINT_MIN_SCORE = (() => {
  const parsed = Number.parseFloat(process.env.LOCUS_VECTOR_HINT_MIN_SCORE ?? "");
  if (Number.isFinite(parsed)) return Math.min(0.95, Math.max(0, parsed));
  return 0.42;
})();

const _memCache = new Map(); // projectRoot -> { sig, chunks, vectors, dim }

function fileKeyOf(absPath) {
  try {
    const st = statSync(absPath);
    return `${st.size}:${st.mtimeMs}`;
  } catch {
    return null;
  }
}

function pathWords(relPath) {
  return String(relPath).replace(/[\\/._-]+/g, " ");
}

export function splitVectorUnit(unit, lines, opts = {}) {
  const maxLines = Math.max(1, Number.parseInt(opts.maxLines ?? MAX_CHUNK_LINES, 10) || MAX_CHUNK_LINES);
  const maxChars = Math.max(1, Number.parseInt(opts.maxChars ?? MAX_CHUNK_CHARS, 10) || MAX_CHUNK_CHARS);
  const firstLine = Math.max(1, Number(unit.lineStart) || 1);
  const lastLine = Math.min(lines.length, Math.max(firstLine, Number(unit.lineEnd) || firstLine));
  const chunks = [];
  let parts = [];
  let charCount = 0;
  let chunkStart = firstLine;
  let chunkEnd = firstLine;

  const flush = () => {
    if (!parts.length) return;
    chunks.push({
      ...unit,
      lineStart: chunkStart,
      lineEnd: chunkEnd,
      text: parts.join("\n"),
    });
    parts = [];
    charCount = 0;
  };

  for (let lineNumber = firstLine; lineNumber <= lastLine; lineNumber++) {
    const line = String(lines[lineNumber - 1] ?? "");
    const segments = line.length
      ? Array.from({ length: Math.ceil(line.length / maxChars) }, (_, index) => (
        line.slice(index * maxChars, (index + 1) * maxChars)
      ))
      : [""];

    for (const segment of segments) {
      const separatorChars = parts.length ? 1 : 0;
      const exceedsLineBudget = parts.length && lineNumber - chunkStart + 1 > maxLines;
      const exceedsCharBudget = parts.length && charCount + separatorChars + segment.length > maxChars;
      if (exceedsLineBudget || exceedsCharBudget) flush();
      if (!parts.length) chunkStart = lineNumber;
      parts.push(segment);
      chunkEnd = lineNumber;
      charCount += (parts.length > 1 ? 1 : 0) + segment.length;
      if (charCount >= maxChars) flush();
    }
  }
  flush();
  return chunks;
}

function chunkText(relPath, unit) {
  return `${pathWords(relPath)} ${unit.name} ${unit.text}`;
}

/**
 * Build or incrementally refresh the vector index. Returns null when the
 * radar is unavailable (no model / no graph symbols / disabled).
 */
export async function ensureVectorIndex(projectRoot) {
  if (!VECTOR_ENABLED) return null;
  const root = resolve(projectRoot);
  const modelDir = resolveModelDir(root, PACKAGE_ROOT);
  const embedder = loadEmbedderCached(modelDir);
  if (!embedder) return null;

  const symbolRanges = await loadNativeJsGraphSymbolRanges(root);
  if (!symbolRanges.size) return null;

  const metaPath = join(root, VECTOR_DIR, "index.json");
  const binPath = join(root, VECTOR_DIR, "vectors.bin");

  // 内存缓存：文件签名拼接一致则直接复用
  const allEntries = [...symbolRanges.entries()];
  const entries = allEntries.slice(0, MAX_FILES);
  const discoveredConfigFiles = discoverConfigFiles(root);
  const configFiles = discoveredConfigFiles.filter((rel) => !symbolRanges.has(rel));
  const coverageIssues = [];
  if (allEntries.length > MAX_FILES) {
    coverageIssues.push(`file_limit:${allEntries.length - MAX_FILES}`);
  }
  if (discoveredConfigFiles.coverage?.complete === false) {
    if (discoveredConfigFiles.coverage.omittedFiles) {
      coverageIssues.push(`config_file_limit:${discoveredConfigFiles.coverage.omittedFiles}`);
    }
    if (discoveredConfigFiles.coverage.readFailures) {
      coverageIssues.push(`config_discovery_read_failure:${discoveredConfigFiles.coverage.readFailures}`);
    }
  }
  const keyedCandidates = [
    ...entries.map(([relPath, symbols]) => ({
      relPath,
      kind: "symbols",
      symbols,
    })),
    ...configFiles.map((relPath) => ({
      relPath,
      kind: "config",
      symbols: null,
    })),
  ];
  const keyed = [];
  let fileStatFailures = 0;
  let oversizedConfigFiles = 0;
  for (const item of keyedCandidates) {
    const key = fileKeyOf(join(root, item.relPath));
    if (!key) {
      fileStatFailures += 1;
      continue;
    }
    if (item.kind === "config" && Number(key.split(":")[0]) > CONFIG_MAX_BYTES) {
      oversizedConfigFiles += 1;
    }
    keyed.push({ ...item, key });
  }
  if (fileStatFailures) coverageIssues.push(`file_stat_failure:${fileStatFailures}`);
  if (oversizedConfigFiles) coverageIssues.push(`config_too_large:${oversizedConfigFiles}`);
  const sig = `${INDEX_VERSION}:${embedder.dim}:` + keyed.map((f) => `${f.relPath}=${f.key}`).join("|");
  const memHit = _memCache.get(root);
  if (memHit && memHit.sig === sig) {
    const issues = [...new Set([...coverageIssues, ...(memHit.coverage?.issues || [])])];
    return { ...memHit, embedder, coverage: { complete: issues.length === 0, issues } };
  }

  // 磁盘缓存：逐文件复用未变更的行
  let old = null;
  try {
    const meta = JSON.parse(readFileSync(metaPath, "utf8"));
    if (meta.version === INDEX_VERSION && meta.dim === embedder.dim && existsSync(binPath)) {
      const buffer = readFileSync(binPath);
      old = { meta, vectors: new Float32Array(buffer.buffer, buffer.byteOffset, buffer.length / 4) };
    }
  } catch { /* rebuild */ }

  const chunks = [];
  const rows = [];
  let fileReadFailures = 0;
  let embeddingFailures = 0;
  let omittedConfigChunks = 0;
  let omittedSourceChunks = 0;
  const oldHasPartialBuild = (old?.meta?.coverage?.issues || []).some((issue) => (
    String(issue).startsWith("embedding_failure:")
    || String(issue).startsWith("config_chunk_limit:")
    || String(issue).startsWith("chunk_limit:")
  ));
  for (const { relPath, kind, symbols, key } of keyed) {
    const oldFile = old?.meta?.files?.[relPath];
    if (!oldHasPartialBuild && oldFile && oldFile.key === key) {
      for (const chunk of oldFile.chunks) {
        const row = old.vectors.subarray(chunk.row * embedder.dim, (chunk.row + 1) * embedder.dim);
        chunks.push({ path: relPath, name: chunk.n, lineStart: chunk.ls, lineEnd: chunk.le });
        rows.push(Float32Array.from(row));
      }
      continue;
    }
    // key 形如 "size:mtime"——配置文件超限直接跳过，不读盘。
    if (kind === "config" && Number(key.split(":")[0]) > CONFIG_MAX_BYTES) continue;
    let lines;
    try {
      lines = readFileSync(join(root, relPath), "utf8").split(/\r?\n/);
    } catch {
      fileReadFailures += 1;
      continue;
    }
    const sourceUnits = kind === "config" ? configChunks(relPath, lines) : symbols;
    omittedConfigChunks += sourceUnits.coverage?.omittedChunks || 0;
    const expandedUnits = sourceUnits.flatMap((unit) => splitVectorUnit(unit, lines));
    const units = expandedUnits.slice(0, MAX_CHUNKS_PER_FILE);
    omittedSourceChunks += Math.max(0, expandedUnits.length - units.length);
    for (const unit of units) {
      let vec = null;
      try {
        vec = embedder.embed(chunkText(relPath, unit));
      } catch {
        // Thrown and empty embeddings both leave an unindexed source unit.
      }
      if (!vec) {
        embeddingFailures += 1;
        continue;
      }
      chunks.push({ path: relPath, name: unit.name, lineStart: unit.lineStart, lineEnd: unit.lineEnd });
      rows.push(vec);
    }
  }
  if (fileReadFailures) coverageIssues.push(`file_read_failure:${fileReadFailures}`);
  if (embeddingFailures) coverageIssues.push(`embedding_failure:${embeddingFailures}`);
  if (omittedConfigChunks) coverageIssues.push(`config_chunk_limit:${omittedConfigChunks}`);
  if (omittedSourceChunks) coverageIssues.push(`chunk_limit:${omittedSourceChunks}`);
  const uniqueCoverageIssues = [...new Set(coverageIssues)];
  const coverage = { complete: uniqueCoverageIssues.length === 0, issues: uniqueCoverageIssues };

  const dim = embedder.dim;
  const vectors = new Float32Array(chunks.length * dim);
  for (let i = 0; i < rows.length; i++) vectors.set(rows[i], i * dim);

  // 持久化（尽力而为；失败不影响本次查询）
  try {
    mkdirSync(dirname(metaPath), { recursive: true });
    const files = {};
    let row = 0;
    for (const { relPath, key } of keyed) {
      const fileChunks = [];
      for (let i = row; i < chunks.length && chunks[i].path === relPath; i++) {
        fileChunks.push({ n: chunks[i].name, ls: chunks[i].lineStart, le: chunks[i].lineEnd, row: i });
      }
      if (fileChunks.length) {
        files[relPath] = { key, chunks: fileChunks };
        row = fileChunks.at(-1).row + 1;
      }
    }
    writeFileSync(metaPath, JSON.stringify({ version: INDEX_VERSION, dim, files, coverage }));
    writeFileSync(binPath, Buffer.from(vectors.buffer, 0, vectors.byteLength));
  } catch { /* best effort */ }

  const built = { sig, chunks, vectors, dim, coverage };
  _memCache.set(root, built);
  if (_memCache.size > 8) _memCache.delete(_memCache.keys().next().value);
  return { ...built, embedder };
}

export async function queryVectorIndex(projectRoot, query, opts = {}) {
  const maxFiles = opts.maxFiles || 12;
  const index = await ensureVectorIndex(projectRoot);
  if (!index) {
    return { usable: false, reason: "vector radar unavailable", files: [] };
  }
  // 中文查询嵌入前先桥接：模型中英对齐弱，英文扩展词才能激活语义召回。
  const { augmented } = bridgeQuery(query);
  let queryVec = null;
  try {
    queryVec = index.embedder.embed(augmented);
  } catch {
    // Reported below as incomplete query coverage.
  }
  if (!queryVec) {
    return {
      usable: false,
      reason: "query embedding failed or produced no tokens",
      files: [],
      queryDiagnostics: { complete: false, omittedChunks: 1 },
      indexCoverage: index.coverage || { complete: true, issues: [] },
    };
  }

  const { chunks, vectors, dim } = index;
  const scored = [];
  for (let i = 0; i < chunks.length; i++) {
    let dot = 0;
    const base = i * dim;
    for (let d = 0; d < dim; d++) dot += vectors[base + d] * queryVec[d];
    if (dot >= 0.25) scored.push({ i, score: dot });
  }
  scored.sort((a, b) => b.score - a.score);

  const byPath = new Map();
  const scoredCandidates = opts.exhaustive ? scored : scored.slice(0, 32);
  const rangeLimit = opts.includeAllRanges || opts.exhaustive ? Number.POSITIVE_INFINITY : 3;
  for (const { i, score } of scoredCandidates) {
    const chunk = chunks[i];
    let entry = byPath.get(chunk.path);
    if (!entry) {
      entry = { path: chunk.path, score, ranges: [], symbols: [], hits: 0 };
      byPath.set(chunk.path, entry);
    }
    entry.hits += 1;
    if (entry.ranges.length < rangeLimit) entry.ranges.push([chunk.lineStart, chunk.lineEnd]);
    if ((opts.exhaustive || entry.symbols.length < 6) && !entry.symbols.includes(chunk.name)) entry.symbols.push(chunk.name);
  }
  const files = [...byPath.values()]
    .map((entry) => ({ ...entry, score: Math.min(1, entry.score + 0.04 * Math.min(3, entry.hits - 1)) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.exhaustive ? Number.POSITIVE_INFINITY : maxFiles);

  return {
    usable: files.length > 0,
    files,
    chunkCount: chunks.length,
    queryDiagnostics: {
      complete: opts.exhaustive || scored.length <= 32,
      omittedChunks: Math.max(0, scored.length - scoredCandidates.length),
    },
    indexCoverage: index.coverage || { complete: true, issues: [] },
  };
}

/**
 * Hint-block wrapper（与 graph/hybrid 同构）：低于门槛的命中不注入，
 * 不锚定模型的第一轮。
 */
export async function buildVectorHintBlock({
  query,
  projectRoot,
  maxFiles = 8,
  exhaustive = false,
  includeAllRanges = false,
}) {
  const disabledMeta = { enabled: VECTOR_ENABLED, used: false, status: "unavailable" };
  try {
    const result = await queryVectorIndex(projectRoot, query, { maxFiles, exhaustive, includeAllRanges });
    const top = result.files[0] || null;
    if (!result.usable || !top || top.score < HINT_MIN_SCORE) {
      return {
        hintBlock: "",
        result,
        meta: {
          ...disabledMeta,
          status: result.usable ? "rejected" : "unavailable",
          reason: result.reason || (top ? `below hint floor (top=${top.score.toFixed(3)} < ${HINT_MIN_SCORE})` : "no candidates"),
          topScore: top?.score ?? null,
          queryDiagnostics: result.queryDiagnostics || null,
          indexCoverage: result.indexCoverage || null,
        },
      };
    }
    const lines = result.files.slice(0, maxFiles).map((file) => {
      const range = file.ranges[0] ? ` (L${file.ranges[0][0]}-${file.ranges[0][1]})` : "";
      const symbols = file.symbols.length ? ` [${file.symbols.slice(0, 4).join(", ")}]` : "";
      return `- ${file.path}${range} score=${file.score.toFixed(2)}${symbols}`;
    });
    return {
      hintBlock: `# Local vector index candidates (semantic)\n${lines.join("\n")}\n`,
      result,
      meta: {
        enabled: true,
        used: true,
        status: "ok",
        candidates: result.files.length,
        topPath: top.path,
        topScore: top.score,
        queryDiagnostics: result.queryDiagnostics || null,
        indexCoverage: result.indexCoverage || null,
      },
    };
  } catch (error) {
    return {
      hintBlock: "",
      result: { usable: false, files: [] },
      meta: { ...disabledMeta, status: "error", reason: String(error?.message || error).slice(0, 120) },
    };
  }
}
