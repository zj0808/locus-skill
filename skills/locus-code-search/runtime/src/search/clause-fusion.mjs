import { rankAndSelectFiles } from "../retrieval/result-policy.mjs";

const RRF_K = 32;

function uniqueValues(values) {
  const seen = new Set();
  return values.filter((value) => {
    const key = typeof value === "string" ? value : JSON.stringify(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Merge independently retrieved query clauses with reciprocal-rank fusion. */
export function fuseClauseResults(query, clauses, results, opts = {}) {
  const byPath = new Map();
  for (let clauseIndex = 0; clauseIndex < results.length; clauseIndex++) {
    const result = results[clauseIndex] || {};
    const clause = clauses[clauseIndex] || String(query || "");
    for (let rank = 0; rank < (result.files || []).length; rank++) {
      const file = result.files[rank];
      if (!file?.path) continue;
      const key = String(file.path).replace(/\\/g, "/").toLowerCase();
      const entry = byPath.get(key) || {
        ...file,
        ranges: [],
        symbols: [],
        matchedTerms: [],
        rankSources: [],
        clauseMatches: [],
        clauseRanks: {},
        _rrf: 0,
      };
      entry._rrf += 1 / (RRF_K + rank + 1);
      entry.ranges.push(...(file.ranges || []));
      entry.symbols.push(...(file.symbols || []));
      entry.matchedTerms.push(...(file.matchedTerms || []));
      entry.rankSources.push(...(file.rankSources || []));
      if (!entry.clauseMatches.includes(clause)) entry.clauseMatches.push(clause);
      entry.clauseRanks[clauseIndex] = rank + 1;
      if (Number(file.score) > Number(entry.score || 0)) {
        entry.score = file.score;
        entry.reason = file.reason;
        entry.evidence = file.evidence || entry.evidence;
      }
      byPath.set(key, entry);
    }
  }

  const candidates = [...byPath.values()];
  const topRrf = Math.max(0, ...candidates.map((file) => file._rrf)) || 1;
  for (const file of candidates) {
    file.score = Math.min(1, (file._rrf / topRrf) * 0.82 + Math.min(1, Number(file.score) || 0) * 0.18);
    file.ranges = uniqueValues(file.ranges).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    file.symbols = uniqueValues(file.symbols);
    file.matchedTerms = uniqueValues(file.matchedTerms);
    file.rankSources = uniqueValues(file.rankSources);
    file.reason = [
      file.reason,
      `matched ${file.clauseMatches.length}/${clauses.length} query clauses via RRF`,
    ].filter(Boolean).join("; ");
    delete file._rrf;
  }

  const maxResults = Math.max(1, Number.parseInt(opts.maxResults ?? candidates.length, 10) || candidates.length || 1);
  const files = rankAndSelectFiles(candidates, {
    query,
    maxResults,
    exhaustive: true,
    confidence: results.every((result) => result?.confidence === "high") ? "high" : "medium",
    edges: results.flatMap((result) => result?.edges || []),
  });
  const confidence = results.every((result) => result?.confidence === "high")
    ? "high"
    : results.some((result) => ["high", "medium"].includes(result?.confidence))
      ? "medium"
      : "low";
  return {
    usable: files.length > 0,
    confidence,
    files,
    edges: uniqueValues(results.flatMap((result) => result?.edges || [])),
    queryCoverage: results.reduce((sum, result) => sum + Number(result?.queryCoverage || 0), 0) / Math.max(1, results.length),
    matchedTermCount: results.reduce((sum, result) => sum + Number(result?.matchedTermCount || 0), 0),
    queryTermCount: results.reduce((sum, result) => sum + Number(result?.queryTermCount || 0), 0),
    notes: uniqueValues(results.flatMap((result) => result?.notes || [])),
    clauseDiagnostics: clauses.map((clause, index) => ({
      clause,
      candidates: results[index]?.files?.length || 0,
      confidence: results[index]?.confidence || "low",
      coverage: Number(results[index]?.queryCoverage || 0),
    })),
    totalCandidates: candidates.length,
    queryDiagnostics: {
      clauses: results.map((result, index) => ({
        clause: clauses[index],
        ...(result?.queryDiagnostics || {}),
      })),
      omittedTerms: uniqueValues(results.flatMap((result) => result?.queryDiagnostics?.omittedTerms || [])),
      complete: results.every((result) => result?.queryDiagnostics?.complete !== false),
    },
    indexCoverage: results.find((result) => result?.indexCoverage)?.indexCoverage || null,
  };
}
