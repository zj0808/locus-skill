import { existsSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { classifyFileRole } from "../retrieval/result-policy.mjs";

export const DEFAULT_GRAPH_HINT_BUDGET = 6000;
export const DEFAULT_GRAPH_MAX_FILES = 12;

const CONFIDENCE_RANK = Object.freeze({
  low: 1,
  medium: 2,
  high: 3,
});

const EDGE_KINDS = new Set([
  "calls",
  "imports",
  "routes_to",
  "tests",
  "implements",
  "exports",
  "reexports",
]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeConfidence(value) {
  return Object.hasOwn(CONFIDENCE_RANK, value) ? value : "low";
}

function isInsideRoot(projectRoot, candidatePath) {
  const rel = relative(projectRoot, candidatePath);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function normalizeRelPath(projectRoot, inputPath) {
  if (typeof inputPath !== "string" || !inputPath.trim()) return null;
  const cleaned = inputPath.replace(/^\/codebase[\\/]/, "").replace(/^\/codebase$/, "");
  const fullPath = resolve(projectRoot, cleaned);
  if (!isInsideRoot(projectRoot, fullPath)) return null;
  return relative(projectRoot, fullPath).replace(/\\/g, "/");
}

function normalizeScore(value) {
  const score = Number(value);
  if (!Number.isFinite(score)) return 0;
  return Math.max(0, Math.min(1, score));
}

function normalizeRanges(value, limit = 8) {
  if (!Array.isArray(value)) return [];
  const ranges = [];
  for (const range of value) {
    if (!Array.isArray(range) || range.length !== 2) continue;
    const start = Number.parseInt(range[0], 10);
    const end = Number.parseInt(range[1], 10);
    if (!Number.isInteger(start) || !Number.isInteger(end)) continue;
    if (start < 1 || end < start) continue;
    ranges.push([start, end]);
    if (ranges.length >= limit) break;
  }
  return ranges;
}

function normalizeStringList(value, limit = 12) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => typeof item === "string" && item.trim())
    .map((item) => item.trim())
    .slice(0, limit);
}

function normalizeEvidenceEdges(value, limit = 8) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((edge) => isObject(edge) && typeof edge.from === "string" && typeof edge.to === "string")
    .map((edge) => ({ from: edge.from, to: edge.to, kind: String(edge.kind || "related") }))
    .slice(0, limit);
}

function normalizeEvidence(value, opts = {}) {
  const source = isObject(value) ? value : {};
  const limit = opts.includeAllRanges || opts.exhaustive ? Number.POSITIVE_INFINITY : 8;
  const definitions = Array.isArray(source.definitions)
    ? source.definitions.filter(isObject).map((definition) => ({
      name: String(definition.name || ""),
      kind: String(definition.kind || "symbol"),
      range: normalizeRanges([definition.range], limit)[0] || null,
      exported: Boolean(definition.exported),
    })).filter((definition) => definition.name).slice(0, limit)
    : [];
  return {
    definitions,
    references: normalizeEvidenceEdges(source.references, limit),
    imports: normalizeEvidenceEdges(source.imports, limit),
    exports: normalizeEvidenceEdges(source.exports, limit),
    tests: normalizeEvidenceEdges(source.tests, limit),
    callChain: normalizeEvidenceEdges(source.callChain, limit),
  };
}

function fileExists(projectRoot, relPath) {
  const fullPath = resolve(projectRoot, relPath);
  try {
    return existsSync(fullPath) && statSync(fullPath).isFile();
  } catch {
    return false;
  }
}

function toCodebasePath(relPath) {
  return `/codebase/${relPath.replace(/\\/g, "/")}`;
}

function isEntrypointPath(path) {
  return /(^|\/)(server|index|main|app|route)\.[cm]?[jt]sx?$/.test(path);
}

function isHelperPath(path) {
  return /(^|\/)(helpers?|utils?|lib|shared|config)(\/|$)/.test(path)
    || /(^|\/)(extract|parse|format|normalize|resolve|load|read|write|config|credential|key|client|provider)[\w-]*\.[cm]?[jt]sx?$/.test(path)
    || /(?:helper|util|config|credential|key|client|provider)[\w-]*\.[cm]?[jt]sx?$/.test(path);
}

