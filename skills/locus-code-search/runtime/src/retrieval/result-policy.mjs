import { basename, extname } from "node:path";

export const FILE_ROLES = Object.freeze({
  IMPLEMENTATION: "implementation",
  TEST: "test",
  DOCUMENTATION: "documentation",
  CONFIG: "config",
  ENTRYPOINT: "entrypoint",
  EXPORT: "export",
});

const ROLE_MULTIPLIERS = Object.freeze({
  implementation: 1.14,
  entrypoint: 1.12,
  config: 0.82,
  export: 0.72,
  test: 0.66,
  documentation: 0.58,
});

const SUPPORT_ROLES = new Set([
  FILE_ROLES.TEST,
  FILE_ROLES.DOCUMENTATION,
  FILE_ROLES.CONFIG,
  FILE_ROLES.EXPORT,
]);

function normalizePath(path) {
  return String(path || "").replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase();
}

function clampScore(value) {
  const score = Number(value);
  return Number.isFinite(score) ? Math.max(0, Math.min(1, score)) : 0;
}

function textTerms(value) {
  return new Set(
    String(value || "")
      .toLowerCase()
      .match(/[a-z_$][\w$-]{1,}|\p{Script=Han}{2,}/gu) || [],
  );
}

function pathIntentAdjustment(path, intendedRole) {
  const normalized = normalizePath(path);
  const name = basename(normalized);
  const extension = extname(name);
  const stem = extension ? name.slice(0, -extension.length) : name;
  let delta = 0;

  if (intendedRole === FILE_ROLES.ENTRYPOINT) {
    if (["main", "server", "app", "cli", "route", "worker"].includes(stem)) delta += 0.20;
    if (/(^|\/)(src|app|cmd|bin)\//.test(normalized) && ["main", "server", "app", "cli"].includes(stem)) {
      delta += 0.10;
    }
    if (/(^|\/)(scripts?|benchmarks?|benches?|fixtures?)(\/|$)/.test(normalized)) delta -= 0.24;
    if (/(^|[._-])(compare|smoke|bench|fixture|sample|mock)([._-]|$)/.test(name)) delta -= 0.18;
    if (/(^|\/)(tests?|__tests__|docs?)(\/|$)/.test(normalized)) delta -= 0.10;
  }

  if (intendedRole === FILE_ROLES.IMPLEMENTATION) {
    if (/(^|\/)(scripts?|benchmarks?|benches?)(\/|$)/.test(normalized)) delta -= 0.08;
  }

  return delta;
}

export function classifyFileRole(path) {
  const normalized = normalizePath(path);
  const name = basename(normalized);
  const extension = extname(name);
  const stem = extension ? name.slice(0, -extension.length) : name;

  if (
    /(^|\/)(tests?|__tests__|specs?|fixtures?|testdata|mocks?)(\/|$)/.test(normalized)
    || /(?:^|[._-])(test|spec|fixture|mock)(?:[._-]|$)/.test(name)
  ) return FILE_ROLES.TEST;

  if (
    /(^|\/)(docs?|documentation|examples?)(\/|$)/.test(normalized)
    || /\.(md|mdx|rst|adoc|txt)$/.test(name)
    || /^(readme|changelog|contributing|license)(\.|$)/.test(name)
  ) return FILE_ROLES.DOCUMENTATION;

  if (
    /(^|\/)(config|configs|migrations?|deploy|\.github)(\/|$)/.test(normalized)
    || /(^|[._-])(config|rc)([._-]|$)/.test(name)
    || /^(\.env(?:\..+)?|\.npmrc|\.yarnrc(?:\.yml)?|\.editorconfig|\.prettierrc(?:\..+)?|\.eslintrc(?:\..+)?)$/.test(name)
    || /\.(json|ya?ml|toml|ini|env|properties|lock)$/.test(name)
    || /^(dockerfile|makefile|gemfile|procfile|tsconfig|vite\.config|webpack\.config)/.test(name)
  ) return FILE_ROLES.CONFIG;

  if (
    /(^|\/)(index|mod|exports?|public-api)\.[cm]?[jt]sx?$/.test(normalized)
    || /(^|\/)(__init__|mod)\.(py|rs)$/.test(normalized)
  ) return FILE_ROLES.EXPORT;

  if (
    /(^|\/)(main|server|app|cli|route|worker)\.[cm]?[jt]sx?$/.test(normalized)
    || /(^|\/)(main|server|app|cli|worker)\.(py|go|rs|java|kt|cs|php|rb)$/.test(normalized)
    || ["main", "server", "app", "cli", "route", "worker"].includes(stem)
  ) return FILE_ROLES.ENTRYPOINT;

  return FILE_ROLES.IMPLEMENTATION;
}

