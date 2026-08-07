/**
 * Lightweight query routing for Locus MCP.
 *
 * Scenario map (internal — single tool surface stays locus_mcp_search):
 *   symbol  → Graph primary, Hybrid secondary, short turns
 *   semantic→ Hybrid primary, Graph optional, short turns
 *   exact   → rg-oriented multi-command, short-medium turns
 *   impact  → Graph primary, higher turns
 *   complex → both local radars + longer Locus fallback
 *
 * Routing never requires external models. Disable with LOCUS_ROUTE=off.
 */

/** @typedef {"symbol"|"semantic"|"exact"|"impact"|"complex"} RouteKind */

/**
 * @param {string} raw
 * @returns {"auto"|"off"}
 */
export function resolveRouteModeFromEnv(raw = process.env.LOCUS_ROUTE) {
  const v = String(raw ?? "auto").trim().toLowerCase();
  if (["0", "false", "no", "off", "disabled"].includes(v)) return "off";
  return "auto";
}

/**
 * @param {string} query
 * @returns {{ kind: RouteKind, signals: string[], scores: Record<string, number> }}
 */
export function classifyQuery(query) {
  const text = String(query || "").trim();
  const lower = text.toLowerCase();
  const signals = [];
  const scores = {
    symbol: 0,
    semantic: 0,
    exact: 0,
    impact: 0,
    complex: 0,
  };

  if (!text) {
    return { kind: "semantic", signals: ["empty"], scores };
  }

  // --- exact / enumerate ---
  if (/["'`][^"'`]{2,}["'`]/.test(text)) {
    scores.exact += 3;
    signals.push("quoted-literal");
  }
  if (
    /\b(exact|literal|hardcoded|string match)\b/i.test(text) ||
    /所有出现|每一处|全部位置|精确匹配|字符串|枚举所有/.test(text)
  ) {
    scores.exact += 3;
    signals.push("exact-language");
  }
  if (/\b(rg|ripgrep|grep)\b/i.test(text)) {
    scores.exact += 2;
    signals.push("grep-tool");
  }

  // --- impact / call graph ---
  if (
    /\b(call(ers|ees)?|call graph|who calls|referenced by|dependenc(y|ies)|impact|blast radius|upstream|downstream)\b/i.test(
      text,
    ) ||
    /谁调用|调用链|调用方|被谁用|依赖关系|影响面|引用链|上游|下游/.test(text)
  ) {
    scores.impact += 4;
    signals.push("impact-language");
  }

  // --- complex / multi-hop fallback ---
  if (
    /\b(how does|end-to-end|architecture|trace(?: the)? (?:complete )?(?:request )?(?:flow|lifecycle)|request lifecycle|complete flow|walk through|implement(ation)? of|why does)\b/i.test(
      text,
    ) ||
    /怎么实现|如何实现|梳理|端到端|完整流程|架构|为什么|链路|跨包|跨模块/.test(text)
  ) {
    scores.complex += 3;
    signals.push("complex-language");
  }
  if (text.length >= 120) {
    scores.complex += 1;
    signals.push("long-query");
  }

  // --- symbol / known name ---
  // file path or extension
  if (/(^|[\s/\\])[\w.-]+\.(go|ts|tsx|js|jsx|mjs|cjs|py|rs|java|kt|css|json|yml|yaml|md|sql)\b/i.test(text)) {
    scores.symbol += 4;
    signals.push("file-name");
  }
  if (/[\\/][\w.-]+[\\/]/.test(text) || /\b(src|app|lib|pkg|packages|backend|frontend)\//i.test(text)) {
    scores.symbol += 2;
    signals.push("path-like");
  }
  // CamelCase / PascalCase tokens (len>=3, mixed case)
  const camel = text.match(/\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+\b/g) || [];
  if (camel.length) {
    scores.symbol += Math.min(4, camel.length + 1);
    signals.push("camel-case");
  }
  // snake_case with multiple segments
  const snake = text.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g) || [];
  if (snake.length) {
    scores.symbol += Math.min(3, snake.length + 1);
    signals.push("snake-case");
  }
  // dotted / hash symbol refs: pkg.Func, Type#method, ::
  if (/\b[\w]+(?:\.|::|#)[\w]+/.test(text)) {
    scores.symbol += 3;
    signals.push("qualified-symbol");
  }
  // common "function/class/component named X"
  const namedDeclaration = text.match(
    /\b(function|class|method|component|hook|type|interface|struct|handler)\s+(?:named\s+)?[`"']?([A-Za-z_$][\w$]*)[`"']?/i,
  );
  const proseFollowers = new Set(["a", "an", "and", "for", "from", "in", "into", "of", "on", "the", "through", "to", "with"]);
  if (namedDeclaration && !proseFollowers.has(namedDeclaration[2].toLowerCase())) {
    scores.symbol += 2;
    signals.push("named-decl");
  }

  // --- semantic natural language (where is / 在哪) without strong symbols ---
  if (
    /\b(where (is|are|does)|find|locate|search for)\b/i.test(text) ||
    /在哪|哪里|找一下|定位|搜索/.test(text)
  ) {
    scores.semantic += 2;
    signals.push("locate-language");
  }
  // Chinese / English prose density
  const wordCount = (text.match(/[A-Za-z]{2,}/g) || []).length;
  const cjkCount = (text.match(/[一-鿿]/g) || []).length;
  if (cjkCount >= 4 || wordCount >= 5) {
    scores.semantic += 1;
    signals.push("prose");
  }

  // Soft prior: pure prose without symbol signals
  if (scores.symbol === 0 && scores.exact === 0 && scores.impact === 0) {
    scores.semantic += 2;
    signals.push("no-symbol-prior");
  }

  // Pick winner (stable order on ties)
  const order = ["impact", "exact", "complex", "symbol", "semantic"];
  let kind = "semantic";
  let best = -1;
  for (const k of order) {
    if (scores[k] > best) {
      best = scores[k];
      kind = /** @type {RouteKind} */ (k);
    }
  }

  // impact+symbol both high stays impact; complex wins over semantic if close
  if (scores.complex >= 3 && scores.complex >= best - 1 && kind === "semantic") {
    kind = "complex";
    signals.push("promote-complex");
  }

  return { kind, signals, scores };
}

/**
 * Preferred turns for a route kind when caller left default max_turns.
 * @param {RouteKind} kind
 * @param {number} defaultMaxTurns
 */
export function preferredTurnsForKind(kind, defaultMaxTurns = 3, opts = {}) {
  const base = Math.max(1, Math.min(5, defaultMaxTurns));
  void opts; // availability no longer clips turns — see symbol/semantic note
  switch (kind) {
    case "symbol":
    case "semantic":
      // Plan-time clip stops at 2: availability alone says nothing about hint
      // quality (the graph may not even cover the query's language). Reduction
      // to 1 is left to adaptTurnsFromLocalHints, which sees the actual hint
      // confidence after the radars run.
      return Math.min(base, 2);
    case "exact":
      return Math.min(base, 2);
    case "impact":
      return Math.max(base, 3);
    case "complex":
      return Math.min(5, Math.max(base, 3));
    default:
      return base;
  }
}

/**
 * @param {Object} opts
 * @param {string} opts.query
 * @param {number} opts.requestedMaxTurns - value from tool call
 * @param {number} opts.defaultMaxTurns - LOCUS_MAX_TURNS env default
 * @param {boolean} opts.graphAvailable - local graph can run on this project
 * @param {boolean} opts.hybridAvailable - Locus native hybrid index is available
 * @param {"auto"|"off"} [opts.routeMode]
 * @param {boolean} [opts.isMonorepoRoot]
 * @returns {Object} route plan
 */
export function planSearchRoute({
  query,
  requestedMaxTurns,
  defaultMaxTurns = 3,
  graphAvailable = false,
  hybridAvailable = false,
  routeMode = "auto",
  isMonorepoRoot = false,
}) {
  const classified = classifyQuery(query);
  const disabled = routeMode === "off";

  if (disabled) {
    return {
      enabled: false,
      kind: classified.kind,
      signals: classified.signals,
      scores: classified.scores,
      maxTurns: requestedMaxTurns,
      turnsAdjusted: false,
      useGraph: graphAvailable,
      useHybrid: hybridAvailable,
      primary: "locus",
      reasons: ["LOCUS_ROUTE=off"],
    };
  }

  const kind = classified.kind;
  const reasons = [`kind=${kind}`];

  // Local radar weights by scenario
  let useGraph = graphAvailable;
  let useHybrid = hybridAvailable;
  /** @type {"graph"|"hybrid"|"locus"|"rg"} */
  let primary = "locus";

  switch (kind) {
    case "symbol":
      primary = graphAvailable ? "graph" : hybridAvailable ? "hybrid" : "locus";
      useGraph = graphAvailable;
      useHybrid = hybridAvailable;
      reasons.push(graphAvailable ? "graph-primary" : "graph-unavailable");
      break;
    case "semantic":
      primary = hybridAvailable ? "hybrid" : graphAvailable ? "graph" : "locus";
      useHybrid = hybridAvailable;
      useGraph = graphAvailable; // keep as weak secondary when present
      reasons.push(hybridAvailable ? "hybrid-primary" : "hybrid-unavailable");
      break;
    case "exact":
      primary = "rg";
      // Local radars still help seed paths, but Locus/rg does the work
      useGraph = graphAvailable;
      useHybrid = hybridAvailable;
      reasons.push("rg-enumerate");
      break;
    case "impact":
      primary = graphAvailable ? "graph" : "locus";
      useGraph = graphAvailable;
      useHybrid = hybridAvailable;
      reasons.push(graphAvailable ? "graph-impact" : "impact-without-graph");
      break;
    case "complex":
      primary = "locus";
      useGraph = graphAvailable;
      useHybrid = hybridAvailable;
      reasons.push("locus-fallback-deep");
      break;
    default:
      break;
  }

  // Adaptive turns: only when caller kept the env default (cannot distinguish omitted
  // MCP default from explicit same value — documented tradeoff).
  let maxTurns = requestedMaxTurns;
  let turnsAdjusted = false;
  const preferred = preferredTurnsForKind(kind, defaultMaxTurns, {
    graphAvailable,
    hybridAvailable,
  });
  if (requestedMaxTurns === defaultMaxTurns && preferred !== requestedMaxTurns) {
    maxTurns = preferred;
    turnsAdjusted = true;
    reasons.push(`turns ${requestedMaxTurns}→${maxTurns}`);
  } else {
    reasons.push(`turns kept=${requestedMaxTurns}`);
  }

  if (isMonorepoRoot && (kind === "semantic" || kind === "complex")) {
    reasons.push("monorepo-root");
  }

  return {
    enabled: true,
    kind,
    signals: classified.signals,
    scores: classified.scores,
    maxTurns,
    turnsAdjusted,
    useGraph,
    useHybrid,
    primary,
    reasons,
  };
}

/**
 * Compact footer line for agents.
 * @param {ReturnType<typeof planSearchRoute>} plan
 */
export function formatRouteFooter(plan) {
  if (!plan) return "";
  if (!plan.enabled) {
    return `\n[route] off kind=${plan.kind} turns=${plan.maxTurns}`;
  }
  const parts = [
    `kind=${plan.kind}`,
    `primary=${plan.primary}`,
    `turns=${plan.maxTurns}${plan.turnsAdjusted ? "*" : ""}`,
    `graph=${plan.useGraph ? "on" : "off"}`,
    `hybrid=${plan.useHybrid ? "on" : "off"}`,
  ];
  if (plan.signals?.length) {
    parts.push(`signals=${plan.signals.slice(0, 6).join(",")}`);
  }
  return `\n[route] ${parts.join(" ")}`;
}