function endpointPath(endpoint) {
  const text = String(endpoint || "");
  return text
    .replace(/^\/codebase\//, "")
    .replace(/#.*$/, "");
}

function edgeTouchesPath(edge, path) {
  return endpointPath(edge.from) === path || endpointPath(edge.to) === path;
}

function inferGraphHintRole(file, result, rank) {
  const role = file.role || classifyFileRole(file.path);
  if (role === "entrypoint") return "entrypoints";
  if (role === "implementation") return "implementations";
  if (["test", "documentation", "config", "export"].includes(role)) return "helpers";
  if (isEntrypointPath(file.path)) return "entrypoints";
  if (isHelperPath(file.path) && rank > 0) return "helpers";

  const edges = result.edges || [];
  const importedByEntrypoint = edges.some((edge) => (
    endpointPath(edge.to) === file.path
    && isEntrypointPath(endpointPath(edge.from))
    && edge.kind === "imports"
  ));
  if (importedByEntrypoint || rank <= 2) return "implementations";

  const onlySupportRelation = edges.some((edge) => edgeTouchesPath(edge, file.path));
  return onlySupportRelation ? "helpers" : "implementations";
}

function compactRanges(ranges) {
  return ranges.slice(0, 4).map(([start, end]) => `${start}-${end}`).join(",");
}

function compactReason(reason) {
  if (!reason) return "";
  const quoted = [...reason.matchAll(/"([^"]+)"/g)]
    .map((match) => match[1])
    .filter(Boolean);
  const unique = [...new Set(quoted)];
  if (unique.length) return unique.slice(0, 5).join(",");

  const first = reason.split(";").map((part) => part.trim()).filter(Boolean)[0] || reason.trim();
  return first.length > 90 ? `${first.slice(0, 87)}...` : first;
}

function formatHintFile(file) {
  const parts = [`- ${toCodebasePath(file.path)}`, `s=${file.score.toFixed(2)}`];
  const ranges = compactRanges(file.ranges);
  const reason = compactReason(file.reason);
  if (ranges) parts.push(`r=${ranges}`);
  if (file.symbols.length) parts.push(`sym=${file.symbols.slice(0, 4).join(",")}`);
  if (file.role) parts.push(`role=${file.role}`);
  if (reason) parts.push(`why=${reason}`);
  return parts.join(" | ");
}

function groupGraphHintFiles(result, maxFiles) {
  const groups = {
    entrypoints: [],
    implementations: [],
    helpers: [],
  };
  for (const [rank, file] of result.files.slice(0, maxFiles).entries()) {
    groups[inferGraphHintRole(file, result, rank)].push(file);
  }
  return groups;
}

function compactEdge(edge) {
  const from = endpointPath(edge.from);
  const to = endpointPath(edge.to);
  if (!from || !to || from === to) return "";
  return `- ${edge.kind}: ${from} -> ${to}`;
}

function compactEvidence(file) {
  const evidence = file.evidence || {};
  const definitions = (evidence.definitions || []).slice(0, 3).map((item) => {
    const range = item.range ? `@${item.range[0]}-${item.range[1]}` : "";
    return `${item.name}${range}`;
  });
  const parts = [`- ${file.path}`];
  if (definitions.length) parts.push(`defines=${definitions.join(",")}`);
  for (const [label, key] of [["refs", "references"], ["imports", "imports"], ["exports", "exports"], ["tests", "tests"]]) {
    const count = evidence[key]?.length || 0;
    if (count) parts.push(`${label}=${count}`);
  }
  const chain = evidence.callChain?.[0];
  if (chain) parts.push(`chain=${endpointPath(chain.from)}->${endpointPath(chain.to)}`);
  return parts.length > 1 ? parts.join(" | ") : "";
}

function relationRoleRank(path) {
  if (isEntrypointPath(path)) return 0;
  if (isHelperPath(path)) return 2;
  return 1;
}

function compareRelations(a, b) {
  const fromDelta = relationRoleRank(endpointPath(a.from)) - relationRoleRank(endpointPath(b.from));
  if (fromDelta) return fromDelta;
  const toDelta = relationRoleRank(endpointPath(a.to)) - relationRoleRank(endpointPath(b.to));
  if (toDelta) return toDelta;
  return `${a.kind}:${a.from}:${a.to}`.localeCompare(`${b.kind}:${b.from}:${b.to}`);
}

/**
 * Normalize provider output into the compact graph context schema Locus MCP
 * can safely reason about. Invalid paths and malformed edges are dropped.
 *
 * @param {Object} raw
 * @param {string} projectRoot
 * @returns {Object}
 */
export function normalizeGraphContextResult(raw, projectRoot, opts = {}) {
  const root = resolve(projectRoot);
  const source = isObject(raw) ? raw : {};
  const files = [];
  const itemLimit = opts.includeAllRanges || opts.exhaustive ? Number.POSITIVE_INFINITY : 8;
  const edgeLimit = opts.exhaustive ? Number.POSITIVE_INFINITY : 40;

  if (Array.isArray(source.files)) {
    for (const file of source.files) {
      if (!isObject(file)) continue;
      const relPath = normalizeRelPath(root, file.path);
      if (!relPath) continue;
      files.push({
        path: relPath,
        score: normalizeScore(file.score),
        reason: typeof file.reason === "string" ? file.reason.trim() : "",
        ranges: normalizeRanges(file.ranges, itemLimit),
        symbols: normalizeStringList(file.symbols, itemLimit),
        role: typeof file.role === "string" ? file.role : classifyFileRole(relPath),
        ownerScore: normalizeScore(file.ownerScore),
        structuralSignals: isObject(file.structuralSignals) ? file.structuralSignals : {},
        evidence: normalizeEvidence(file.evidence, opts),
      });
    }
  }

  const edges = [];
  if (Array.isArray(source.edges)) {
    for (const edge of source.edges) {
      if (!isObject(edge)) continue;
      const kind = typeof edge.kind === "string" ? edge.kind : "";
      if (!EDGE_KINDS.has(kind)) continue;
      const from = typeof edge.from === "string" ? edge.from.trim() : "";
      const to = typeof edge.to === "string" ? edge.to.trim() : "";
      if (!from || !to) continue;
      edges.push({ from, to, kind });
      if (edges.length >= edgeLimit) break;
    }
  }

  files.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));

  return {
    usable: source.usable === true,
    confidence: normalizeConfidence(source.confidence),
    queryCoverage: normalizeScore(source.queryCoverage),
    matchedTermCount: Math.max(0, Number.parseInt(source.matchedTermCount, 10) || 0),
    queryTermCount: Math.max(0, Number.parseInt(source.queryTermCount, 10) || 0),
    topRawScore: Math.max(0, Number(source.topRawScore) || 0),
    scoreMargin: Math.max(0, Number(source.scoreMargin) || 0),
    files,
    edges,
    notes: normalizeStringList(source.notes, opts.exhaustive ? Number.POSITIVE_INFINITY : 20),
    queryDiagnostics: source.queryDiagnostics || null,
    totalCandidates: Math.max(files.length, Number(source.totalCandidates) || 0),
    indexCoverage: source.indexCoverage || null,
  };
}

