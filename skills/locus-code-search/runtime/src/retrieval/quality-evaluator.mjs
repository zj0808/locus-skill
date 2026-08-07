import {
  classifyFileRole,
  inferQueryRoleIntent,
  rankAndSelectFiles,
} from "./result-policy.mjs";

function normalizePath(path) {
  return String(path || "").replace(/\\/g, "/").toLowerCase();
}

function expectedRank(files, expectedOwners) {
  const expected = new Set((expectedOwners || []).map(normalizePath));
  const index = (files || []).findIndex((file) => expected.has(normalizePath(file.path)));
  return index < 0 ? null : index + 1;
}

export function evaluateRetrievalQuality(cases, opts = {}) {
  const rows = [];
  for (const fixture of cases || []) {
    const rawCandidates = fixture.candidates || [];
    const uniqueCandidatePaths = new Set(rawCandidates.map((file) => normalizePath(file.path)));
    const selected = rankAndSelectFiles(rawCandidates, {
      query: fixture.query,
      maxResults: fixture.maxResults ?? opts.maxResults ?? 12,
      confidence: fixture.confidence || "medium",
      edges: fixture.edges || [],
    });
    const poolRank = expectedRank(rawCandidates, fixture.expectedOwners);
    const resultRank = expectedRank(selected, fixture.expectedOwners);
    const recallFailure = poolRank === null;
    const rankingFailure = !recallFailure && (resultRank === null || resultRank > 5);
    const uniqueResultPaths = new Set(selected.map((file) => normalizePath(file.path)));
    rows.push({
      id: fixture.id || `case-${rows.length + 1}`,
      query: fixture.query || "",
      poolCount: rawCandidates.length,
      resultCount: selected.length,
      poolRank,
      resultRank,
      ownerTop3: resultRank !== null && resultRank <= 3,
      ownerTop5: resultRank !== null && resultRank <= 5,
      testFirst:
        inferQueryRoleIntent(fixture.query) !== "test"
        && classifyFileRole(selected[0]?.path) === "test",
      candidatePoolSaturation: rawCandidates.length - uniqueCandidatePaths.size,
      sameFileSaturation: selected.length - uniqueResultPaths.size,
      recallFailure,
      rankingFailure,
      selected: selected.map((file) => ({ path: file.path, role: file.role, score: file.score })),
    });
  }

  const total = rows.length;
  const count = (key) => rows.filter((row) => row[key]).length;
  const sum = (key) => rows.reduce((value, row) => value + Number(row[key] || 0), 0);
  return {
    generatedAt: new Date().toISOString(),
    total,
    metrics: {
      ownerTop3: count("ownerTop3"),
      ownerTop5: count("ownerTop5"),
      testFirst: count("testFirst"),
      sameFileSaturation: sum("sameFileSaturation"),
      candidatePoolSaturation: sum("candidatePoolSaturation"),
      recallFailures: count("recallFailure"),
      rankingFailures: count("rankingFailure"),
      averageResultCount: total
        ? rows.reduce((value, row) => value + row.resultCount, 0) / total
        : 0,
    },
    rows,
  };
}

export function formatRetrievalQualityReport(report) {
  const total = report.total || 0;
  const metrics = report.metrics || {};
  const pct = (value) => total ? `${((Number(value || 0) / total) * 100).toFixed(1)}%` : "0.0%";
  const lines = [
    "Locus Retrieval Quality",
    "=======================",
    `Cases                 ${total}`,
    `Owner Top3            ${metrics.ownerTop3 || 0}/${total} (${pct(metrics.ownerTop3)})`,
    `Owner Top5            ${metrics.ownerTop5 || 0}/${total} (${pct(metrics.ownerTop5)})`,
    `Test ranked first     ${metrics.testFirst || 0}`,
    `Result saturation     ${metrics.sameFileSaturation || 0}`,
    `Candidate duplicates  ${metrics.candidatePoolSaturation || 0}`,
    `Recall failures       ${metrics.recallFailures || 0}`,
    `Ranking failures      ${metrics.rankingFailures || 0}`,
    `Average result count  ${Number(metrics.averageResultCount || 0).toFixed(2)}`,
    "",
    "Case results",
  ];
  for (const row of report.rows || []) {
    const status = row.recallFailure ? "RECALL" : row.rankingFailure ? "RANK" : "OK";
    lines.push(
      `${status.padEnd(6)} ${row.id.padEnd(22)} owner=${row.resultRank ?? "-"} `
      + `results=${row.resultCount} first=${row.selected[0]?.path || "-"}`,
    );
  }
  return lines.join("\n");
}