export function inferQueryRoleIntents(query) {
  const text = String(query || "").toLowerCase();
  const weighted = [];
  const add = (role, score) => {
    const existing = weighted.find((item) => item.role === role);
    if (existing) existing.score = Math.max(existing.score, score);
    else weighted.push({ role, score });
  };
  if (/\b(test|tests|testing|spec|fixture|mock|coverage)\b|测试|用例|覆盖率|样本/.test(text)) {
    add(FILE_ROLES.TEST, 1);
  }
  if (/\b(docs?|documentation|readme|guide|example)\b|文档|说明|示例/.test(text)) {
    add(FILE_ROLES.DOCUMENTATION, 1);
  }
  if (/\b(config|configuration|setting|env|deploy|docker)\b|配置|环境变量|部署/.test(text)) {
    add(FILE_ROLES.CONFIG, 1);
  }
  if (/\b(entrypoint|bootstrap|startup|server|servers|route|endpoint|cli|main|mcp)\b|入口|启动|路由|端点|注册工具/.test(text)) {
    add(FILE_ROLES.ENTRYPOINT, 1);
  }
  if (/\b(export|exports|barrel|public api|re-export)\b|导出|暴露接口/.test(text)) {
    add(FILE_ROLES.EXPORT, 1);
  }
  if (/\b(implement|implementation|owner|source|logic|function|class|method)\b|实现|源码|逻辑|函数|方法|类/.test(text)) {
    add(FILE_ROLES.IMPLEMENTATION, 1);
  }
  if (!weighted.length) add(FILE_ROLES.IMPLEMENTATION, 1);
  else if (!weighted.some((item) => item.role === FILE_ROLES.IMPLEMENTATION)) add(FILE_ROLES.IMPLEMENTATION, 0.55);
  return weighted.sort((a, b) => b.score - a.score || a.role.localeCompare(b.role));
}

export function inferQueryRoleIntent(query) {
  return inferQueryRoleIntents(query)[0]?.role || FILE_ROLES.IMPLEMENTATION;
}

