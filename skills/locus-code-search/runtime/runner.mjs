import { existsSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

import { searchWithContent, resolveLocalFirstMode } from "./src/core.mjs";
import {
  createNativeJsGraphProvider,
  getNativeJsGraphStatus,
  syncNativeJsGraphIndex,
} from "./src/graph/native-js-provider.mjs";
import {
  createNativeHybridProvider,
  getNativeHybridIndexStatus,
} from "./src/retrieval/native-hybrid-provider.mjs";
import { getBackgroundSyncStatus } from "./src/retrieval/background-sync.mjs";
import {
  planSearchRoute,
  formatRouteFooter,
  resolveRouteModeFromEnv,
} from "./src/route/policy.mjs";

function readIntEnv(name, fallback, min, max) {
  const parsed = Number.parseInt(process.env[name] || "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function readBoolEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || !raw.trim()) return fallback;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

const MAX_COMMANDS = readIntEnv("LOCUS_MAX_COMMANDS", 8, 1, 20);
const MAX_TURNS = readIntEnv("LOCUS_MAX_TURNS", 3, 1, 5);
const TIMEOUT_MS = readIntEnv("LOCUS_TIMEOUT_MS", 30000, 1000, 300000);
const GRAPH_HINTS_MODE = (process.env.LOCUS_GRAPH_HINTS || "auto").trim().toLowerCase();
const GRAPH_AUTO_BUILD = readBoolEnv("LOCUS_GRAPH_AUTO_BUILD", true);
const ROUTE_MODE = resolveRouteModeFromEnv(process.env.LOCUS_ROUTE);
const LOCAL_FIRST_MODE = resolveLocalFirstMode(process.env.LOCUS_LOCAL_FIRST);

const BUILTIN_DEFAULT_EXCLUDES = [
  "node_modules", ".git", "dist", "build", "out", "coverage", ".next", ".nuxt",
  ".turbo", ".cache", "__pycache__", ".venv", "venv", "target", "vendor",
  "*.min.*", ".locus-mcp", ".codegraph", ".codex", ".ace-tool", ".idea",
  ".vscode", "*.exe", "*.log", "gin.log",
];
const EXTRA_DEFAULT_EXCLUDES = (process.env.LOCUS_DEFAULT_EXCLUDES || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const DEFAULT_EXCLUDES = [...new Set([...BUILTIN_DEFAULT_EXCLUDES, ...EXTRA_DEFAULT_EXCLUDES])];
const MONOREPO_ROOT_MARKERS = ["pnpm-workspace.yaml", "lerna.json", "nx.json", "turbo.json", "rush.json"];
const PACKAGE_DIR_CANDIDATES = ["packages", "apps", "services", "libs", "modules", "frontend", "backend"];
const GRAPH_INDEXED_EXT_RE = /\.(?:js|jsx|mjs|cjs|ts|tsx|mts|cts|go)\b/i;
const NON_GRAPH_EXT_RE = /\.(?:py|rs|java|kt|rb|php|c|cc|cpp|h|hpp|cs|swift|scala|sql|proto)\b/i;

const hybridProvider = createNativeHybridProvider();
const nativeGraphProvider = createNativeJsGraphProvider({ autoBuild: GRAPH_AUTO_BUILD, rebuild: false });

function assertAuthenticated() {
  if (process.env.ACE_AUTH_VALIDATED !== "1" || !process.env.LOCUS_TOKEN || !process.env.LOCUS_BASE_URL) {
    throw new Error("ACE authentication gate was not completed.");
  }
}

function graphDir(projectPath) {
  return join(projectPath, ".locus-mcp", "graph");
}

function looksLikeGraphProject(projectPath) {
  return ["package.json", "tsconfig.json", "jsconfig.json", "go.mod"]
    .some((name) => existsSync(join(projectPath, name)));
}

function queryTargetsNonGraphLanguage(query) {
  const text = String(query || "");
  return NON_GRAPH_EXT_RE.test(text) && !GRAPH_INDEXED_EXT_RE.test(text);
}

function shouldUseGraphHints(projectPath) {
  if (["0", "false", "no", "off"].includes(GRAPH_HINTS_MODE)) return false;
  if (["1", "true", "yes", "on"].includes(GRAPH_HINTS_MODE)) {
    return looksLikeGraphProject(projectPath) || existsSync(graphDir(projectPath));
  }
  if (existsSync(graphDir(projectPath))) return true;
  return GRAPH_AUTO_BUILD && looksLikeGraphProject(projectPath);
}

function listChildDirs(directory) {
  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules")
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

function detectMonorepoLayout(projectPath) {
  const markers = MONOREPO_ROOT_MARKERS.filter((name) => existsSync(join(projectPath, name)));
  const packages = [];
  for (const directoryName of PACKAGE_DIR_CANDIDATES) {
    const absolute = join(projectPath, directoryName);
    if (!existsSync(absolute)) continue;
    try {
      if (!statSync(absolute).isDirectory()) continue;
    } catch {
      continue;
    }
    const children = listChildDirs(absolute);
    if (children.length && ["packages", "apps", "services", "libs", "modules"].includes(directoryName)) {
      for (const child of children.slice(0, 24)) packages.push(`${directoryName}/${child}`);
    } else if (existsSync(join(absolute, "package.json")) || existsSync(join(absolute, "go.mod"))) {
      packages.push(directoryName);
    }
  }
  if (!packages.length && markers.length) {
    for (const name of listChildDirs(projectPath).slice(0, 20)) {
      if (existsSync(join(projectPath, name, "package.json"))) packages.push(name);
    }
  }
  return { isMonorepo: markers.length > 0 || packages.length >= 2, packages: [...new Set(packages)], markers };
}

function mergeExcludePaths(userExcludes = []) {
  const merged = [];
  const seen = new Set();
  for (const item of [...DEFAULT_EXCLUDES, ...userExcludes]) {
    const key = String(item || "").trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(key);
  }
  return merged;
}

function resolveProjectPath(projectPathArg) {
  const raw = String(projectPathArg || "").trim();
  if (!raw) return resolve(process.cwd());
  return isAbsolute(raw) ? resolve(raw) : resolve(process.cwd(), raw);
}

function resolvePathFilter(projectRoot, pathFilterArg) {
  const raw = String(pathFilterArg || "").trim();
  if (!raw) return { searchRoot: projectRoot, pathFilter: null };
  const cleaned = raw.replace(/^[/\\]?codebase[/\\]?/, "").replace(/\\/g, "/").replace(/^\/+/, "");
  const candidate = isAbsolute(raw) ? resolve(raw) : resolve(projectRoot, cleaned);
  if (!existsSync(candidate)) throw new Error(`path_filter does not exist: ${raw}`);
  const targetDir = statSync(candidate).isDirectory() ? candidate : resolve(candidate, "..");
  const rel = relative(projectRoot, targetDir);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`path_filter must stay inside project_path: ${raw}`);
  }
  return { searchRoot: targetDir, pathFilter: rel.replace(/\\/g, "/") || "." };
}

function adaptTreeDepth(requestedDepth, mono) {
  if (mono.isMonorepo && mono.packages.length >= 4 && requestedDepth >= 3) return 2;
  return requestedDepth;
}

function requireDirectory(projectPath) {
  try {
    if (statSync(projectPath).isDirectory()) return;
  } catch {
    // Handled below.
  }
  throw new Error(`project path does not exist: ${projectPath}`);
}

export async function runSearch(options) {
  assertAuthenticated();
  const projectPath = resolveProjectPath(options.projectPath);
  requireDirectory(projectPath);
  const { searchRoot, pathFilter } = resolvePathFilter(projectPath, options.pathFilter);
  const mono = detectMonorepoLayout(projectPath);
  const effectiveTreeDepth = adaptTreeDepth(options.treeDepth, mono);
  const graphCapable = shouldUseGraphHints(searchRoot) && !queryTargetsNonGraphLanguage(options.query);
  const route = planSearchRoute({
    query: options.query,
    requestedMaxTurns: options.maxTurns,
    defaultMaxTurns: MAX_TURNS,
    graphAvailable: graphCapable,
    hybridAvailable: true,
    routeMode: ROUTE_MODE,
    isMonorepoRoot: mono.isMonorepo,
  });

  const result = await searchWithContent({
    query: options.query,
    projectRoot: searchRoot,
    maxTurns: route.maxTurns,
    maxCommands: MAX_COMMANDS,
    maxResults: options.maxResults,
    treeDepth: effectiveTreeDepth,
    timeoutMs: TIMEOUT_MS,
    excludePaths: mergeExcludePaths(options.excludePaths),
    graphProvider: route.useGraph ? nativeGraphProvider : null,
    graphHintsEnabled: route.useGraph,
    hybridProvider: route.useHybrid ? hybridProvider : null,
    hybridHintsEnabled: route.useHybrid,
    localFirstMode: LOCAL_FIRST_MODE,
    routeKind: route.kind,
    resultMode: options.resultMode,
    cursor: options.cursor || null,
    pageSize: options.pageSize,
    includeAllRanges: options.includeAllRanges,
    exhaustive: options.exhaustive,
  });

  let footer = formatRouteFooter(route);
  if (pathFilter) {
    footer += `\n\n[scope] path_filter=${pathFilter} (search root = ${searchRoot}).`;
  }
  if (mono.isMonorepo && mono.packages.length) {
    const sample = mono.packages.slice(0, 12).join(", ");
    const more = mono.packages.length > 12 ? ` (+${mono.packages.length - 12} more)` : "";
    footer += `\n\n[scope] Monorepo detected. Prefer a package project path, for example: ${sample}${more}.`;
  }
  if (effectiveTreeDepth !== options.treeDepth) {
    footer += `\n[scope] tree_depth auto-adjusted ${options.treeDepth} -> ${effectiveTreeDepth} for monorepo root.`;
  }
  footer += `\n[scope] graph_hints=${route.useGraph ? "on" : "off"}.`;
  if (route.useHybrid) footer += "\n[scope] hybrid_index=on (native).";
  if (LOCAL_FIRST_MODE !== "off") footer += `\n[scope] local_first=${LOCAL_FIRST_MODE}.`;
  if (route.turnsAdjusted) {
    footer += `\n[scope] max_turns adapted ${options.maxTurns} -> ${route.maxTurns} by route.`;
  }
  return result + footer;
}

export async function runIndexStatus(options) {
  assertAuthenticated();
  const projectPath = resolveProjectPath(options.projectPath);
  requireDirectory(projectPath);
  const graphCapable = shouldUseGraphHints(projectPath);
  if (options.refresh && graphCapable) await syncNativeJsGraphIndex(projectPath);
  const [graph, hybrid] = await Promise.all([
    graphCapable
      ? getNativeJsGraphStatus(projectPath)
      : Promise.resolve({ exists: false, usable: false, stale: false, reason: "not a JS/TS/Go project" }),
    getNativeHybridIndexStatus(projectPath, { sync: options.refresh }),
  ]);
  return {
    projectPath,
    refreshed: options.refresh,
    graph,
    hybrid,
    backgroundSync: getBackgroundSyncStatus(projectPath),
  };
}