/**
 * Render graph candidates as a small hint block for the search model. The
 * model must still verify every hint with restricted_exec before final output.
 *
 * @param {Object} result
 * @param {Object} [opts]
 * @param {number} [opts.maxChars]
 * @param {number} [opts.maxFiles]
 * @returns {string}
 */
export function formatGraphHints(result, opts = {}) {
  const maxChars = opts.maxChars ?? DEFAULT_GRAPH_HINT_BUDGET;
  const maxFiles = opts.maxFiles ?? DEFAULT_GRAPH_MAX_FILES;
  const groups = groupGraphHintFiles(result, maxFiles);
  const lines = [
    "Local Graph Hints (do not answer directly; verify with restricted_exec first):",
    "Read order: Entrypoints -> Implementations -> Helpers. For API/tool/server queries, verify entrypoints too.",
    "",
  ];

  for (const [title, files] of [
    ["Entrypoints", groups.entrypoints],
    ["Implementations", groups.implementations],
    ["Helpers", groups.helpers],
  ]) {
    if (!files.length) continue;
    lines.push(`${title}:`);
    for (const file of files) {
      lines.push(formatHintFile(file));
    }
    lines.push("");
  }

  if (result.edges.length) {
    const edgeLines = [];
    const seen = new Set();
    for (const edge of result.edges.slice(0, 20).sort(compareRelations)) {
      const line = compactEdge(edge);
      if (!line || seen.has(line)) continue;
      seen.add(line);
      edgeLines.push(line);
      if (edgeLines.length >= 8) break;
    }
    if (edgeLines.length) {
      lines.push("Relations:");
      lines.push(...edgeLines);
      lines.push("");
    }
  }

  const evidenceLines = result.files
    .slice(0, maxFiles)
    .map(compactEvidence)
    .filter(Boolean)
    .slice(0, 8);
  if (evidenceLines.length) {
    lines.push("Symbol evidence:");
    lines.push(...evidenceLines);
    lines.push("");
  }

  if (result.notes.length) {
    lines.push(`Notes: ${result.notes.join("; ")}`);
  }

  const accepted = [];
  let length = 0;
  for (const line of lines) {
    const nextLength = length + line.length + 1;
    if (nextLength > maxChars) {
      accepted.push("[truncated: local graph hints exceeded budget]");
      break;
    }
    accepted.push(line);
    length = nextLength;
  }

  return accepted.join("\n");
}

