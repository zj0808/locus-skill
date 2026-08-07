import { createHash } from "node:crypto";
import { resolve } from "node:path";

const CURSOR_VERSION = 1;
export const DEFAULT_COMPLETE_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

export function normalizeResultMode(value, fallback = "complete") {
  const mode = String(value ?? fallback).trim().toLowerCase();
  if (mode === "focused" || mode === "complete") return mode;
  throw new Error(`invalid result_mode: ${value}; expected focused or complete`);
}

function resultFingerprint(files) {
  const rows = (files || []).map((file) => [
    String(file?.path || file?.full_path || "").replace(/\\/g, "/"),
    file?.ranges || [],
  ]);
  return createHash("sha256").update(JSON.stringify(rows)).digest("base64url").slice(0, 24);
}

function searchIdentity({ query, projectRoot, resultMode, includeAllRanges, exhaustive, fingerprint }) {
  const payload = JSON.stringify({
    query: String(query || "").trim(),
    projectRoot: resolve(String(projectRoot || ".")).replace(/\\/g, "/").toLowerCase(),
    resultMode: normalizeResultMode(resultMode),
    includeAllRanges: Boolean(includeAllRanges),
    exhaustive: Boolean(exhaustive),
    fingerprint: String(fingerprint || ""),
  });
  return createHash("sha256").update(payload).digest("base64url").slice(0, 24);
}

export function encodeResultCursor({
  query,
  projectRoot,
  resultMode,
  includeAllRanges,
  exhaustive,
  fingerprint,
  offset,
}) {
  const safeOffset = Math.max(0, Number.parseInt(offset, 10) || 0);
  return Buffer.from(JSON.stringify({
    v: CURSOR_VERSION,
    id: searchIdentity({
      query,
      projectRoot,
      resultMode,
      includeAllRanges,
      exhaustive,
      fingerprint,
    }),
    offset: safeOffset,
  }), "utf8").toString("base64url");
}

export function decodeResultCursor(cursor, context) {
  if (!cursor) return { offset: 0 };
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(String(cursor), "base64url").toString("utf8"));
  } catch {
    throw new Error("invalid cursor: malformed result cursor");
  }
  if (!parsed || parsed.v !== CURSOR_VERSION || !Number.isInteger(parsed.offset) || parsed.offset < 0) {
    throw new Error("invalid cursor: unsupported version or offset");
  }
  const expected = searchIdentity(context);
  if (parsed.id !== expected) {
    throw new Error("invalid cursor: cursor does not match query, project_path, or result_mode");
  }
  return { offset: parsed.offset };
}

export function paginateResults(files, opts) {
  const allFiles = Array.isArray(files) ? files : [];
  const resultMode = normalizeResultMode(opts.resultMode);
  const fingerprint = resultFingerprint(allFiles);
  const requestedSize = Number.parseInt(opts.pageSize, 10);
  const pageSize = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, Number.isInteger(requestedSize) ? requestedSize : DEFAULT_COMPLETE_PAGE_SIZE),
  );
  const { offset } = decodeResultCursor(opts.cursor, {
    query: opts.query,
    projectRoot: opts.projectRoot,
    resultMode,
    includeAllRanges: opts.includeAllRanges,
    exhaustive: opts.exhaustive,
    fingerprint,
  });
  if (offset > allFiles.length) {
    throw new Error(`invalid cursor: offset ${offset} exceeds total candidate count ${allFiles.length}`);
  }

  const page = allFiles.slice(offset, offset + pageSize);
  const nextOffset = offset + page.length;
  const hasMore = nextOffset < allFiles.length;
  return {
    files: page,
    pagination: {
      resultMode,
      totalCandidates: allFiles.length,
      offset,
      pageSize,
      returned: page.length,
      hasMore,
      nextCursor: hasMore
        ? encodeResultCursor({
          query: opts.query,
          projectRoot: opts.projectRoot,
          resultMode,
          includeAllRanges: opts.includeAllRanges,
          exhaustive: opts.exhaustive,
          fingerprint,
          offset: nextOffset,
        })
        : null,
      complete: !hasMore && opts.coverageComplete !== false,
    },
  };
}