function edgePath(endpoint) {
  return String(endpoint || "")
    .replace(/^\/codebase\//, "")
    .replace(/#.*$/, "")
    .replace(/\\/g, "/")
    .toLowerCase();
}

function structuralSignals(path, edges = []) {
  const key = normalizePath(path);
  let incoming = 0;
  let outgoing = 0;
  let tests = 0;
  let exports = 0;
  for (const edge of edges || []) {
    const from = edgePath(edge.from);
    const to = edgePath(edge.to);
    if (to === key) incoming += 1;
    if (from === key) outgoing += 1;
    if (edge.kind === "tests" && (from === key || to === key)) tests += 1;
    if (["exports", "reexports"].includes(edge.kind) && (from === key || to === key)) exports += 1;
  }
  return { incoming, outgoing, tests, exports };
}

function ownerScore(file, query, role, intendedRole, edges) {
  const queryTerms = textTerms(query);
  const path = normalizePath(file.path);
  const pathTerms = textTerms(path.replace(/[/.\\_-]+/g, " "));
  const symbols = Array.isArray(file.symbols) ? file.symbols : [];
  const definitions = Array.isArray(file.evidence?.definitions) ? file.evidence.definitions : [];
  let matchedPathTerms = 0;
  for (const term of queryTerms) if (pathTerms.has(term)) matchedPathTerms += 1;

  let matchedSymbols = 0;
  for (const symbol of [...symbols, ...definitions.map((item) => item.name)]) {
    const lower = String(symbol || "").toLowerCase();
    if ([...queryTerms].some((term) => term.length >= 3 && lower.includes(term))) matchedSymbols += 1;
  }

  const structure = structuralSignals(path, edges);
  let score = 0;
  score += Math.min(0.12, matchedPathTerms * 0.035);
  score += Math.min(0.18, matchedSymbols * 0.06);
  score += Math.min(0.12, structure.incoming * 0.025);
  score += Math.min(0.06, structure.outgoing * 0.012);
  if (definitions.length) score += 0.08;
  if (role === FILE_ROLES.IMPLEMENTATION && intendedRole === FILE_ROLES.IMPLEMENTATION) score += 0.08;
  if (role === FILE_ROLES.ENTRYPOINT && intendedRole === FILE_ROLES.ENTRYPOINT) score += 0.14;
  if (/^(src|app|lib|internal|pkg|packages)\//.test(path)) score += 0.04;
  score += pathIntentAdjustment(path, intendedRole);
  return { score, ...structure, matchedPathTerms, matchedSymbols };
}

export function rerankFileCandidates(files, opts = {}) {
  const query = opts.query || "";
  const intendedRoles = opts.intendedRoles || inferQueryRoleIntents(query);
  const intendedRole = opts.intendedRole || intendedRoles[0]?.role || FILE_ROLES.IMPLEMENTATION;
  const edges = opts.edges || [];
  const originalTopScore = Math.max(0, ...(files || []).map((file) => clampScore(file.score)));
  const ranked = (files || []).map((file, originalRank) => {
    const role = file.role || classifyFileRole(file.path);
    const owner = ownerScore(file, query, role, intendedRole, edges);
    const roleIntent = intendedRoles.find((item) => item.role === role);
    const roleMatchesIntent = Boolean(roleIntent);
    const roleMultiplier = roleMatchesIntent
      ? role === FILE_ROLES.IMPLEMENTATION
        ? ROLE_MULTIPLIERS.implementation
        : role === FILE_ROLES.ENTRYPOINT
          ? 1.52
          : 1 + 0.28 * (roleIntent?.score ?? 1)
      : intendedRole === FILE_ROLES.ENTRYPOINT && role === FILE_ROLES.IMPLEMENTATION
        ? 0.78
        : intendedRole !== FILE_ROLES.IMPLEMENTATION && role === FILE_ROLES.IMPLEMENTATION
          ? 0.88
          : ROLE_MULTIPLIERS[role] || 1;
    const baseScore = clampScore(file.score);
    const score = Math.max(0, baseScore * roleMultiplier + owner.score);
    return {
      ...file,
      role,
      ownerScore: Number(owner.score.toFixed(4)),
      structuralSignals: {
        incoming: owner.incoming,
        outgoing: owner.outgoing,
        tests: owner.tests,
        exports: owner.exports,
      },
      originalRank: originalRank + 1,
      score,
    };
  });

  ranked.sort((a, b) => (
    b.score - a.score
    || b.ownerScore - a.ownerScore
    || a.originalRank - b.originalRank
    || a.path.localeCompare(b.path)
  ));
  const adjustedTopScore = ranked[0]?.score || 1;
  return ranked.map((file) => ({
    ...file,
    score: clampScore((file.score / adjustedTopScore) * originalTopScore),
  }));
}

export function dynamicTopK(files, opts = {}) {
  const requested = Math.max(1, Number.parseInt(opts.maxResults ?? 12, 10) || 12);
  if (opts.exhaustive || opts.resultMode === "complete") {
    return [...(files || [])]
      .sort((a, b) => clampScore(b.score) - clampScore(a.score) || a.path.localeCompare(b.path));
  }
  const minK = Math.min(requested, Math.max(1, Number.parseInt(opts.minK ?? 3, 10) || 3));
  const maxK = Math.min(requested, Math.max(minK, Number.parseInt(opts.maxK ?? 12, 10) || 12));
  const sorted = [...(files || [])].sort((a, b) => clampScore(b.score) - clampScore(a.score));
  const confidence = String(opts.confidence || "medium");
  // Ambiguous searches keep a wider evidence set. Strong searches can stop at
  // the first clear score cliff without paying the token cost of a long tail.
  const effectiveMinK = confidence === "low" ? Math.min(maxK, Math.max(minK, 5)) : minK;
  if (sorted.length <= effectiveMinK) return sorted.slice(0, maxK);

  const top = clampScore(sorted[0].score);
  const ratio = confidence === "high" ? 0.55 : confidence === "low" ? 0.35 : 0.50;
  const floor = confidence === "high" ? 0.24 : confidence === "low" ? 0.10 : 0.18;
  const cliffRatio = confidence === "high" ? 0.64 : confidence === "low" ? 0.45 : 0.58;
  const threshold = Math.max(floor, top * ratio);
  let cutoff = effectiveMinK;

  for (let index = effectiveMinK; index < Math.min(sorted.length, maxK); index++) {
    const current = clampScore(sorted[index].score);
    const previous = clampScore(sorted[index - 1].score);
    const cliff = previous > 0 && current / previous < cliffRatio;
    if (current < threshold || cliff) break;
    cutoff = index + 1;
  }
  return sorted.slice(0, cutoff);
}

export function applyRelatedResultQuota(files, opts = {}) {
  const intendedRole = opts.intendedRole || inferQueryRoleIntent(opts.query || "");
  const maxResults = Math.max(1, Number.parseInt(opts.maxResults ?? files.length, 10) || files.length);
  if (intendedRole !== FILE_ROLES.IMPLEMENTATION) return [...(files || [])].slice(0, maxResults);

  const relatedRatio = Math.max(0, Math.min(0.5, Number(opts.relatedRatio ?? 0.2)));
  const relatedLimit = Math.floor(maxResults * relatedRatio);
  const primary = [];
  const related = [];
  for (const file of files || []) {
    if (SUPPORT_ROLES.has(file.role || classifyFileRole(file.path))) related.push(file);
    else primary.push(file);
  }

  const selected = [...primary.slice(0, maxResults)];
  const available = Math.max(0, maxResults - selected.length);
  // The quota prevents support files from displacing available owners. When
  // the candidate pool has no owner to fill a slot, retain support evidence so
  // dynamic TopK does not collapse below its selected response size.
  const minimumSupportToFill = Math.max(0, Math.min(maxResults, files.length) - selected.length);
  const supportAllowance = Math.max(relatedLimit, minimumSupportToFill);
  selected.push(...related.slice(0, Math.min(supportAllowance, available)));
  return selected.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
}

function mergeFileCandidates(files) {
  const byPath = new Map();
  for (const file of files || []) {
    const key = normalizePath(file.path);
    if (!key) continue;
    const previous = byPath.get(key);
    if (!previous) {
      byPath.set(key, { ...file });
      continue;
    }

    const preferred = clampScore(file.score) > clampScore(previous.score) ? file : previous;
    const secondary = preferred === file ? previous : file;
    const merged = { ...secondary, ...preferred, score: Math.max(clampScore(file.score), clampScore(previous.score)) };
    for (const field of ["symbols", "ranges", "rankSources"]) {
      const values = [...(previous[field] || []), ...(file[field] || [])];
      if (values.length) {
        const seen = new Set();
        merged[field] = values.filter((value) => {
          const valueKey = typeof value === "string" ? value : JSON.stringify(value);
          if (seen.has(valueKey)) return false;
          seen.add(valueKey);
          return true;
        });
      }
    }
    byPath.set(key, merged);
  }
  return [...byPath.values()];
}

export function rankAndSelectFiles(files, opts = {}) {
  const maxResults = Math.max(1, Number.parseInt(opts.maxResults ?? 12, 10) || 12);
  const intendedRoles = inferQueryRoleIntents(opts.query || "");
  const intendedRole = intendedRoles[0]?.role || FILE_ROLES.IMPLEMENTATION;
  const ranked = rerankFileCandidates(mergeFileCandidates(files), { ...opts, intendedRole, intendedRoles });
  const dynamic = dynamicTopK(ranked, { ...opts, maxResults });
  if (opts.exhaustive || opts.resultMode === "complete") return dynamic;
  // TopK determines response size; the quota then chooses its composition from
  // the full ranked pool so extra support files cannot leave empty slots.
  return applyRelatedResultQuota(ranked, {
    ...opts,
    intendedRole,
    maxResults: dynamic.length,
  });
}