/**
 * Apply quality gates before graph hints can influence search.
 *
 * @param {Object} raw
 * @param {string} projectRoot
 * @param {Object} [opts]
 * @param {"low"|"medium"|"high"} [opts.minConfidence]
 * @param {number} [opts.maxChars]
 * @param {number} [opts.maxFiles]
 * @returns {{ accepted: boolean, result: Object, hintBlock: string, reason: string, rejected: string[] }}
 */
export function evaluateGraphContext(raw, projectRoot, opts = {}) {
  const minConfidence = opts.minConfidence ?? "medium";
  const maxFiles = opts.maxFiles ?? DEFAULT_GRAPH_MAX_FILES;
  const result = normalizeGraphContextResult(raw, projectRoot, opts);
  const rejected = [];

  if (!result.usable) rejected.push("provider returned unusable context");
  if (CONFIDENCE_RANK[result.confidence] < CONFIDENCE_RANK[minConfidence]) {
    rejected.push(`confidence ${result.confidence} is below ${minConfidence}`);
  }

  const existingFiles = result.files.filter((file) => fileExists(projectRoot, file.path));
  if (!existingFiles.length) rejected.push("no candidate files exist on disk");
  if (!existingFiles.some((file) => file.reason || file.symbols.length || file.ranges.length)) {
    rejected.push("no candidate has a symbol, range, or reason");
  }

  const limited = {
    ...result,
    files: opts.exhaustive ? existingFiles : existingFiles.slice(0, maxFiles),
  };
  const hintBlock = formatGraphHints(limited, opts);
  if (!hintBlock.trim()) rejected.push("formatted hint block is empty");

  if (rejected.length) {
    return {
      accepted: false,
      result: limited,
      hintBlock: "",
      reason: rejected[0],
      rejected,
    };
  }

  return {
    accepted: true,
    result: limited,
    hintBlock,
    reason: "accepted",
    rejected,
  };
}

/**
 * Build a graph hint block through the provider boundary. The server wires the
 * bundled native indexer here, while tests may supply fixture providers.
 *
 * @param {Object} opts
 * @param {Object|null} opts.provider
 * @param {string} opts.query
 * @param {string} opts.projectRoot
 * @param {Object} [opts.repoMap]
 * @param {number} [opts.maxFiles]
 * @param {number} [opts.maxChars]
 * @returns {Promise<{ hintBlock: string, meta: Object }>}
 */
export async function buildGraphHintBlock({
  provider,
  query,
  projectRoot,
  repoMap = null,
  maxFiles = DEFAULT_GRAPH_MAX_FILES,
  maxChars = DEFAULT_GRAPH_HINT_BUDGET,
  exhaustive = false,
  includeAllRanges = false,
}) {
  if (!provider || typeof provider.buildContext !== "function") {
    return {
      hintBlock: "",
      result: null,
      meta: { enabled: false, used: false, status: "disabled", reason: "no graph provider" },
    };
  }

  try {
    const raw = await provider.buildContext({
      query,
      projectRoot,
      repoMap,
      maxFiles,
      maxChars,
      exhaustive,
      includeAllRanges,
    });
    const evaluated = evaluateGraphContext(raw, projectRoot, {
      maxFiles,
      maxChars,
      exhaustive,
      includeAllRanges,
    });
    const fileCount = evaluated.result.files.length;
    return {
      hintBlock: evaluated.hintBlock,
      result: evaluated.result,
      meta: {
        enabled: true,
        used: evaluated.accepted,
        status: evaluated.accepted ? "accepted" : "rejected",
        reason: evaluated.reason,
        confidence: evaluated.result.confidence,
        queryCoverage: evaluated.result.queryCoverage,
        matchedTermCount: evaluated.result.matchedTermCount,
        queryTermCount: evaluated.result.queryTermCount,
        topRawScore: evaluated.result.topRawScore,
        scoreMargin: evaluated.result.scoreMargin,
        queryDiagnostics: evaluated.result.queryDiagnostics,
        totalCandidates: evaluated.result.totalCandidates,
        indexCoverage: evaluated.result.indexCoverage,
        files: fileCount,
        topPath: evaluated.result.files[0]?.path || null,
        topScore: typeof evaluated.result.files[0]?.score === "number"
          ? evaluated.result.files[0].score
          : null,
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
        reason: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

export function createNoopGraphProvider(reason = "local graph disabled") {
  return {
    async status() {
      return { usable: false, reason };
    },
    async buildContext() {
      return {
        usable: false,
        confidence: "low",
        files: [],
        edges: [],
        notes: [reason],
      };
    },
  };
}
