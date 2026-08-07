/**
 * Locus MCP core protocol implementation (Node.js).
 *
 * Reverse-engineered Windsurf SWE-grep Connect-RPC/Protobuf protocol
 * for standalone AI-driven semantic code search.
 *
 * Flow:
 *   query + tree → Windsurf Devstral API
 *   → Devstral returns tool_calls (rg/readfile/tree/ls/glob, up to 8 parallel)
 *   → execute locally → send results back → repeat for N rounds
 *   → ANSWER: file paths + line ranges + suggested rg patterns
 */

import { readdirSync, existsSync, statSync, readFileSync } from "node:fs";
import { resolve, join, relative, sep, isAbsolute } from "node:path";
import { gzipSync } from "node:zlib";
import { randomUUID } from "node:crypto";
import { platform, arch, release, version as osVersion, hostname, cpus, totalmem } from "node:os";
import treeNodeCli from "../vendor/tree-node-cli/src/index.js";

import {
  ProtobufEncoder,
  extractStrings,
  connectFrameEncode,
  connectFrameDecode,
} from "./protobuf.mjs";
import { ToolExecutor } from "./executor.mjs";
import { buildGraphHintBlock } from "./graph/provider.mjs";
import { buildHybridHintBlock } from "./retrieval/native-hybrid-provider.mjs";
import { buildVectorHintBlock } from "./retrieval/vector-provider.mjs";
import { watchProjectForIndexSync } from "./retrieval/background-sync.mjs";
import { rankAndSelectFiles } from "./retrieval/result-policy.mjs";
import {
  DEFAULT_COMPLETE_PAGE_SIZE,
  normalizeResultMode,
  paginateResults,
} from "./search/result-pagination.mjs";

// ─── Error Classification ──────────────────────────────────

/**
 * Classified error for fetch failures with structured error codes.
 */
class LocusMcpError extends Error {
  /**
   * @param {string} message
   * @param {string} code - TIMEOUT | PAYLOAD_TOO_LARGE | RATE_LIMITED | AUTH_ERROR | SERVER_ERROR | NETWORK_ERROR
   * @param {Object} [details]
   */
  constructor(message, code, details = {}) {
    super(message);
    this.name = "LocusMcpError";
    this.code = code;
    this.details = details;
  }
}

/**
 * Classify a raw fetch/HTTP error into a LocusMcpError.
 * @param {Error} err
 * @returns {LocusMcpError}
 */
function _classifyError(err) {
  if (err instanceof LocusMcpError) return err;

  // HTTP status-based classification
  if (err.status) {
    const s = err.status;
    if (s === 413) return new LocusMcpError(err.message, "PAYLOAD_TOO_LARGE", { status: s });
    if (s === 429) return new LocusMcpError(err.message, "RATE_LIMITED", { status: s });
    if (s === 401 || s === 403) return new LocusMcpError(err.message, "AUTH_ERROR", { status: s });
    return new LocusMcpError(err.message, "SERVER_ERROR", { status: s });
  }

  // Timeout (AbortSignal.timeout throws AbortError or TimeoutError)
  if (err.name === "AbortError" || err.name === "TimeoutError" || /timeout/i.test(err.message)) {
    return new LocusMcpError(err.message, "TIMEOUT");
  }

  // Everything else is a network-level issue
  return new LocusMcpError(err.message, "NETWORK_ERROR");
}

/**
 * True when an error is a timeout/abort (before or after classification).
 * @param {Error} err
 * @returns {boolean}
 */
function _isTimeoutErr(err) {
  if (!err) return false;
  return (
    err.code === "TIMEOUT" ||
    err.name === "AbortError" ||
    err.name === "TimeoutError" ||
    /timeout/i.test(err.message || "")
  );
}

// ─── Relay Mode Configuration ──────────────────────────────
// When LOCUS_BASE_URL is set, requests are routed through the hosted Locus
// relay instead of going directly to Windsurf. The relay injects/replaces the
// real Windsurf auth server-side, so no local Windsurf key is needed.
// LOCUS_TOKEN is sent as an Authorization: Bearer header for relay auth.
const LOCUS_BASE_URL = (process.env.LOCUS_BASE_URL || "").replace(/\/+$/, "");
const LOCUS_TOKEN = process.env.LOCUS_TOKEN || "";
const RELAY_MODE = LOCUS_BASE_URL.length > 0;
const RELAY_API_KEY_PLACEHOLDER = "relay-managed";
const SEARCH_EVENT_PATH = "/locus.v1.SearchService/ReportSearchEvent";

function assertRelayAuthenticated() {
  if (!RELAY_MODE || !LOCUS_TOKEN) {
    throw new Error("Authenticated ACE relay mode is required.");
  }
}

// 查询文本上报（供中继侧日志排查用）：默认关闭，设 LOCUS_LOG_QUERY=on 才会
// 把查询文本（截断 200 字符）随中继请求上报。默认行为不泄露任何查询内容。
const LOG_QUERY_ENABLED = ["1", "true", "yes", "on"].includes(
  String(process.env.LOCUS_LOG_QUERY ?? "").trim().toLowerCase(),
);
const SEARCH_EVENT_TIMEOUT_MS = Math.max(
  250,
  Math.min(5000, Number.parseInt(process.env.LOCUS_SEARCH_EVENT_TIMEOUT_MS || "5000", 10) || 5000),
);

// ─── Protocol Constants ────────────────────────────────────

const _SERVICE_ROOT = RELAY_MODE ? LOCUS_BASE_URL : "https://server.self-serve.windsurf.com";
const API_BASE = `${_SERVICE_ROOT}/exa.api_server_pb.ApiServerService`;
const AUTH_BASE = `${_SERVICE_ROOT}/exa.auth_pb.AuthService`;
const WS_APP = "windsurf";
const WS_APP_VER = process.env.WS_APP_VER || "1.48.2";
const WS_LS_VER = process.env.WS_LS_VER || "1.9544.35";
const WS_MODEL = process.env.WS_MODEL || "MODEL_SWE_1_6_FAST";

/**
 * Report aggregate local-search telemetry (no code snippets or file paths;
 * query text only when explicitly opted in via LOCUS_LOG_QUERY=on).
 * This intentionally does not block the MCP response and never affects search.
 */
export function summarizeResultComposition(files = []) {
  let ownerCount = 0;
  let relatedCount = 0;
  for (const file of files || []) {
    const role = String(file?.role || "").toLowerCase();
    if (["test", "documentation", "config", "export"].includes(role)) relatedCount += 1;
    else ownerCount += 1;
  }
  return { ownerCount, relatedCount };
}

export function reportLocalSearchEvent({
  durationMs,
  resultCount,
  routeKind,
  speedProfile,
  sources,
  localFirst = false,
  recoveredFromEvidence = false,
  ownerCount = 0,
  relatedCount = 0,
  query = "",
}) {
  if (!RELAY_MODE || !LOCUS_TOKEN || typeof fetch !== "function") return;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_EVENT_TIMEOUT_MS);
  timer.unref?.();
  const safeResultCount = Math.max(0, Math.round(Number(resultCount) || 0));
  const safeOwnerCount = Math.max(0, Math.min(30, Math.round(Number(ownerCount) || 0)));
  const safeRelatedCount = Math.max(0, Math.min(30, Math.round(Number(relatedCount) || 0)));
  const payload = {
    duration_ms: Math.max(0, Math.round(Number(durationMs) || 0)),
    result_count: safeResultCount,
    route_kind: String(routeKind || "semantic"),
    speed_profile: String(speedProfile || "balanced"),
    sources: [...new Set((Array.isArray(sources) ? sources : []).map((source) => String(source)))],
    local_first: Boolean(localFirst),
    recovered_from_evidence: Boolean(recoveredFromEvidence),
    owner_count: safeOwnerCount,
    related_count: safeRelatedCount,
    // 查询文本默认不上报，仅 LOCUS_LOG_QUERY=on 显式开启时附带。
    ...(LOG_QUERY_ENABLED && query ? { query: String(query).slice(0, 200) } : {}),
  };

  void fetch(`${LOCUS_BASE_URL}${SEARCH_EVENT_PATH}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${LOCUS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
    signal: controller.signal,
  }).then(cancelResponseBody).catch(() => {}).finally(() => clearTimeout(timer));
}

async function cancelResponseBody(response) {
  try {
    await response?.body?.cancel();
  } catch {
    // The response may already be consumed or aborted.
  }
}

// ─── System Prompt Template ────────────────────────────────

const SYSTEM_PROMPT_TEMPLATE = `You are an expert software engineer, responsible for providing context \
to another engineer to solve a code issue in the current codebase. \
The user will present you with a description of the issue, and it is \
your job to provide a series of file paths with associated line ranges \
that contain ALL the information relevant to understand and correctly \
address the issue.

# IMPORTANT:
- A relevant file does not mean only the files that must be modified to \
solve the task. It means any file that contains information relevant to \
planning and implementing the fix, such as the definitions of classes \
and functions that are relevant to the pieces of code that will have to \
be modified.
- You should include enough context around the relevant lines to allow \
the engineer to understand the task correctly. You must include ENTIRE \
semantic blocks (functions, classes, definitions, etc). For example:
If addressing the issue requires modifying a method within a class, then \
you should include the entire class definition, not just the lines around \
the method we want to modify.
- NEVER truncate these blocks unless they are very large (hundreds of \
lines or more, in which case providing only a relevant portion of the \
block is acceptable).
- Your job is to essentially alleviate the job of the other engineer by \
giving them a clean starting context from which to start working. More \
precisely, you should minimize the number of files the engineer has to \
read to understand and solve the task correctly (while not providing \
irrelevant code snippets).

# ENVIRONMENT
- Working directory: /codebase. Make sure to run commands in this \
directory, not \`.
- Tool access: use the restricted_exec tool ONLY
- Allowed sub-commands (schema-enforced):
  - rg: Search for patterns in files using ripgrep
    - Required: pattern (string), path (string)
    - Optional: include (array of globs), exclude (array of globs), result_offset (int)
  - readfile: Read contents of a file with optional line range
    - Required: file (string)
    - Optional: start_line (int), end_line (int) — 1-indexed, inclusive
  - tree: Display directory structure as a tree
    - Required: path (string)
    - Optional: levels (int), result_offset (int)
  - ls: List files in a directory
    - Required: path (string)
    - Optional: long_format (bool), all (bool), result_offset (int)
  - glob: Find files matching a glob pattern
    - Required: pattern (string), path (string)
    - Optional: type_filter (file/directory/all), result_offset (int)

# THINKING RULES
- Think step-by-step. Plan, reason, and reflect before each tool call.
- Use tool calls liberally and purposefully to ground every conclusion \
in real code, not assumptions.
- If a command fails, rethink and try something different; do not \
complain to the user.

# FAST-SEARCH DEFAULTS (optimize rg/tree on large repos)
- Start NARROW, then widen only if needed. Prefer searching likely code \
roots first (e.g., \`src/\`, \`lib/\`, \`app/\`, \`packages/\`, \`services/\`) \
instead of \`/codebase\`.
- Prefer fixed-string search for literals: escape patterns or keep regex \
simple. Use smart case; avoid case-insensitive unless necessary.
- Prefer file-type filters and globs (in include) over full-repo scans.
- Default EXCLUDES for speed (apply via the exclude array): \
node_modules, .git, dist, build, coverage, .venv, venv, target, out, \
.cache, __pycache__, vendor, deps, third_party, logs, data, *.min.*
- Skip huge files where possible; when opening files, prefer reading \
only relevant ranges with readfile.
- Limit directory traversal with tree levels to quickly orient before \
deeper inspection.
- If Local Graph Hints are present, treat them as ranked candidates only: \
verify with rg/readfile before including in ANSWER. Prefer high-confidence \
hint files, but never invent ranges without reading.
- Precision over coverage: prefer the few files that define or own the \
behavior over many loosely related hits (tests/mocks/generated code last).

# SOME EXAMPLES OF WORKFLOWS
- MAP – Use \`tree\` with small levels; \`rg\` on likely roots to grasp \
structure and hotspots.
- ANCHOR – \`rg\` for problem keywords and anchor symbols; restrict by \
language globs via include.
- TRACE – Follow imports with targeted \`rg\` in narrowed roots; open \
files with \`readfile\` scoped to entire semantic blocks.
- VERIFY – Confirm each candidate path exists by reading or additional \
searches; drop false positives (tests, vendored, generated) unless they \
must change.

# TOOL USE GUIDELINES
- You must use a SINGLE restricted_exec call in your answer, that lets \
you execute at most {max_commands} commands in a single turn. Each command must be \
an object with a \`type\` field of \`rg\`, \`readfile\`, \`tree\`, \`ls\`, or \`glob\` and the appropriate fields for that type.
- Example restricted_exec usage:
[TOOL_CALLS]restricted_exec[ARGS]{{
  "command1": {{
    "type": "rg",
    "pattern": "Controller",
    "path": "/codebase/slime",
    "include": ["**/*.py"],
    "exclude": ["**/node_modules/**", "**/.git/**", "**/dist/**", \
"**/build/**", "**/.venv/**", "**/__pycache__/**"]
  }},
  "command2": {{
    "type": "readfile",
    "file": "/codebase/slime/train.py",
    "start_line": 1,
    "end_line": 200
  }},
  "command3": {{
    "type": "tree",
    "path": "/codebase/slime/",
    "levels": 2
  }}
}}
- You have at most {max_turns} turns to interact with the environment by calling \
tools, so issuing multiple commands at once is necessary and encouraged \
to speed up your research.
- Command results are paged (readfile ~250 lines; rg/ls/glob ~50; tree ~40). \
A [continuation] marker gives the exact next_start_line or next_result_offset. \
Follow every relevant continuation before concluding coverage; a page is not the complete result set.
- DO NOT EVER USE MORE THAN {max_commands} commands in a single turn, or you will \
be penalized.

# ANSWER FORMAT (strict format, including tags)
- You will output an XML structure with a root element "ANSWER" \
containing "file" elements. Each "file" element will have a "path" \
attribute and contain "range" elements.
- You will output this as your final response.
- The line ranges must be inclusive.

Output example inside the "answer" tool argument:
<ANSWER>
  <file path="/codebase/info_theory/formulas/entropy.py">
    <range>10-60</range>
    <range>150-210</range>
  </file>
  <file path="/codebase/info_theory/data_structures/bits.py">
    <range>1-40</range>
    <range>110-170</range>
  </file>
</ANSWER>


Remember: Prefer narrow, fixed-string, and type-filtered searches with \
aggressive excludes and size/depth limits. Widen scope only as needed. \
Use the restricted tools available to you, and output your answer in \
exactly the specified format.

# NO RESULTS POLICY
If after thorough searching you are confident that NO relevant files exist \
for the given query (e.g., the function/class/concept does not exist in the \
codebase), you MUST return an empty ANSWER:
<ANSWER></ANSWER>
Do NOT return irrelevant files (such as entry points or config files) just \
to provide some output. An empty answer is always better than a misleading one.

# RESULT COUNT
Aim to return at most {max_results} files in your answer. Focus on the most \
relevant files first. If fewer files are relevant, return fewer.
`;

const FINAL_FORCE_ANSWER =
  "You have no turns left. Now you MUST provide your final ANSWER, even if it's not complete.";

/**
 * Trim accumulated messages to reduce payload size for retry.
 * Keeps: system prompt (index 0), user query (index 1), and last 2 messages.
 * Inserts a bridge note so the AI knows context was truncated.
 * @param {Array} messages
 * @returns {boolean} true if messages were actually trimmed
 */
function _trimMessages(messages) {
  if (messages.length <= 4) return false;
  const head = messages.slice(0, 2);
  const tail = messages.slice(-2);
  messages.length = 0;
  messages.push(
    ...head,
    { role: 1, content: "[Prior search rounds omitted to reduce payload. Provide your best answer based on available context.]" },
    ...tail,
  );
  return true;
}

// On payload/timeout retries the embedded repo map is the single largest payload
// component — _trimMessages keeps messages[1] (which contains it) intact, so cap
// the tree itself as well. Also the only recovery available on first-turn failures.
const RETRY_TREE_MAX_BYTES = 32 * 1024;

/**
 * Shrink the repo map embedded in the retained user message (index 1).
 * @param {Array} messages
 * @returns {boolean} true if the tree was actually shrunk
 */
function _shrinkRepoMapInMessages(messages) {
  const msg = messages[1];
  if (!msg || typeof msg.content !== "string") return false;
  const startMarker = "```text\n";
  const start = msg.content.indexOf(startMarker);
  if (start === -1) return false;
  const treeStart = start + startMarker.length;
  const end = msg.content.indexOf("\n```", treeStart);
  if (end === -1) return false;
  const lines = msg.content.slice(treeStart, end).split("\n");
  const kept = [];
  let bytes = 0;
  for (const line of lines) {
    const b = Buffer.byteLength(line, "utf-8") + 1;
    if (bytes + b > RETRY_TREE_MAX_BYTES) break;
    kept.push(line);
    bytes += b;
  }
  if (kept.length >= lines.length) return false;
  kept.push("... (tree truncated for retry) ...");
  msg.content = msg.content.slice(0, treeStart) + kept.join("\n") + msg.content.slice(end);
  return true;
}

/**
 * @param {number} maxTurns
 * @param {number} maxCommands
 * @param {number} maxResults
 * @returns {string}
 */
function buildSystemPrompt(maxTurns = 3, maxCommands = 8, maxResults = 10, resultMode = "focused") {
  let prompt = SYSTEM_PROMPT_TEMPLATE
    .replaceAll("{max_turns}", String(maxTurns))
    .replaceAll("{max_commands}", String(maxCommands))
    .replaceAll("{max_results}", String(maxResults));
  if (resultMode === "complete") {
    prompt = prompt
      .replace(
        "Precision over coverage: prefer the few files that define or own the behavior over many loosely related hits (tests/mocks/generated code last).",
        "Return every directly relevant file and every distinct relevant range. Rank owners first, but do not omit relevant tail results.",
      )
      .replace(
        `Aim to return at most ${maxResults} files in your answer. Focus on the most relevant files first. If fewer files are relevant, return fewer.`,
        "Return all relevant files in your answer. Do not apply a file-count cutoff; preserve every verified range for each file.",
      );
  }
  return prompt;
}

// ─── Tool Schema ───────────────────────────────────────────

function _buildCommandSchema(n) {
  return {
    type: "object",
    description: `Command ${n} to execute. Must be one of: rg, readfile, tree, ls, or glob.`,
    oneOf: [
      {
        properties: {
          type: { type: "string", const: "rg", description: "Search for patterns in files using ripgrep." },
          pattern: { type: "string", description: "The regex pattern to search for." },
          path: { type: "string", description: "The path to search in." },
          include: { type: "array", items: { type: "string" }, description: "File patterns to include." },
          exclude: { type: "array", items: { type: "string" }, description: "File patterns to exclude." },
          result_offset: { type: "integer", minimum: 0, description: "Continuation offset from a prior rg page." },
        },
        required: ["type", "pattern", "path"],
      },
      {
        properties: {
          type: { type: "string", const: "readfile", description: "Read contents of a file with optional line range." },
          file: { type: "string", description: "Path to the file to read." },
          start_line: { type: "integer", description: "Starting line number (1-indexed)." },
          end_line: { type: "integer", description: "Ending line number (1-indexed)." },
        },
        required: ["type", "file"],
      },
      {
        properties: {
          type: { type: "string", const: "tree", description: "Display directory structure as a tree." },
          path: { type: "string", description: "Path to the directory." },
          levels: { type: "integer", description: "Number of directory levels." },
          result_offset: { type: "integer", minimum: 0, description: "Continuation offset from a prior tree page." },
        },
        required: ["type", "path"],
      },
      {
        properties: {
          type: { type: "string", const: "ls", description: "List files in a directory." },
          path: { type: "string", description: "Path to the directory." },
          long_format: { type: "boolean" },
          all: { type: "boolean" },
          result_offset: { type: "integer", minimum: 0, description: "Continuation offset from a prior ls page." },
        },
        required: ["type", "path"],
      },
      {
        properties: {
          type: { type: "string", const: "glob", description: "Find files matching a glob pattern." },
          pattern: { type: "string" },
          path: { type: "string" },
          type_filter: { type: "string", enum: ["file", "directory", "all"] },
          result_offset: { type: "integer", minimum: 0, description: "Continuation offset from a prior glob page." },
        },
        required: ["type", "pattern", "path"],
      },
    ],
  };
}

/**
 * @param {number} maxCommands
 * @returns {string}
 */
function getToolDefinitions(maxCommands = 8) {
  const props = {};
  for (let i = 1; i <= maxCommands; i++) {
    props[`command${i}`] = _buildCommandSchema(i);
  }
  const tools = [
    {
      type: "function",
      function: {
        name: "restricted_exec",
        description: "Execute restricted commands (rg, readfile, tree, ls, glob) in parallel.",
        parameters: { type: "object", properties: props, required: ["command1"] },
      },
    },
    {
      type: "function",
      function: {
        name: "answer",
        description: "Final answer with relevant files and line ranges.",
        parameters: {
          type: "object",
          properties: { answer: { type: "string", description: "The final answer in XML format." } },
          required: ["answer"],
        },
      },
    },
  ];
  return JSON.stringify(tools);
}

// ─── Credentials ───────────────────────────────────────────

/** @returns {Promise<string>} */
async function getApiKey() {
  assertRelayAuthenticated();
  return RELAY_API_KEY_PLACEHOLDER;
}

// ─── JWT Cache ──────────────────────────────────────────────

/** @type {Map<string, { token: string, expiresAt: number }>} */
const _jwtCache = new Map();

/**
 * Decode JWT payload and extract expiration time.
 * @param {string} jwt
 * @returns {number} expiration timestamp in seconds
 */
function _getJwtExp(jwt) {
  try {
    const parts = jwt.split(".");
    if (parts.length < 2) return 0;
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf-8"));
    return payload.exp || 0;
  } catch {
    return 0;
  }
}

/**
 * Get a cached or fresh JWT token.
 * Refreshes when token expires or is within 60s of expiration.
 * @param {string} apiKey
 * @returns {Promise<string>}
 */
async function getCachedJwt(apiKey) {
  const now = Math.floor(Date.now() / 1000);
  const cached = _jwtCache.get(apiKey);
  if (cached && cached.expiresAt > now + 60) return cached.token;
  const token = await fetchJwt(apiKey);
  const exp = _getJwtExp(token);
  _jwtCache.set(apiKey, { token, expiresAt: exp || now + 3600 });
  return token;
}

// ─── TLS Fallback ──────────────────────────────────────────
// Match Python's SSL fallback: if NODE_TLS_REJECT_UNAUTHORIZED is not set
// and the first fetch fails with a TLS error, disable cert verification.
let _tlsFallbackApplied = false;

function _applyTlsFallback() {
  if (!_tlsFallbackApplied && !process.env.NODE_TLS_REJECT_UNAUTHORIZED) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    _tlsFallbackApplied = true;
    process.stderr.write(
      "[locus-mcp] WARNING: TLS certificate verification disabled due to connection failure. " +
      "Set NODE_TLS_REJECT_UNAUTHORIZED=0 explicitly to suppress this warning.\n"
    );
  }
}

// ─── Network Layer ─────────────────────────────────────────

/**
 * Standard unary HTTP POST with proto content type.
 * @param {string} url
 * @param {Buffer} protoBytes
 * @param {boolean} [compress=true]
 * @returns {Promise<Buffer>}
 */
async function _unaryRequest(url, protoBytes, compress = true) {
  const headers = {
    "Content-Type": "application/proto",
    "Connect-Protocol-Version": "1",
    "User-Agent": "connect-go/1.18.1 (go1.25.5)",
    "Accept-Encoding": "gzip",
  };
  if (RELAY_MODE && LOCUS_TOKEN) {
    headers["Authorization"] = `Bearer ${LOCUS_TOKEN}`;
  }

  let body;
  if (compress) {
    body = gzipSync(protoBytes);
    headers["Content-Encoding"] = "gzip";
  } else {
    body = protoBytes;
  }

  const doFetch = () => fetch(url, {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.timeout(30000),
  });

  let resp;
  try {
    resp = await doFetch();
  } catch (e) {
    // TLS or network error — try with cert verification disabled
    _applyTlsFallback();
    try {
      resp = await doFetch();
    } catch (e2) {
      throw _classifyError(e2);
    }
  }

  if (!resp.ok) {
    await cancelResponseBody(resp);
    const err = new Error(`HTTP ${resp.status}`);
    err.status = resp.status;
    throw _classifyError(err);
  }

  const arrayBuf = await resp.arrayBuffer();
  return Buffer.from(arrayBuf);
}

/**
 * Connect-RPC streaming POST to GetDevstralStream with retry.
 * @param {Buffer} protoBytes
 * @param {number} [timeoutMs=30000]
 * @param {number} [maxRetries=2]
 * @returns {Promise<Buffer>}
 */
async function _streamingRequest(protoBytes, timeoutMs = 30000, maxRetries = 2, queryHint = "") {
  const frame = connectFrameEncode(protoBytes);
  const url = `${API_BASE}/GetDevstralStream`;
  const traceId = randomUUID().replace(/-/g, "");
  const spanId = randomUUID().replace(/-/g, "").slice(0, 16);
  const baseTimeoutMs = Number.isFinite(timeoutMs) ? timeoutMs : 30000;
  const abortMs = baseTimeoutMs + 5000;

  const headers = {
    "Content-Type": "application/connect+proto",
    "Connect-Protocol-Version": "1",
    "Connect-Accept-Encoding": "gzip",
    "Connect-Content-Encoding": "gzip",
    "Connect-Timeout-Ms": String(baseTimeoutMs),
    "User-Agent": "connect-go/1.18.1 (go1.25.5)",
    "Accept-Encoding": "identity",
    "Baggage": `sentry-release=language-server-windsurf@${WS_LS_VER},` +
      `sentry-environment=stable,sentry-sampled=false,` +
      `sentry-trace_id=${traceId},` +
      `sentry-public_key=b813f73488da69eedec534dba1029111`,
    "Sentry-Trace": `${traceId}-${spanId}-0`,
  };
  if (RELAY_MODE && LOCUS_TOKEN) {
    headers["Authorization"] = `Bearer ${LOCUS_TOKEN}`;
    if (LOG_QUERY_ENABLED && queryHint) {
      // URL 编码保证 header 值 ASCII 安全；中继侧仅存日志，不转发上游。
      headers["X-Locus-Query"] = encodeURIComponent(String(queryHint).slice(0, 200));
    }
  }

  const doFetch = () => fetch(url, {
    method: "POST",
    headers,
    body: frame,
    signal: AbortSignal.timeout(abortMs),
  });

  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      let resp;
      try {
        resp = await doFetch();
      } catch (e) {
        // TLS fallback only helps genuine handshake failures — a timeout would
        // just burn another full abort window on the same doomed payload.
        if (attempt === 0 && !_isTimeoutErr(e)) {
          _applyTlsFallback();
          resp = await doFetch();
        } else {
          throw e;
        }
      }

      if (!resp.ok) {
        await cancelResponseBody(resp);
        const err = new Error(`HTTP ${resp.status}`);
        err.status = resp.status;
        // Don't retry on 4xx client errors (except 429)
        if (resp.status >= 400 && resp.status < 500 && resp.status !== 429) {
          throw err;
        }
        lastErr = err;
        if (attempt < maxRetries) {
          await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
          continue;
        }
        throw err;
      }

      const arrayBuf = await resp.arrayBuffer();
      return Buffer.from(arrayBuf);
    } catch (e) {
      lastErr = e;
      // Don't retry on 4xx client errors (except 429)
      if (e.status && e.status >= 400 && e.status < 500 && e.status !== 429) {
        throw _classifyError(e);
      }
      // Retrying a timeout with the identical payload is near-certain to time
      // out again — surface it immediately so the caller can shrink the payload.
      if (_isTimeoutErr(e)) {
        throw _classifyError(e);
      }
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }
    }
  }
  throw _classifyError(lastErr);
}

/**
 * Authenticate with API key to get JWT token.
 * @param {string} apiKey
 * @returns {Promise<string>}
 */
async function fetchJwt(apiKey) {
  const meta = new ProtobufEncoder();
  meta.writeString(1, WS_APP);
  meta.writeString(2, WS_APP_VER);
  meta.writeString(3, apiKey);
  meta.writeString(4, "zh-cn");
  meta.writeString(7, WS_LS_VER);
  meta.writeString(12, WS_APP);
  meta.writeBytes(30, Buffer.from([0x00, 0x01]));

  const outer = new ProtobufEncoder();
  outer.writeMessage(1, meta);

  const resp = await _unaryRequest(`${AUTH_BASE}/GetUserJwt`, outer.toBuffer(), false);
  for (const s of extractStrings(resp)) {
    if (s.startsWith("eyJ") && s.includes(".")) {
      return s;
    }
  }
  throw new Error("Failed to extract JWT from GetUserJwt response");
}

/**
 * Check rate limit. Returns true if OK, false if rate-limited.
 * Hosted relay mode always synthesizes 200 for this endpoint — skip the RTT.
 * @param {string} apiKey
 * @param {string} jwt
 * @returns {Promise<boolean>}
 */
/** Short TTL so multi-query sessions skip repeated rate-limit RTTs. */
const RATE_LIMIT_CACHE_MS = Math.max(
  0,
  Number.parseInt(process.env.LOCUS_RATE_LIMIT_CACHE_MS || "15000", 10) || 15000
);
let _rateLimitCache = { ok: true, expiresAt: 0 };

async function checkRateLimit(apiKey, jwt) {
  if (RELAY_MODE) return true;
  if (RATE_LIMIT_CACHE_MS > 0 && _rateLimitCache.expiresAt > Date.now()) {
    return _rateLimitCache.ok;
  }

  const req = new ProtobufEncoder();
  req.writeMessage(1, _buildMetadata(apiKey, jwt));
  req.writeString(3, WS_MODEL);

  try {
    await _unaryRequest(`${API_BASE}/CheckUserMessageRateLimit`, req.toBuffer(), true);
    if (RATE_LIMIT_CACHE_MS > 0) {
      _rateLimitCache = { ok: true, expiresAt: Date.now() + RATE_LIMIT_CACHE_MS };
    }
    return true;
  } catch (e) {
    if (e.status === 429) {
      if (RATE_LIMIT_CACHE_MS > 0) {
        _rateLimitCache = { ok: false, expiresAt: Date.now() + Math.min(RATE_LIMIT_CACHE_MS, 5000) };
      }
      return false;
    }
    return true; // Don't block on network issues
  }
}

// ─── Request Building ──────────────────────────────────────

/**
 * Build protobuf metadata with app info, system info, JWT, etc.
 * @param {string} apiKey
 * @param {string} jwt
 * @returns {ProtobufEncoder}
 */
function _buildMetadata(apiKey, jwt) {
  const meta = new ProtobufEncoder();
  meta.writeString(1, WS_APP);
  meta.writeString(2, WS_APP_VER);
  meta.writeString(3, apiKey);
  meta.writeString(4, "zh-cn");

  const plat = platform();
  const sysInfo = {
    Os: plat,
    Arch: arch(),
    Release: release(),
    Version: osVersion(),
    Machine: arch(),
    Nodename: hostname(),
    Sysname: plat === "darwin" ? "Darwin" : plat === "win32" ? "Windows_NT" : "Linux",
    ProductVersion: "",
  };
  meta.writeString(5, JSON.stringify(sysInfo));
  meta.writeString(7, WS_LS_VER);

  const cpuList = cpus();
  const ncpu = cpuList.length || 4;
  const mem = totalmem();
  const cpuInfo = {
    NumSockets: 1,
    NumCores: ncpu,
    NumThreads: ncpu,
    VendorID: "",
    Family: "0",
    Model: "0",
    ModelName: cpuList[0]?.model || "Unknown",
    Memory: mem,
  };
  meta.writeString(8, JSON.stringify(cpuInfo));
  meta.writeString(12, WS_APP);
  meta.writeString(21, jwt);
  meta.writeBytes(30, Buffer.from([0x00, 0x01]));
  return meta;
}

/**
 * Build a chat message protobuf.
 * @param {number} role - 1=user, 2=assistant, 4=tool_result, 5=system
 * @param {string} content
 * @param {Object} [opts]
 * @param {string} [opts.toolCallId]
 * @param {string} [opts.toolName]
 * @param {string} [opts.toolArgsJson]
 * @param {string} [opts.refCallId]
 * @returns {ProtobufEncoder}
 */
function _buildChatMessage(role, content, opts = {}) {
  const msg = new ProtobufEncoder();
  msg.writeVarint(2, role);
  msg.writeString(3, content);

  if (opts.toolCallId && opts.toolName && opts.toolArgsJson) {
    const tc = new ProtobufEncoder();
    tc.writeString(1, opts.toolCallId);
    tc.writeString(2, opts.toolName);
    tc.writeString(3, opts.toolArgsJson);
    msg.writeMessage(6, tc);
  }

  if (opts.refCallId) {
    msg.writeString(7, opts.refCallId);
  }

  return msg;
}

/**
 * Build a full request with metadata, messages, and tool definitions.
 * @param {string} apiKey
 * @param {string} jwt
 * @param {Array} messages
 * @param {string} toolDefs
 * @returns {Buffer}
 */
function _buildRequest(apiKey, jwt, messages, toolDefs) {
  const req = new ProtobufEncoder();
  req.writeMessage(1, _buildMetadata(apiKey, jwt));

  for (const m of messages) {
    const msgEnc = _buildChatMessage(m.role, m.content, {
      toolCallId: m.tool_call_id,
      toolName: m.tool_name,
      toolArgsJson: m.tool_args_json,
      refCallId: m.ref_call_id,
    });
    req.writeMessage(2, msgEnc);
  }

  req.writeString(3, toolDefs);
  return req.toBuffer();
}

// ─── Response Parsing ──────────────────────────────────────

/**
 * Strip invalid UTF-8 bytes from a Buffer → clean string.
 * Matches Python's bytes.decode("utf-8", errors="ignore").
 * @param {Buffer} buf
 * @returns {string}
 */
function stripInvalidUtf8(buf) {
  return buf.toString("utf-8").replace(/\ufffd/g, "");
}

/**
 * Parse tool call from [TOOL_CALLS]name[ARGS]{json} format.
 * @param {string} text
 * @returns {[string, string, Object]|null} [thinking, name, args] or null
 */
function stripTrailingJsonCommas(text) {
  let out = "";
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }

    if (ch === ",") {
      let next = i + 1;
      while (next < text.length && /\s/.test(text[next])) next++;
      if (text[next] === "}" || text[next] === "]") continue;
    }
    out += ch;
  }
  return out;
}

function extractJsonObject(text) {
  const start = text.indexOf("{");
  if (start < 0) return "";

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return text.slice(start);
}

export function _parseToolCall(text) {
  text = text.replace(/<\/s>/g, "");
  const m = text.match(/\[TOOL_CALLS\](\w+)\[ARGS\](\{.+)/s);
  if (!m) return null;

  const name = m[1];
  const raw = extractJsonObject(m[2].trim());

  let args;
  try {
    args = JSON.parse(raw);
  } catch {
    try {
      // Devstral occasionally emits a trailing comma before } or ]. Repair
      // only that JSON defect; all other malformed calls still fail closed.
      args = JSON.parse(stripTrailingJsonCommas(raw));
    } catch {
      return null;
    }
  }

  const thinking = text.slice(0, m.index).trim();
  return [thinking, name, args];
}

/**
 * Parse streaming response: decode frames, extract text, parse tool calls.
 * @param {Buffer} data
 * @returns {[string, [string, Object]|null]} [text, toolInfo]
 */
function _parseResponse(data) {
  const frames = connectFrameDecode(data);
  let allText = "";

  for (const frameData of frames) {
    // Check for error JSON
    try {
      const textCandidate = frameData.toString("utf-8");
      if (textCandidate.startsWith("{")) {
        const errObj = JSON.parse(textCandidate);
        if (errObj.error) {
          const code = errObj.error.code || "unknown";
          const msg = errObj.error.message || "";
          return [`[Error] ${code}: ${msg}`, null];
        }
      }
    } catch {
      // Not JSON, continue
    }

    // Extract text from frame — strip invalid UTF-8 (matches Python errors="ignore")
    const rawText = stripInvalidUtf8(frameData);
    if (rawText.includes("[TOOL_CALLS]")) {
      allText = rawText;
      break;
    }

    for (const s of extractStrings(frameData)) {
      if (s.length > 10) {
        allText += s;
      }
    }
  }

  const parsed = _parseToolCall(allText);
  if (parsed) {
    const [thinking, name, args] = parsed;
    return [thinking, [name, args]];
  }
  return [allText, null];
}

// ─── Core Search ───────────────────────────────────────────

// Max safe tree size in bytes (server payload limit ~346KB, fixed overhead ~26KB,
// leave room for conversation accumulation across rounds)
const MAX_TREE_BYTES = 250 * 1024;

// Repo map is expensive on large monorepos; short TTL cache keeps multi-query
// sessions snappy without serving a stale tree forever.
const REPO_MAP_CACHE_TTL_MS = Math.max(
  0,
  Number.parseInt(process.env.LOCUS_REPO_MAP_CACHE_MS || "45000", 10) || 45000
);
const _repoMapCache = new Map();

/**
 * Convert an exclude pattern (directory/file name or simple glob) to RegExp
 * for tree-node-cli's exclude option.
 * @param {string} pattern - e.g. "node_modules", "dist", "*.min.*"
 * @returns {RegExp}
 */
function _excludePatternToRegex(pattern) {
  if (!/[*?]/.test(pattern)) {
    // Simple name — exact match
    return new RegExp("^" + pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$");
  }
  // Glob → regex
  let regex = "^";
  for (const c of pattern) {
    if (c === "*") regex += ".*";
    else if (c === "?") regex += ".";
    else if (".+^${}()|[]\\".includes(c)) regex += "\\" + c;
    else regex += c;
  }
  regex += "$";
  return new RegExp(regex);
}

/**
 * Get a directory tree of the project with adaptive depth fallback.
 *
 * Tries the requested depth first. If the tree output exceeds MAX_TREE_BYTES,
 * automatically falls back to lower depths until it fits.
 *
 * @param {string} projectRoot
 * @param {number} [targetDepth=3] - Desired tree depth (1-6)
 * @param {string[]} [excludePaths=[]] - Patterns to exclude from tree
 * @returns {{ tree: string, depth: number, sizeBytes: number, fellBack: boolean }}
 */
function getRepoMap(projectRoot, targetDepth = 3, excludePaths = []) {
  const resolvedRoot = resolve(projectRoot);
  const excludeKey = Array.isArray(excludePaths) ? excludePaths.slice().sort().join("\0") : "";
  const cacheKey = `${resolvedRoot}|${targetDepth}|${excludeKey}`;
  if (REPO_MAP_CACHE_TTL_MS > 0) {
    const hit = _repoMapCache.get(cacheKey);
    if (hit && hit.expiresAt > Date.now()) {
      return hit.value;
    }
  }

  const rootPattern = new RegExp(resolvedRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
  const dirName = resolvedRoot.split("/").pop() || resolvedRoot.split("\\").pop() || resolvedRoot;
  const excludeRegexes = excludePaths.length ? excludePaths.map(_excludePatternToRegex) : [];

  const store = (value) => {
    if (REPO_MAP_CACHE_TTL_MS > 0) {
      _repoMapCache.set(cacheKey, { expiresAt: Date.now() + REPO_MAP_CACHE_TTL_MS, value });
      // Soft bound: avoid unbounded growth across many projects.
      if (_repoMapCache.size > 32) {
        const oldest = _repoMapCache.keys().next().value;
        _repoMapCache.delete(oldest);
      }
    }
    return value;
  };

  for (let L = targetDepth; L >= 1; L--) {
    try {
      const opts = { maxDepth: L };
      if (excludeRegexes.length) opts.exclude = excludeRegexes;
      const stdout = treeNodeCli(resolvedRoot, opts);
      // tree-node-cli outputs basename as root line; replace with /codebase
      let treeStr = stdout.replace(rootPattern, "/codebase");
      // Also replace the basename root line (first line) if full path wasn't matched
      const lines = treeStr.split("\n");
      if (lines[0] === dirName) {
        lines[0] = "/codebase";
        treeStr = lines.join("\n");
      }
      const sizeBytes = Buffer.byteLength(treeStr, "utf-8");

      if (sizeBytes <= MAX_TREE_BYTES) {
        return store({ tree: treeStr, depth: L, sizeBytes, fellBack: L < targetDepth });
      }
      // Too large, try lower depth
    } catch {
      // tree failed at this level, try lower
    }
  }

  // Ultimate fallback: simple ls (also respects excludePaths)
  try {
    let entries = readdirSync(resolvedRoot).sort();
    if (excludeRegexes.length) {
      entries = entries.filter((e) => !excludeRegexes.some((rx) => rx.test(e)));
    }
    const treeStr = ["/codebase", ...entries.map((e) => `├── ${e}`)].join("\n");
    return store({ tree: treeStr, depth: 0, sizeBytes: Buffer.byteLength(treeStr, "utf-8"), fellBack: true });
  } catch {
    const treeStr = "/codebase\n(empty or inaccessible)";
    return store({ tree: treeStr, depth: 0, sizeBytes: treeStr.length, fellBack: true });
  }
}

/**
 * Parse answer XML into structured file + range data.
 * @param {string} xmlText
 * @param {string} projectRoot
 * @returns {{ files: Array }}
 */
function _parseAnswer(xmlText, projectRoot) {
  const files = [];
  const resolvedRoot = resolve(projectRoot);
  const fileRegex = /<file\s+path=(["'])([^"']+)\1>([\s\S]*?)<\/file>/g;
  let fm;
  while ((fm = fileRegex.exec(xmlText)) !== null) {
    const vpath = fm[2];
    let rel = vpath.replace(/^\/codebase[\/\\]?/, "");
    rel = rel.replace(/^[\/\\]+/, "");

    // Path safety: reject traversal attempts (../) and paths outside project root
    const fullPath = resolve(projectRoot, rel);
    const relToRoot = relative(resolvedRoot, fullPath);
    if (relToRoot === ".." || relToRoot.startsWith(`..${sep}`) || isAbsolute(relToRoot)) {
      continue;
    }

    const ranges = [];
    const rangeRegex = /<range>(\d+)-(\d+)<\/range>/g;
    let rm;
    while ((rm = rangeRegex.exec(fm[3])) !== null) {
      ranges.push([parseInt(rm[1], 10), parseInt(rm[2], 10)]);
    }

    files.push({ path: rel, full_path: fullPath, ranges });
  }
  return { files };
}

function normalizeEvidencePath(projectRoot, inputPath) {
  if (typeof inputPath !== "string" || !inputPath.trim()) return null;
  const root = resolve(projectRoot);
  const raw = inputPath.trim();
  const withoutVirtualRoot = raw
    .replace(/^[/\\]codebase(?:[/\\]|$)/i, "")
    .replace(/^[\\/]+/, "");
  const fullPath = /^[/\\]codebase(?:[/\\]|$)/i.test(raw)
    ? resolve(root, withoutVirtualRoot)
    : resolve(root, raw);
  const rel = relative(root, fullPath);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  try {
    if (!statSync(fullPath).isFile()) return null;
  } catch {
    return null;
  }
  return {
    path: rel.replace(/\\/g, "/"),
    full_path: fullPath,
  };
}

function commandResultBlock(results, key) {
  const marker = String(key).replace(/[^A-Za-z0-9_-]/g, "");
  const match = String(results || "").match(
    new RegExp(`<${marker}_result>\\n?([\\s\\S]*?)\\n?<\\/${marker}_result>`),
  );
  return match ? match[1].trim() : "";
}

function toolContinuationIdentity(command) {
  if (!command || typeof command !== "object") return "invalid";
  switch (command.type) {
    case "rg":
      return JSON.stringify([
        "rg",
        command.pattern || "",
        command.path || "",
        command.include || [],
        command.exclude || [],
      ]);
    case "readfile":
      return JSON.stringify(["readfile", command.file || ""]);
    case "tree":
      return JSON.stringify(["tree", command.path || "", Number.parseInt(command.levels, 10) || 0]);
    case "ls":
      return JSON.stringify(["ls", command.path || "", Boolean(command.long_format), Boolean(command.all)]);
    case "glob":
      return JSON.stringify(["glob", command.pattern || "", command.path || "", command.type_filter || "all"]);
    default:
      return JSON.stringify([String(command.type || "unknown")]);
  }
}

function toolContinuationRequestKey(command, position) {
  const field = command?.type === "readfile" ? "start_line" : "result_offset";
  return `${toolContinuationIdentity(command)}|${field}=${position}`;
}

/**
 * Track continuation pages emitted by restricted_exec. A successful request
 * consumes its matching pending page; a new marker registers the next page.
 */
export function updatePendingToolContinuations(pending, toolArgs, toolResults) {
  if (!(pending instanceof Set)) throw new TypeError("pending continuations must be a Set");
  for (const key of Object.keys(toolArgs || {}).filter((name) => name.startsWith("command")).sort()) {
    const command = toolArgs[key];
    if (!command || typeof command !== "object") continue;
    const output = commandResultBlock(toolResults, key);
    if (!output || /^Error:/i.test(output)) continue;

    const currentPosition = command.type === "readfile"
      ? Math.max(1, Number.parseInt(command.start_line, 10) || 1)
      : Math.max(0, Number.parseInt(command.result_offset, 10) || 0);
    pending.delete(toolContinuationRequestKey(command, currentPosition));

    const marker = output.match(/^\[continuation\].*$/m)?.[0] || "";
    const nextResultOffset = marker.match(/next_result_offset=(\d+)/)?.[1];
    const nextStartLine = marker.match(/next_start_line=(\d+)/)?.[1];
    if (nextResultOffset != null) {
      pending.add(toolContinuationRequestKey(command, Number.parseInt(nextResultOffset, 10)));
    }
    if (nextStartLine != null) {
      pending.add(toolContinuationRequestKey(command, Number.parseInt(nextStartLine, 10)));
    }
  }
  return pending;
}

/**
 * Convert successfully executed readfile/rg commands into deterministic file
 * evidence. This preserves useful hits when the model's final ANSWER call is
 * missing or malformed.
 */
export function recoverFilesFromToolEvidence(toolArgs, toolResults, projectRoot, opts = {}) {
  const byPath = new Map();
  const add = (inputPath, start, end, source) => {
    const normalized = normalizeEvidencePath(projectRoot, inputPath);
    if (!normalized) return;
    const key = normalizeRelKey(normalized.path);
    const safeStart = Math.max(1, Number.parseInt(start, 10) || 1);
    const safeEnd = Math.max(safeStart, Number.parseInt(end, 10) || safeStart);
    const prev = byPath.get(key) || {
      ...normalized,
      ranges: [],
      sources: [],
    };
    if (!prev.ranges.some(([a, b]) => a === safeStart && b === safeEnd)) {
      prev.ranges.push([safeStart, safeEnd]);
    }
    if (!prev.sources.includes(source)) prev.sources.push(source);
    byPath.set(key, prev);
  };

  for (const key of Object.keys(toolArgs || {}).filter((k) => k.startsWith("command")).sort()) {
    const command = toolArgs[key];
    const output = commandResultBlock(toolResults, key);
    if (!command || !output || /^Error:/i.test(output)) continue;

    if (command.type === "readfile") {
      const lineNumbers = [...output.matchAll(/^(\d+):/gm)].map((m) => Number.parseInt(m[1], 10));
      const start = lineNumbers[0] || command.start_line || 1;
      const end = lineNumbers.at(-1) || start;
      // Pagination markers are metadata; only visible line-numbered content is verified.
      add(command.file, start, end, "verified-read");
      continue;
    }

    if (command.type === "rg" && output !== "(no matches)") {
      for (const line of output.split(/\r?\n/)) {
        const match = line.match(/^(.+?):(\d+):/);
        if (match) {
          // A bare matched line is nearly context-free as a final result;
          // widen to a ±15 window so fallback answers carry usable context.
          const hit = Number.parseInt(match[2], 10);
          add(match[1], Math.max(1, hit - 15), hit + 15, "verified-rg");
        }
      }
    }
  }

  const mergeRanges = (ranges) => {
    const sorted = [...ranges].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const merged = [];
    for (const [s, e] of sorted) {
      const last = merged.at(-1);
      if (last && s <= last[1] + 1) {
        last[1] = Math.max(last[1], e);
      } else {
        merged.push([s, e]);
      }
    }
    return merged;
  };

  const includeAllRanges = opts.includeAllRanges
    || opts.exhaustive
    || opts.resultMode === "complete";
  const requestedLimit = Math.max(1, Number.parseInt(opts.maxRanges ?? 8, 10) || 8);
  const rangeLimit = includeAllRanges ? Number.POSITIVE_INFINITY : requestedLimit;
  return [...byPath.values()].map((entry) => ({
    ...entry,
    // Merge overlapping windows first so the cap keeps distinct evidence,
    // not eight fragments of the same block.
    ranges: mergeRanges(entry.ranges).slice(0, rangeLimit),
  }));
}

/**
 * Execute Locus MCP search.
 *
 * @param {Object} opts
 * @param {string} opts.query - Natural language search query
 * @param {string} opts.projectRoot - Project root directory
 * @param {string} [opts.apiKey] - Windsurf API key (auto-discovered if not set)
 * @param {string} [opts.jwt] - JWT token (auto-fetched if not set)
 * @param {number} [opts.maxTurns=3] - Search rounds
 * @param {number} [opts.maxCommands=8] - Max commands per round
 * @param {number} [opts.maxResults=10] - Max number of files to return
 * @param {number} [opts.treeDepth=3] - Directory tree depth for repo map (1-6, auto fallback)
 * @param {number} [opts.timeoutMs=30000] - Connect-Timeout-Ms for streaming requests
 * @param {string[]} [opts.excludePaths=[]] - Patterns to exclude from tree
 * @param {Object|null} [opts.graphProvider=null] - Optional local graph provider
 * @param {boolean} [opts.graphHintsEnabled=false] - Enable local graph hints when a provider is present
 * @param {Object|null} [opts.hybridProvider=null] - Locus native hybrid search provider
 * @param {boolean} [opts.hybridHintsEnabled=false] - Seed Devstral with native hybrid candidates
 * @param {function} [opts.onProgress] - Progress callback
 * @returns {Promise<Object>}
 */

/**
 * Shrink multi-turn budget when local radars already have strong candidates.
 * Remote Devstral still verifies, but rarely needs 3+ rounds after high-confidence seeds.
 * @param {number} maxTurns
 * @param {{ meta?: Object, result?: Object|null }} graphHints
 * @param {{ meta?: Object, result?: Object|null }} hybridHints
 * @returns {{ maxTurns: number, reasons: string[] }}
 */
/**
 * LOCUS_LOCAL_FIRST: auto | on | off
 * auto  - skip remote Devstral when local radars are high-confidence
 * on    - skip remote whenever any usable radar has medium+ signal
 * off   - always run remote (legacy)
 */
export function resolveLocalFirstMode(raw = process.env.LOCUS_LOCAL_FIRST) {
  const v = String(raw ?? "auto").trim().toLowerCase();
  if (["0", "false", "no", "off", "disabled"].includes(v)) return "off";
  if (["1", "true", "yes", "on", "force"].includes(v)) return "on";
  return "auto";
}

/**
 * LOCUS_SPEED_PROFILE: quality | balanced | fast
 * Controls how aggressively local radars may skip remote Devstral.
 * balanced (default): high local confidence skips remote (speed + quality).
 * quality: fewer skips — more remote verification.
 * fast: skip more often (Hybrid/Graph medium+); complex still remote unless dual-strong.
 */
export function resolveSpeedProfile(raw = process.env.LOCUS_SPEED_PROFILE) {
  const v = String(raw ?? "balanced").trim().toLowerCase();
  if (["quality", "thorough", "strict", "high"].includes(v)) return "quality";
  if (["fast", "aggressive", "speed", "quick"].includes(v)) return "fast";
  return "balanced";
}

function normalizeRelKey(p) {
  return String(p || "").replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase();
}

function topAndSecondScores(hybridHints) {
  const files = hybridHints?.result?.files || [];
  const top =
    typeof hybridHints?.meta?.topScore === "number"
      ? hybridHints.meta.topScore
      : (files[0]?.score ?? 0);
  const second = files.length > 1 ? Number(files[1]?.score ?? 0) : 0;
  return {
    top: Number.isFinite(top) ? top : 0,
    second: Number.isFinite(second) ? second : 0,
    margin: (Number.isFinite(top) ? top : 0) - (Number.isFinite(second) ? second : 0),
    count: files.length,
  };
}

/**
 * Thresholds for local-first decisions by speed profile.
 */
export function localFirstThresholds(profile = "balanced") {
  switch (profile) {
    case "fast":
      return { strong: 0.55, ok: 0.30, marginTop: 0.45, margin: 0.10 };
    case "quality":
      return { strong: 0.75, ok: 0.40, marginTop: 0.62, margin: 0.18 };
    default:
      // strong sits above the hybrid provider's "high" confidence cut (0.7):
      // the hybrid score is purely lexical (0.18 floor + coverage-dominated),
      // so moderate keyword overlap must not skip remote verification.
      return { strong: 0.72, ok: 0.32, marginTop: 0.48, margin: 0.10 };
  }
}

function graphSignalQuality(graphHints, speedProfile = "balanced") {
  const meta = graphHints?.meta || {};
  const coverage = clampScore(meta.queryCoverage);
  const matched = Math.max(0, Number(meta.matchedTermCount) || 0);
  const total = Math.max(0, Number(meta.queryTermCount) || 0);
  const strongFloor = speedProfile === "quality" ? 0.62 : speedProfile === "fast" ? 0.45 : 0.48;
  const mediumFloor = speedProfile === "quality" ? 0.36 : 0.28;
  const enoughStrongTerms = total <= 1 ? matched >= 1 : matched >= 2;
  return {
    coverage,
    matched,
    total,
    strong: Boolean(meta.used && meta.confidence === "high" && coverage >= strongFloor && enoughStrongTerms),
    medium: Boolean(
      meta.used &&
      ["high", "medium"].includes(meta.confidence) &&
      coverage >= mediumFloor &&
      matched >= 1
    ),
  };
}

function hybridSignalQuality(hybridHints) {
  const meta = hybridHints?.meta || {};
  const coverage = clampScore(meta.queryCoverage);
  const matched = Math.max(0, Number(meta.matchedTermCount) || 0);
  const total = Math.max(0, Number(meta.queryTermCount) || 0);
  const relevantFloor = total <= 1 ? 0.5 : 0.2;
  const strongFloor = total <= 1 ? 0.75 : 0.35;
  return {
    coverage,
    matched,
    total,
    relevant: Boolean(meta.used && matched >= 1 && coverage >= relevantFloor),
    strong: Boolean(meta.used && matched >= (total <= 1 ? 1 : 2) && coverage >= strongFloor),
  };
}

/**
 * CJK-dominant queries (no ASCII identifier anchor) score unreliably in the
 * local graph/hybrid rankers — tokenization is identifier-oriented and CJK
 * support is bigram-only (§3.8). Word-surface confidence on such queries must
 * not be allowed to skip remote verification.
 * @param {string} query
 * @returns {boolean}
 */
export function isCjkDominantQuery(query) {
  const text = String(query || "");
  const han = (text.match(/\p{Script=Han}/gu) || []).length;
  const identifiers = (text.match(/[A-Za-z_$][A-Za-z0-9_$]{2,}/g) || []).length;
  return han >= 4 && identifiers === 0;
}

/**
 * Decide whether local Graph/Hybrid hits are strong enough to skip remote multi-turn.
 * @returns {{ skip: boolean, reasons: string[] }}
 */
export function decideLocalFirst({
  mode = "auto",
  routeKind = "semantic",
  query = "",
  graphHints = null,
  hybridHints = null,
  vectorHints = null,
  speedProfile = resolveSpeedProfile(),
} = {}) {
  if (mode === "off") return { skip: false, reasons: ["local-first-off"] };
  // 中文为主的查询：本地信号可靠性打折（词法/向量对中文都弱），仅当双雷达
  // 强一致（radar-agree）时才允许本地直出，否则保留远程验证轮。
  // query-bridge 注入的英文桥接词让这种强一致在中文题上真正可达。
  const cjkStrict = mode !== "on" && isCjkDominantQuery(query);

  const thr = localFirstThresholds(speedProfile);
  const gMeta = graphHints?.meta || null;
  const hMeta = hybridHints?.meta || null;
  const { top: topHybrid, margin, count: hybridCount } = topAndSecondScores(hybridHints);
  const graphPath = gMeta?.topPath || graphHints?.result?.files?.[0]?.path || null;
  const hybridPath = hMeta?.topPath || hybridHints?.result?.files?.[0]?.path || null;
  const reasons = [`speed=${speedProfile}`];
  const graphQuality = graphSignalQuality(graphHints, speedProfile);
  const hybridQuality = hybridSignalQuality(hybridHints);

  const pathsAgree =
    Boolean(gMeta?.used && hMeta?.used && graphPath && hybridPath) &&
    normalizeRelKey(graphPath) === normalizeRelKey(hybridPath);
  // 向量雷达（语义嵌入）与任一词法雷达同路径且双方信号都够强，同样构成
  // "双雷达强一致"——这是中文题（经桥接）拿到本地直出资格的主通道。
  const vectorTopFile = vectorHints?.result?.files?.[0] || null;
  const vectorPath = vectorTopFile?.path || null;
  const vectorStrong = Boolean(vectorHints?.meta?.used && vectorTopFile && vectorTopFile.score >= 0.62);
  const vectorAgreesGraph = Boolean(
    vectorStrong && graphPath && vectorPath &&
    normalizeRelKey(vectorPath) === normalizeRelKey(graphPath) &&
    (graphQuality.strong || graphQuality.medium),
  );
  const vectorAgreesHybrid = Boolean(
    vectorStrong && hybridPath && vectorPath &&
    normalizeRelKey(vectorPath) === normalizeRelKey(hybridPath) &&
    hybridQuality.relevant,
  );
  const radarAgree = (pathsAgree && graphQuality.strong && hybridQuality.relevant)
    || vectorAgreesGraph
    || vectorAgreesHybrid;
  if (radarAgree) {
    reasons.push(vectorAgreesGraph || vectorAgreesHybrid ? "radar-agree-vector" : "radar-agree");
  } else if (pathsAgree) {
    reasons.push("radar-agree-weak");
  }

  const graphHigh = graphQuality.strong;
  if (graphHigh) reasons.push("graph-high");

  const graphMedium = graphQuality.medium && !graphHigh;
  if (graphMedium) reasons.push("graph-medium");

  const hybridStrong = Boolean(hybridQuality.strong && topHybrid >= thr.strong);
  if (hybridStrong) reasons.push("hybrid-strong:" + topHybrid.toFixed(2));

  const hybridOk = Boolean(hybridQuality.relevant && topHybrid >= thr.ok);
  if (hybridOk && !hybridStrong) reasons.push("hybrid-ok:" + topHybrid.toFixed(2));

  const clearWinner = Boolean(
    hybridQuality.relevant &&
    topHybrid >= thr.marginTop &&
    (hybridCount <= 1 || margin >= thr.margin),
  );
  if (clearWinner) reasons.push(`hybrid-margin:${margin.toFixed(2)}`);

  if (mode === "on") {
    const skip = graphHigh || graphMedium || hybridOk || radarAgree || clearWinner;
    return { skip, reasons: skip ? reasons : ["local-weak"] };
  }

  // auto: skip remote when local verification risk is low
  let skip = false;
  if (radarAgree && ["semantic", "symbol", "exact"].includes(routeKind)) skip = true;
  // Balanced/fast: high-confidence graph alone can serve semantic locate too.
  if (graphHigh && ["symbol", "exact", "impact"].includes(routeKind)) skip = true;
  if (graphHigh && routeKind === "semantic" && speedProfile !== "quality") {
    skip = true;
    reasons.push("graph-high-semantic");
  }
  // Strong native hybrid signal alone can satisfy focused locate routes.
  if (hybridStrong && ["semantic", "symbol"].includes(routeKind)) skip = true;
  if (graphHigh && hybridOk) skip = true;
  // Dual medium-strength local signals: skip remote verification on locate routes.
  if (
    speedProfile !== "quality"
    && ["semantic", "symbol"].includes(routeKind)
    && (graphHigh || graphMedium)
    && hybridOk
  ) {
    skip = true;
    reasons.push("graph-hybrid-ok");
  }
  // clear winner is a speed shortcut — not used in quality profile
  if (speedProfile !== "quality" && clearWinner && ["semantic", "symbol", "exact"].includes(routeKind)) skip = true;

  // 中文严格模式：任何单雷达信号都不足以豁免远程，必须双雷达同路径强一致。
  if (cjkStrict && skip && !radarAgree) {
    skip = false;
    reasons.push("cjk-needs-radar-agree");
  } else if (cjkStrict && skip) {
    reasons.push("cjk-radar-agree-pass");
  }

  // complex: keep remote unless dual agreement / dual strength
  if (routeKind === "complex") {
    skip =
      radarAgree ||
      (graphHigh && hybridOk) ||
      (speedProfile === "fast" && graphHigh && hybridQuality.relevant);
  }

  return { skip, reasons: skip ? reasons : [...reasons, "local-weak"] };
}

const LOCAL_RRF_K = 12;
const LOCAL_RADAR_WEIGHTS = Object.freeze({ graph: 1.05, hybrid: 1, vector: 0.92 });

function clampScore(value) {
  const score = Number(value);
  return Number.isFinite(score) ? Math.max(0, Math.min(1, score)) : 0;
}

export function mergeCandidateRanges(ranges, maxRanges = 4) {
  const sorted = (ranges || [])
    .filter((range) => (
      Array.isArray(range) &&
      Number.isInteger(range[0]) &&
      Number.isInteger(range[1]) &&
      range[0] >= 1 &&
      range[1] >= range[0]
    ))
    .map(([start, end]) => [start, end])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  const merged = [];
  for (const [start, end] of sorted) {
    const previous = merged[merged.length - 1];
    if (!previous || start > previous[1] + 5) merged.push([start, end]);
    else previous[1] = Math.max(previous[1], end);
    if (merged.length >= maxRanges) break;
  }
  return merged.length ? merged : [[1, 1]];
}

function localPathRoleMultiplier(path, query = "") {
  const normalizedPath = normalizeRelKey(path);
  const text = String(query || "").toLowerCase();
  const asksForSupportingFiles = /\b(test|tests|spec|script|scripts|fixture|benchmark|docs?|documentation)\b/i.test(text)
    || /测试|脚本|基准|文档/.test(text);
  const supportingPath = /(^|\/)(scripts?|tests?|__tests__|fixtures?|benchmarks?|docs?)(\/|$)/.test(normalizedPath)
    || /\.(test|spec)\.[^.]+$/.test(normalizedPath);
  if (supportingPath && !asksForSupportingFiles) return 0.68;
  if (/^(src|app|lib|pkg|packages)\//.test(normalizedPath)) return 1.08;
  return 1;
}

/**
 * Dynamic result cutoff with a minimum-result safe harbor. Scores are expected
 * to be normalized to 0..1, but defensive sorting/clamping keeps it reusable.
 */
export function smartTopKCandidates(candidates, maxResults = 10, opts = {}) {
  const limit = Math.max(1, Number.parseInt(maxResults, 10) || 1);
  const sorted = [...(candidates || [])]
    .sort((a, b) => clampScore(b.score) - clampScore(a.score) || a.path.localeCompare(b.path));
  if (!sorted.length) return [];

  const floor = clampScore(opts.floor ?? 0.08);
  const ratio = clampScore(opts.ratio ?? 0.52);
  const delta = clampScore(opts.delta ?? 0.35);
  const minK = Math.min(limit, Math.max(1, Number.parseInt(opts.minK ?? 3, 10) || 1));
  const topScore = clampScore(sorted[0].score);
  if (topScore < floor) return sorted.slice(0, 1);

  const threshold = Math.max(floor, Math.min(topScore * ratio, topScore - delta));
  const selected = [];
  for (const candidate of sorted) {
    if (selected.length >= limit) break;
    const score = clampScore(candidate.score);
    if (selected.length < minK) {
      if (score < floor) break;
      selected.push(candidate);
      continue;
    }
    if (score < threshold) break;
    selected.push(candidate);
  }
  return selected;
}

/**
 * Merge Graph and native Hybrid candidates by weighted reciprocal rank. Provider score scales
 * stay local to each source; agreement naturally receives two contributions.
 */
export function mergeLocalRadarFiles(graphHints, hybridHints, maxResults = 10, smartTopKOpts = {}, vectorHints = null) {
  const byPath = new Map();
  const sourceRows = [
    ["graph", graphHints?.result?.files || [], graphHints?.meta?.used],
    ["hybrid", hybridHints?.result?.files || [], hybridHints?.meta?.used],
    ["vector", vectorHints?.result?.files || [], vectorHints?.meta?.used],
  ].filter(([, files, used]) => (
    files.length > 0 && (smartTopKOpts.resultMode === "complete" || used !== false)
  ));

  for (const [source, files] of sourceRows) {
    const sourceTopScore = Math.max(0, ...files.map((file) => clampScore(file.score)));
    const seenInSource = new Set();
    for (let rank = 0; rank < files.length; rank++) {
      const file = files[rank];
      if (!file?.path) continue;
      const key = normalizeRelKey(file.path);
      const ranges = Number.isInteger(file.startLine) && Number.isInteger(file.endLine)
        ? [[file.startLine, file.endLine]]
        : file.ranges || [];
      let entry = byPath.get(key);
      if (!entry) {
        entry = {
          path: String(file.path).replace(/\\/g, "/"),
          ranges: [],
          symbols: [],
          sources: [],
          sourceRanks: {},
          sourceScores: {},
          role: file.role || null,
          evidence: file.evidence || null,
          fusionScore: 0,
        };
        byPath.set(key, entry);
      }

      if (!entry.role && file.role) entry.role = file.role;
      if (!entry.evidence && file.evidence) entry.evidence = file.evidence;

      entry.ranges.push(...ranges);
      for (const symbol of file.symbols || []) {
        if (!entry.symbols.includes(symbol) && (smartTopKOpts.includeAllRanges || entry.symbols.length < 8)) {
          entry.symbols.push(symbol);
        }
      }
      for (const field of ["matchedTerms", "clauseMatches", "rankSources"]) {
        if (!file[field]?.length) continue;
        entry[field] ||= [];
        for (const value of file[field]) {
          if (!entry[field].includes(value)) entry[field].push(value);
        }
      }
      if (file.clauseRanks) entry.clauseRanks = { ...(entry.clauseRanks || {}), ...file.clauseRanks };
      if (seenInSource.has(key)) continue;
      seenInSource.add(key);

      const weight = LOCAL_RADAR_WEIGHTS[source] || 1;
      const normalizedProviderScore = sourceTopScore > 0
        ? clampScore(file.score) / sourceTopScore
        : 0;
      const rankSignal = 1 / (LOCAL_RRF_K + rank + 1);
      const relevanceSignal = normalizedProviderScore / (LOCAL_RRF_K + 1);
      entry.fusionScore += weight * (rankSignal * 0.8 + relevanceSignal * 0.2);
      entry.sources.push(source);
      entry.sourceRanks[source] = rank + 1;
      entry.sourceScores[source] = clampScore(file.score);
    }
  }

  const ranked = [...byPath.values()]
    .map((entry) => {
      if (entry.sources.length > 1) entry.fusionScore += 0.15 / (LOCAL_RRF_K + 1);
      entry.fusionScore *= localPathRoleMultiplier(entry.path, smartTopKOpts.query);
      entry.ranges = mergeCandidateRanges(
        entry.ranges,
        smartTopKOpts.includeAllRanges ? Number.POSITIVE_INFINITY : 4,
      );
      return entry;
    })
    .sort((a, b) => b.fusionScore - a.fusionScore || a.path.localeCompare(b.path));
  const topFusionScore = ranked[0]?.fusionScore || 1;
  for (const entry of ranked) {
    entry.score = clampScore(entry.fusionScore / topFusionScore);
    delete entry.fusionScore;
  }

  return rankAndSelectFiles(ranked, {
    ...smartTopKOpts,
    query: smartTopKOpts.query || "",
    maxResults,
    confidence: graphHints?.result?.confidence || "medium",
    edges: graphHints?.result?.edges || [],
  });
}

/** Merge remote synthesis with the full local radar pool without dropping either tail. */
export function mergeCompleteCandidateFiles(remoteFiles, localFiles, projectRoot, query = "") {
  const candidates = [];
  for (const [source, files] of [["remote", remoteFiles || []], ["local", localFiles || []]]) {
    for (let index = 0; index < files.length; index++) {
      const file = files[index];
      if (!file?.path) continue;
      const path = String(file.path).replace(/\\/g, "/");
      candidates.push({
        ...file,
        path,
        full_path: file.full_path || resolve(projectRoot, path),
        ranges: file.ranges || [],
        sources: [...new Set([...(file.sources || []), source])],
        score: Number.isFinite(file.score)
          ? Number(file.score)
          : Math.max(0.2, 0.98 - index * 0.03),
      });
    }
  }
  if (!candidates.length) return [];

  const ranked = rankAndSelectFiles(candidates, {
    query,
    maxResults: candidates.length,
    exhaustive: true,
    resultMode: "complete",
  });
  return ranked.map((file) => ({
    ...file,
    full_path: file.full_path || resolve(projectRoot, file.path),
    ranges: mergeCandidateRanges(file.ranges, Number.POSITIVE_INFINITY),
  }));
}

export function summarizeSearchCoverage(graphHints, hybridHints, vectorHints) {
  const issues = [];
  const providers = {};
  for (const [name, hints] of [["graph", graphHints], ["hybrid", hybridHints], ["vector", vectorHints]]) {
    if (!hints?.meta?.enabled) continue;
    const queryDiagnostics = hints.result?.queryDiagnostics || hints.meta?.queryDiagnostics || null;
    const indexCoverage = hints.result?.indexCoverage
      || hints.result?.index?.coverage
      || hints.meta?.indexCoverage
      || hints.meta?.index?.coverage
      || null;
    const providerIssues = [];
    if (hints.meta.status === "error") providerIssues.push(`provider_error:${hints.meta.reason || "unknown"}`);
    if (queryDiagnostics?.complete === false) {
      const omitted = queryDiagnostics.omittedTerms?.length || queryDiagnostics.omittedChunks || 0;
      providerIssues.push(`query_terms_or_chunks_omitted:${omitted}`);
    }
    if (indexCoverage?.complete === false) {
      if (Array.isArray(indexCoverage.issues) && indexCoverage.issues.length) {
        providerIssues.push(...indexCoverage.issues);
      } else {
        for (const key of ["skippedByFileLimit", "skippedTooLarge", "readFailures"]) {
          if (Number(indexCoverage[key]) > 0) providerIssues.push(`${key}:${indexCoverage[key]}`);
        }
      }
      if (!providerIssues.length) providerIssues.push("index_coverage_incomplete");
    }
    providers[name] = {
      queryComplete: queryDiagnostics?.complete !== false,
      indexComplete: indexCoverage?.complete !== false,
      issues: providerIssues,
    };
    issues.push(...providerIssues.map((issue) => `${name}:${issue}`));
  }
  return { complete: issues.length === 0, issues, providers };
}


function adaptTurnsFromLocalHints(
  maxTurns,
  graphHints,
  hybridHints,
  speedProfile = resolveSpeedProfile(),
  routeKind = "semantic",
) {
  let turns = Math.max(1, Math.min(5, maxTurns));
  const reasons = [];
  const thr = localFirstThresholds(speedProfile);
  const gMeta = graphHints?.meta || null;
  const hMeta = hybridHints?.meta || null;
  const { top: topHybrid, margin } = topAndSecondScores(hybridHints);
  const graphPath = gMeta?.topPath || null;
  const hybridPath = hMeta?.topPath || null;
  const graphQuality = graphSignalQuality(graphHints, speedProfile);
  const hybridQuality = hybridSignalQuality(hybridHints);

  if (graphQuality.strong && turns > 1) {
    turns = ["symbol", "exact"].includes(routeKind) ? 1 : Math.min(turns, 2);
    reasons.push("graph-high");
  } else if (graphQuality.medium && turns > 2) {
    turns = 2;
    reasons.push("graph-medium");
  }

  if (hybridQuality.strong && topHybrid >= thr.strong && turns > 1) {
    turns = ["semantic", "symbol"].includes(routeKind) ? 1 : Math.min(turns, 2);
    reasons.push("hybrid-strong");
  } else if (hybridQuality.relevant && topHybrid >= thr.ok && turns > 2) {
    turns = 2;
    reasons.push("hybrid-ok");
  } else if (hybridQuality.relevant && topHybrid >= thr.marginTop && margin >= thr.margin && turns > 1) {
    turns = ["semantic", "symbol"].includes(routeKind) ? 1 : Math.min(turns, 2);
    reasons.push("hybrid-margin");
  }

  if (
    gMeta?.used &&
    hMeta?.used &&
    graphPath &&
    hybridPath &&
    normalizeRelKey(graphPath) === normalizeRelKey(hybridPath) &&
    graphQuality.strong &&
    hybridQuality.relevant &&
    turns > 1
  ) {
    turns = ["complex", "impact"].includes(routeKind) ? Math.min(turns, 2) : 1;
    reasons.push("radar-agree");
  }

  return { maxTurns: turns, reasons };
}

export async function search({
  query,
  projectRoot,
  apiKey = null,
  jwt = null,
  maxTurns = 3,
  maxCommands = 8,
  maxResults = 10,
  treeDepth = 3,
  timeoutMs = 30000,
  excludePaths = [],
  graphProvider = null,
  graphHintsEnabled = false,
  hybridProvider = null,
  hybridHintsEnabled = false,
  localFirstMode = resolveLocalFirstMode(),
  routeKind = "semantic",
  speedProfile = resolveSpeedProfile(),
  resultMode = "complete",
  includeAllRanges = null,
  exhaustive = null,
  onProgress = null,
}) {
  assertRelayAuthenticated();
  const searchStartedAt = Date.now();
  const log = (msg) => onProgress?.(msg);
  projectRoot = resolve(projectRoot);
  const profile = resolveSpeedProfile(speedProfile);
  const normalizedResultMode = normalizeResultMode(resultMode);
  const completeMode = normalizedResultMode === "complete";
  const exhaustiveSearch = exhaustive == null ? completeMode : Boolean(exhaustive);
  const keepAllRanges = includeAllRanges == null ? completeMode : Boolean(includeAllRanges);

  // F4: 首次检索即注册常驻监听——之后保存文件由后台增量同步图/向量索引，
  // 查询路径不再付同步成本。停用/失败时静默回退为查询时同步。
  watchProjectForIndexSync(projectRoot, { graphEnabled: graphHintsEnabled });

  const radarMaxFiles = completeMode
    ? Number.MAX_SAFE_INTEGER
    : Math.min(20, Math.max(maxResults * 2, 8));
  const graphHintsPromise = graphHintsEnabled
    ? buildGraphHintBlock({
      provider: graphProvider,
      query,
      projectRoot,
      repoMap: null,
      maxFiles: radarMaxFiles,
      exhaustive: exhaustiveSearch,
      includeAllRanges: keepAllRanges,
    })
    : Promise.resolve({ hintBlock: "", meta: null, result: null });

  const hybridHintsPromise = hybridHintsEnabled
    ? buildHybridHintBlock({
      provider: hybridProvider,
      query,
      projectRoot,
      maxFiles: radarMaxFiles,
      exhaustive: exhaustiveSearch,
      includeAllRanges: keepAllRanges,
    })
    : Promise.resolve({ hintBlock: "", meta: null, result: null });

  // 第三路向量雷达：模型缺失/LOCUS_VECTOR=off 时自行返回 unavailable，零成本。
  const vectorHintsPromise = buildVectorHintBlock({
    query,
    projectRoot,
    maxFiles: completeMode ? Number.MAX_SAFE_INTEGER : Math.min(radarMaxFiles, 8),
    exhaustive: exhaustiveSearch,
    includeAllRanges: keepAllRanges,
  });

  // Local radars first — no JWT / tree cost on the local-first hot path.
  const [graphHints, hybridHints, vectorHints] = await Promise.all([
    graphHintsPromise,
    hybridHintsPromise,
    vectorHintsPromise,
  ]);

  const localFirst = completeMode
    ? { skip: false, reasons: ["complete-mode"] }
    : decideLocalFirst({
      mode: localFirstMode,
      routeKind,
      query,
      graphHints,
      hybridHints,
      vectorHints,
      speedProfile: profile,
    });

  const completeLocalFiles = completeMode
    ? mergeLocalRadarFiles(
      graphHints,
      hybridHints,
      Number.MAX_SAFE_INTEGER,
      {
        query,
        exhaustive: exhaustiveSearch,
        resultMode: normalizedResultMode,
        includeAllRanges: keepAllRanges,
      },
      vectorHints,
    )
    : [];
  const searchCoverage = summarizeSearchCoverage(graphHints, hybridHints, vectorHints);
  const pendingToolContinuations = new Set();
  const finalizeResult = (result) => {
    if (!completeMode) return result;
    const files = mergeCompleteCandidateFiles(result?.files || [], completeLocalFiles, projectRoot, query);
    const remoteFailure = Boolean(result?.error);
    const remoteAnswerMissing = result?.remoteAnswerMissing === true;
    const remoteIssue = remoteFailure
      ? `remote_search_failed:${String(result.error).replace(/\s+/g, " ").slice(0, 160)}`
      : null;
    const remoteAnswerIssue = remoteAnswerMissing ? "remote_answer_missing" : null;
    const continuationIssue = pendingToolContinuations.size
      ? `remote_tool_continuations_unconsumed:${pendingToolContinuations.size}`
      : null;
    const remoteIssues = [remoteIssue, remoteAnswerIssue, continuationIssue].filter(Boolean);
    const coverage = remoteIssues.length
      ? {
        ...searchCoverage,
        complete: false,
        issues: [...new Set([...(searchCoverage.issues || []), ...remoteIssues])],
        providers: {
          ...(searchCoverage.providers || {}),
          remote: { queryComplete: false, indexComplete: true, issues: remoteIssues },
        },
      }
      : searchCoverage;
    const base = remoteFailure && files.length > 0
      ? (({ error, ...rest }) => ({ ...rest, remoteError: error }))(result)
      : result;
    return {
      ...base,
      files,
      resultMode: normalizedResultMode,
      coverage,
      _meta: {
        ...(base?._meta || {}),
        resultMode: normalizedResultMode,
        coverage,
        ...(remoteFailure ? { remoteError: result.error } : {}),
        pendingToolContinuations: pendingToolContinuations.size,
      },
    };
  };

  // Local radars can shrink remote multi-turn budget (speed without dropping verify).
  const turnAdapt = adaptTurnsFromLocalHints(maxTurns, graphHints, hybridHints, profile, routeKind);
  const effectiveMaxTurns = completeMode ? maxTurns : turnAdapt.maxTurns;

  if (localFirst.skip) {
    const recallSensitive = ["complex", "impact", "exact"].includes(routeKind) || profile === "quality";
    const merged = mergeLocalRadarFiles(
      graphHints,
      hybridHints,
      maxResults,
      recallSensitive
        ? { minK: Math.min(5, maxResults), ratio: 0.42, delta: 0.45, query }
        : { query },
      vectorHints,
    );
    if (merged.length) {
      log("Local-first hit: skip remote (" + localFirst.reasons.join(",") + ") files=" + merged.length);
      const files = merged.map((f) => ({
        path: f.path,
        full_path: resolve(projectRoot, f.path),
        ranges: f.ranges?.length ? f.ranges : [[1, 1]],
        score: f.score,
        sources: f.sources,
        symbols: f.symbols,
        role: f.role,
        ownerScore: f.ownerScore,
        evidence: f.evidence,
      }));
      const composition = summarizeResultComposition(files);
      reportLocalSearchEvent({
        durationMs: Date.now() - searchStartedAt,
        resultCount: files.length,
        routeKind,
        speedProfile: profile,
        sources: files.flatMap((file) => file.sources || []),
        localFirst: true,
        recoveredFromEvidence: false,
        ownerCount: composition.ownerCount,
        relatedCount: composition.relatedCount,
        query,
      });
      return finalizeResult({
        files,
        rg_patterns: [],
        localFirst: true,
        localFirstReasons: localFirst.reasons,
        _meta: {
          treeDepth: 0,
          treeSizeKB: 0,
          fellBack: false,
          localFirst: true,
          localFirstReasons: localFirst.reasons,
          maxTurns: 0,
          maxTurnsRequested: maxTurns,
          metrics: {
            apiCalls: 0,
            toolCalls: 0,
            localCommands: 0,
            validLocalCommands: 0,
            compensatedTurns: 0,
            finalTurn: 0,
            commandTypes: {},
          },
          graph: graphHints.meta || null,
          hybrid: hybridHints.meta || null,
          vector: vectorHints.meta || null,
          turnAdapt: turnAdapt.reasons,
          speedProfile: profile,
        },
      });
    }
    log("Local-first eligible but empty merge; falling back to remote (" + localFirst.reasons.join(",") + ")");
  }

  // Get credentials only when remote path is needed.
  try {
    if (!apiKey) apiKey = await getApiKey();
  } catch (error) {
    if (!completeMode) throw error;
    return finalizeResult({
      files: [],
      error: `credential_error: ${error?.message || String(error)}`,
      _meta: { projectRoot, credentialError: true },
    });
  }

  let jwtPromise = null;
  if (!jwt) {
    log("Fetching JWT...");
    jwtPromise = getCachedJwt(apiKey);
  }

  // 传入 excludePaths：模型下发的 tree/glob 不再遍历 node_modules 等排除目录
  const executor = new ToolExecutor(projectRoot, { excludes: excludePaths });
  const verifiedEvidence = new Map();
  const rememberEvidence = (entries) => {
    for (const entry of entries || []) {
      const key = normalizeRelKey(entry.path);
      const prev = verifiedEvidence.get(key);
      if (!prev) {
        verifiedEvidence.set(key, { ...entry, ranges: [...(entry.ranges || [])], sources: [...(entry.sources || [])] });
        continue;
      }
      for (const range of entry.ranges || []) {
        if (!prev.ranges.some(([a, b]) => a === range[0] && b === range[1])) prev.ranges.push(range);
      }
      for (const source of entry.sources || []) {
        if (!prev.sources.includes(source)) prev.sources.push(source);
      }
    }
  };
  const toolDefs = getToolDefinitions(maxCommands);

  // Overlap JWT wait with repo-map generation (CPU-bound tree walk).
  const { tree: repoMap, depth: actualDepth, sizeBytes: treeSizeBytes, fellBack } = getRepoMap(
    projectRoot,
    treeDepth,
    excludePaths
  );
  log("Repo map: tree -L " + actualDepth + " (" + (treeSizeBytes / 1024).toFixed(1) + "KB)" + (fellBack ? " [fell back from L=" + treeDepth + "]" : ""));

  if (jwtPromise) {
    try {
      jwt = await jwtPromise;
    } catch (error) {
      if (!completeMode) throw error;
      return finalizeResult({
        files: [],
        error: `jwt_error: ${error?.message || String(error)}`,
        _meta: { projectRoot, jwtError: true },
      });
    }
  }

  if (!RELAY_MODE) {
    log("Checking rate limit...");
    let rateLimitAvailable;
    try {
      rateLimitAvailable = await checkRateLimit(apiKey, jwt);
    } catch (error) {
      if (!completeMode) throw error;
      return finalizeResult({
        files: [],
        error: `rate_limit_check_error: ${error?.message || String(error)}`,
        _meta: { projectRoot, rateLimitCheckError: true },
      });
    }
    if (!rateLimitAvailable) {
      return finalizeResult({
        files: [],
        error: "Rate limited, please try again later",
        _meta: { projectRoot, rateLimited: true },
      });
    }
  }

  const systemPrompt = buildSystemPrompt(
    effectiveMaxTurns,
    maxCommands,
    maxResults,
    normalizedResultMode,
  );

  if (graphHints.meta?.enabled) {
    log(`Local graph hints: ${graphHints.meta.status}${graphHints.meta.reason ? ` (${graphHints.meta.reason})` : ""}`);
  }
  if (hybridHints.meta?.enabled) {
    log(
      `Local hybrid hints: ${hybridHints.meta.status}` +
      `${hybridHints.meta.reason ? ` (${hybridHints.meta.reason})` : ""}` +
      `${typeof hybridHints.meta.candidates === "number" ? ` candidates=${hybridHints.meta.candidates}` : ""}`,
    );
  }
  if (turnAdapt.reasons.length && effectiveMaxTurns !== maxTurns) {
    log(`Local radar turn adapt: ${maxTurns} → ${effectiveMaxTurns} (${turnAdapt.reasons.join(",")})`);
  }

  const runMetrics = {
    apiCalls: 0,
    toolCalls: 0,
    localCommands: 0,
    validLocalCommands: 0,
    compensatedTurns: 0,
    finalTurn: null,
    commandTypes: {},
  };

  const treeSizeKB = +(treeSizeBytes / 1024).toFixed(1);
  const makeMeta = (extra = {}) => {
    const meta = {
      treeDepth: actualDepth,
      treeSizeKB,
      fellBack,
      metrics: {
        ...runMetrics,
        commandTypes: { ...runMetrics.commandTypes },
      },
      ...extra,
    };
    if (graphHints.meta) meta.graph = graphHints.meta;
    if (hybridHints.meta) meta.hybrid = hybridHints.meta;
    meta.maxTurns = effectiveMaxTurns;
    meta.maxTurnsRequested = maxTurns;
    if (turnAdapt.reasons.length) meta.turnAdapt = turnAdapt.reasons;
    meta.speedProfile = profile;
    return meta;
  };

  const evidenceResult = (extra = {}, selectedFiles = null) => finalizeResult({
    files: completeMode
      ? (selectedFiles || [...verifiedEvidence.values()])
      : (selectedFiles || [...verifiedEvidence.values()]).slice(0, maxResults),
    rg_patterns: [...new Set(executor.collectedRgPatterns)],
    recoveredFromEvidence: true,
    ...extra,
    _meta: makeMeta({ recoveredFromEvidence: true, ...(extra._meta || {}) }),
  });

  const localHintBlocks = [graphHints.hintBlock, hybridHints.hintBlock, vectorHints.hintBlock].filter(Boolean).join("\n\n");
  const userContent = `Problem Statement: ${query}\n\nRepo Map (tree -L ${actualDepth} /codebase):\n\`\`\`text\n${repoMap}\n\`\`\`${localHintBlocks ? `\n\n${localHintBlocks}` : ""}`;

  let userContentFinal = userContent;
  const thr = localFirstThresholds(profile);
  const { top: topHybridForPrime } = topAndSecondScores(hybridHints);
  const radarOneShot =
    (graphHints?.meta?.used && graphHints.meta.confidence === "high") ||
    (hybridHints?.meta?.used && topHybridForPrime >= thr.ok) ||
    turnAdapt.reasons.length > 0;

  const strongLocalPaths = new Set();
  if (graphHints?.meta?.used && graphHints.meta.confidence === "high") {
    const path = graphHints.meta.topPath || graphHints.result?.files?.[0]?.path;
    if (path) strongLocalPaths.add(normalizeRelKey(path));
  }
  if (hybridHints?.meta?.used && topHybridForPrime >= thr.ok) {
    const path = hybridHints.meta.topPath || hybridHints.result?.files?.[0]?.path;
    if (path) strongLocalPaths.add(normalizeRelKey(path));
  }
  const canFinishFromVerifiedEvidence = () => {
    if (profile === "quality" || effectiveMaxTurns !== 1) return false;
    if (!["semantic", "symbol"].includes(routeKind)) return false;
    if (!strongLocalPaths.size) return false;
    return [...verifiedEvidence.values()].some(
      (entry) =>
        entry.sources?.includes("verified-read") &&
        strongLocalPaths.has(normalizeRelKey(entry.path)),
    );
  };
  if (radarOneShot && effectiveMaxTurns <= 2) {
    userContentFinal +=
      "\n\n# Local radar guidance\n" +
      "High-confidence local Graph/Hybrid candidates are already listed above. " +
      "If they fully cover the problem statement, call the answer tool immediately without restricted_exec. " +
      "Only run restricted_exec when candidates are ambiguous, incomplete, or you must verify a critical detail.";
  }

  const messages = [
    { role: 5, content: systemPrompt },
    { role: 1, content: userContentFinal },
  ];

  // Total API calls = effectiveMaxTurns + 1 (last round for answer)
  const totalApiCalls = effectiveMaxTurns + 1;
  let compensatedTurns = 0; // 补偿的轮次数
  const MAX_COMPENSATIONS = 2; // 最大补偿次数，防止死循环
  let forceAnswerInjected = false;

  for (let turn = 0; turn < totalApiCalls + compensatedTurns; turn++) {
    log(`Turn ${turn + 1}/${totalApiCalls}`);

    const proto = _buildRequest(apiKey, jwt, messages, toolDefs);
    let respData;
    try {
      runMetrics.apiCalls++;
      respData = await _streamingRequest(proto, timeoutMs, 2, query);
    } catch (e) {
      const errCode = e.code || "UNKNOWN";
      const baseMeta = makeMeta({ projectRoot, errorCode: errCode });

      // Auto-retry with trimmed context on payload/timeout errors.
      // First-turn failures have no rounds to trim, but shrinking the embedded
      // repo map (the dominant payload component) still gives a viable retry.
      const trimmed = (errCode === "PAYLOAD_TOO_LARGE" || errCode === "TIMEOUT")
        ? _trimMessages(messages)
        : false;
      const shrunk = (errCode === "PAYLOAD_TOO_LARGE" || errCode === "TIMEOUT")
        ? _shrinkRepoMapInMessages(messages)
        : false;
      if (trimmed || shrunk) {
        log(`${errCode} on turn ${turn + 1}: ${trimmed ? "trimming context" : "shrinking repo map"} and retrying...`);
        const retryProto = _buildRequest(apiKey, jwt, messages, toolDefs);
        try {
          runMetrics.apiCalls++;
          respData = await _streamingRequest(retryProto, timeoutMs, 2, query);
        } catch (retryErr) {
          const retryCode = retryErr.code || errCode;
          return finalizeResult({
            files: [],
            error: `${retryCode}: ${retryErr.message} (retry after context trim also failed)`,
            _meta: { ...baseMeta, errorCode: retryCode, contextTrimmed: true },
          });
        }
      } else {
        return finalizeResult({
          files: [],
          error: `${errCode}: ${e.message}`,
          _meta: baseMeta,
        });
      }
    }

    const [thinking, toolInfo] = _parseResponse(respData);

    if (toolInfo === null) {
      if (thinking.startsWith("[Error]")) {
        return finalizeResult({ files: [], error: thinking, _meta: makeMeta({ projectRoot }) });
      }
      if (verifiedEvidence.size) {
        log(`Recovered ${verifiedEvidence.size} files from verified local tool evidence`);
        return evidenceResult({ raw_response: thinking, remoteAnswerMissing: true });
      }
      return finalizeResult({
        files: [],
        raw_response: thinking,
        remoteAnswerMissing: true,
        _meta: makeMeta({ projectRoot }),
      });
    }

    const [toolName, toolArgs] = toolInfo;

    if (toolName === "answer") {
      const answerXml = toolArgs.answer || "";
      log("Received final answer");
      runMetrics.finalTurn = turn + 1;
      const result = _parseAnswer(answerXml, projectRoot);
      result.rg_patterns = [...new Set(executor.collectedRgPatterns)];
      if (!result.files.length && verifiedEvidence.size) {
        log(`Final ANSWER was empty; recovered ${verifiedEvidence.size} verified files`);
        return evidenceResult({ raw_response: answerXml });
      }
      result._meta = makeMeta();
      return finalizeResult(result);
    }

    if (toolName === "restricted_exec") {
      const callId = randomUUID();
      const argsJson = JSON.stringify(toolArgs);

      const cmds = Object.keys(toolArgs).filter((k) => k.startsWith("command"));
      runMetrics.toolCalls++;
      runMetrics.localCommands += cmds.length;
      log(`Executing ${cmds.length} local commands`);

      const results = await executor.execToolCallAsync(toolArgs);
      updatePendingToolContinuations(pendingToolContinuations, toolArgs, results);
      rememberEvidence(recoverFilesFromToolEvidence(toolArgs, results, projectRoot, {
        includeAllRanges: keepAllRanges,
        exhaustive: exhaustiveSearch,
        resultMode: normalizedResultMode,
      }));

      // 检测到所有 command 都是无效的 → 不算有效轮次
      const validCommands = cmds.filter(k => {
        const c = toolArgs[k];
        return c && c.type; // 至少有 type 字段
      });
      runMetrics.validLocalCommands += validCommands.length;
      for (const key of validCommands) {
        const type = toolArgs[key].type;
        runMetrics.commandTypes[type] = (runMetrics.commandTypes[type] || 0) + 1;
      }

      if (canFinishFromVerifiedEvidence()) {
        runMetrics.finalTurn = turn + 1;
        const focusedEvidence = [...verifiedEvidence.values()].filter(
          (entry) =>
            entry.sources?.includes("verified-read") ||
            strongLocalPaths.has(normalizeRelKey(entry.path)),
        );
        log(
          `Verified local evidence covers a strong radar candidate; ` +
          `skipping final relay synthesis (${focusedEvidence.length} files)`,
        );
        return evidenceResult({ earlyReturn: true }, focusedEvidence);
      }

      if (validCommands.length === 0 && compensatedTurns < MAX_COMPENSATIONS) {
        compensatedTurns++; // 补偿：这轮不算有效轮次
        runMetrics.compensatedTurns = compensatedTurns;
        log(`Turn compensation: no valid commands, extending search by 1 turn (${compensatedTurns}/${MAX_COMPENSATIONS})`);
      } else if (validCommands.length === 0) {
        log(`Turn compensation skipped: max compensations (${MAX_COMPENSATIONS}) reached, forcing turn advance`);
      }

      messages.push({
        role: 2,
        content: thinking,
        tool_call_id: callId,
        tool_name: "restricted_exec",
        tool_args_json: argsJson,
      });
      messages.push({ role: 4, content: results, ref_call_id: callId });

      // Inject force-answer after last effective search round
      // Use effective turn count (excluding compensated turns) to avoid premature injection
      const effectiveTurn = turn - compensatedTurns;
      if (effectiveTurn >= effectiveMaxTurns - 1 && !forceAnswerInjected) {
        messages.push({ role: 1, content: FINAL_FORCE_ANSWER });
        forceAnswerInjected = true;
        log("Injected force-answer prompt");
      }
    }
  }

  if (verifiedEvidence.size) {
    log(`Max turns reached; recovered ${verifiedEvidence.size} verified files`);
    return evidenceResult();
  }

  return finalizeResult({
    files: [],
    error: "Max turns reached without getting an answer",
    rg_patterns: [...new Set(executor.collectedRgPatterns)],
    _meta: makeMeta({ projectRoot }),
  });
}

/**
 * Search and return formatted result suitable for MCP tool response.
 *
 * @param {Object} opts
 * @param {string} opts.query
 * @param {string} opts.projectRoot
 * @param {string} [opts.apiKey]
 * @param {number} [opts.maxTurns=3]
 * @param {number} [opts.maxCommands=8]
 * @param {number} [opts.maxResults=10]
 * @param {number} [opts.treeDepth=3]
 * @param {number} [opts.timeoutMs=30000]
 * @param {string[]} [opts.excludePaths=[]]
 * @param {Object|null} [opts.graphProvider=null]
 * @param {boolean} [opts.graphHintsEnabled=false]
 * @param {Object|null} [opts.hybridProvider=null]
 * @param {boolean} [opts.hybridHintsEnabled=false]
 * @returns {Promise<string>}
 */

/**
 * Read a small code window for agent-facing results (local-first quality).
 */
export function readCodeSnippet(fullPath, ranges, maxLines = 14) {
  return readCodeSnippets(fullPath, ranges, maxLines)[0]?.snippet || "";
}

/** Read every requested range. Pagination controls files; ranges are never silently dropped. */
export function readCodeSnippets(fullPath, ranges, maxLinesPerRange = Number.POSITIVE_INFINITY) {
  try {
    const text = readFileSync(fullPath, "utf8");
    const lines = text.split(/\r?\n/);
    const requested = Array.isArray(ranges) && ranges.length
      ? ranges
      : [[1, Math.min(lines.length, Number.isFinite(maxLinesPerRange) ? maxLinesPerRange : lines.length)]];
    const snippets = [];
    for (const range of requested) {
      let start = Math.max(1, Number(range?.[0]) || 1);
      let end = Math.max(start, Number(range?.[1]) || start);
      if (Number.isFinite(maxLinesPerRange)) end = Math.min(end, start + maxLinesPerRange - 1);
      end = Math.min(lines.length, end);
      if (start > lines.length) continue;
      snippets.push({ range: [start, end], snippet: lines.slice(start - 1, end).join("\n") });
    }
    return snippets;
  } catch {
    return [];
  }
}

export async function searchWithContent({
  query,
  projectRoot,
  apiKey = null,
  maxTurns = 3,
  maxCommands = 8,
  maxResults = 10,
  treeDepth = 3,
  timeoutMs = 30000,
  excludePaths = [],
  graphProvider = null,
  graphHintsEnabled = false,
  hybridProvider = null,
  hybridHintsEnabled = false,
  localFirstMode = resolveLocalFirstMode(),
  routeKind = "semantic",
  speedProfile = resolveSpeedProfile(),
  resultMode = "complete",
  cursor = null,
  pageSize = DEFAULT_COMPLETE_PAGE_SIZE,
  includeAllRanges = null,
  exhaustive = null,
}) {
  const normalizedResultMode = normalizeResultMode(resultMode);
  const completeMode = normalizedResultMode === "complete";
  const keepAllRanges = includeAllRanges == null ? completeMode : Boolean(includeAllRanges);
  const exhaustiveSearch = exhaustive == null ? completeMode : Boolean(exhaustive);
  const result = await search({
    query,
    projectRoot,
    apiKey,
    maxTurns,
    maxCommands,
    maxResults,
    treeDepth,
    timeoutMs,
    excludePaths,
    graphProvider,
    graphHintsEnabled,
    hybridProvider,
    hybridHintsEnabled,
    localFirstMode,
    routeKind,
    speedProfile,
    resultMode: normalizedResultMode,
    includeAllRanges: keepAllRanges,
    exhaustive: exhaustiveSearch,
  });

  if (result.error) {
    const meta = result._meta;
    let errMsg = `Error: ${result.error}`;
    if (meta) {
      errMsg += `\n\n[diagnostic] error_type=${meta.errorCode || "unknown"}, tree_depth_used=${meta.treeDepth}, tree_size=${meta.treeSizeKB}KB`;
      if (meta.fellBack) errMsg += ` (auto fell back from requested depth)`;
      if (meta.contextTrimmed) errMsg += `, context_trimmed=true`;
      if (meta.projectRoot) errMsg += `\n[diagnostic] project_path=${meta.projectRoot}`;
      if (meta.graph) {
        errMsg += `\n[diagnostic] local_graph=${meta.graph.status}, used=${meta.graph.used}, reason=${meta.graph.reason || "n/a"}`;
      }
      if (meta.hybrid) {
        errMsg += `\n[diagnostic] local_hybrid=${meta.hybrid.status}, used=${meta.hybrid.used}, reason=${meta.hybrid.reason || "n/a"}`;
      }
      errMsg += `\n[config] max_turns=${maxTurns}, max_results=${maxResults}, max_commands=${maxCommands}, timeout_ms=${timeoutMs}`;
      if (excludePaths.length) errMsg += `, exclude_paths=[${excludePaths.join(", ")}]`;
      // Targeted hints based on error type
      if (meta.errorCode === "PAYLOAD_TOO_LARGE" || meta.errorCode === "TIMEOUT") {
        errMsg += `\n[hint] Payload/timeout error. Try: reduce tree_depth, reduce max_turns, add exclude_paths, or narrow project_path to a subdirectory.`;
      } else if (meta.errorCode === "AUTH_ERROR") {
        errMsg += `\n[hint] ACE authentication failed. Update the ACE API key and retry.`;
      } else if (meta.errorCode === "RATE_LIMITED") {
        errMsg += `\n[hint] Rate limited. Wait a moment and retry.`;
      } else {
        errMsg += `\n[hint] If the error is payload-related, try a lower tree_depth value or add exclude_paths.`;
      }
    }
    return errMsg;
  }

  if (Array.isArray(result.files) && result.files.length) {
    const policyInput = result.files.map((file, index) => ({
      ...file,
      score: Number.isFinite(file.score) ? file.score : Math.max(0.2, 0.92 - index * 0.07),
    }));
    result.files = rankAndSelectFiles(policyInput, {
      query,
      maxResults,
      confidence: result.recoveredFromEvidence ? "medium" : "high",
      resultMode: normalizedResultMode,
      exhaustive: exhaustiveSearch,
    });
  }

  const coverage = result.coverage || result._meta?.coverage || { complete: true, issues: [], providers: {} };
  const paged = paginateResults(result.files || [], {
    query,
    projectRoot,
    resultMode: normalizedResultMode,
    cursor: completeMode ? cursor : null,
    pageSize: completeMode ? pageSize : maxResults,
    includeAllRanges: keepAllRanges,
    exhaustive: exhaustiveSearch,
    coverageComplete: coverage.complete,
  });
  const files = paged.files;
  const pagination = paged.pagination;
  const rgPatterns = result.rg_patterns || [];
  // Deduplicate + filter short patterns
  const uniquePatterns = [...new Set(rgPatterns)].filter((p) => p.length >= 3);

  if (!files.length && !uniquePatterns.length) {
    const raw = result.raw_response || "";
    const empty = raw ? `No relevant files found.\n\nRaw response:\n${raw}` : "No relevant files found.";
    return `${empty}\n\n[pagination] result_mode=${normalizedResultMode}, returned=0, total_candidates=0, has_more=false, complete=${pagination.complete}`;
  }

  const parts = [];
  const n = files.length;
  const total = pagination.totalCandidates;

  if (files.length) {
    parts.push(
      result.localFirst
        ? `Found ${n} of ${total} relevant files (local-first, no remote Devstral).`
        : result.recoveredFromEvidence
          ? `Found ${n} of ${total} relevant files (verified local tool evidence).`
        : `Found ${n} of ${total} relevant files.`,
    );
    parts.push("");
    for (let i = 0; i < files.length; i++) {
      const entry = files[i];
      const rangesStr = (entry.ranges || []).map(([a, b]) => `L${a}-${b}`).join(", ");
      const scoreBit = Number.isFinite(entry.score) ? ` score=${Number(entry.score).toFixed(3)}` : "";
      const srcBit = entry.sources?.length ? ` sources=${entry.sources.join("+")}` : "";
      const roleBit = entry.role ? ` role=${entry.role}` : "";
      parts.push(`  [${pagination.offset + i + 1}/${total}] ${entry.full_path} (${rangesStr})${scoreBit}${srcBit}${roleBit}`);
      const evidence = entry.evidence || null;
      if (evidence) {
        const evidenceParts = [];
        const definitions = (evidence.definitions || [])
          .slice(0, completeMode ? Number.POSITIVE_INFINITY : 3)
          .map((item) => item.name)
          .filter(Boolean);
        if (definitions.length) evidenceParts.push(`defines=${definitions.join(",")}`);
        for (const [label, key] of [["refs", "references"], ["imports", "imports"], ["exports", "exports"], ["tests", "tests"]]) {
          if (evidence[key]?.length) evidenceParts.push(`${label}=${evidence[key].length}`);
        }
        if (evidenceParts.length) parts.push(`    evidence: ${evidenceParts.join(" | ")}`);
      }
      const snippets = completeMode
        ? readCodeSnippets(entry.full_path, entry.ranges)
        : [{ range: entry.ranges?.[0] || null, snippet: entry.snippet || readCodeSnippet(
          entry.full_path,
          entry.ranges,
          result.localFirst ? 16 : 12,
        ) }];
      for (const item of snippets) {
        if (!item.snippet) continue;
        if (item.range) parts.push(`    snippet: L${item.range[0]}-${item.range[1]}`);
        parts.push("```");
        parts.push(item.snippet);
        parts.push("```");
      }
    }
  } else {
    parts.push("No files found.");
  }

  if (uniquePatterns.length) {
    parts.push("");
    parts.push(`grep keywords: ${uniquePatterns.join(", ")}`);
  }

  parts.push("");
  parts.push(
    `[pagination] result_mode=${normalizedResultMode}, returned=${pagination.returned}, ` +
    `total_candidates=${pagination.totalCandidates}, offset=${pagination.offset}, ` +
    `page_size=${pagination.pageSize}, has_more=${pagination.hasMore}, complete=${pagination.complete}`,
  );
  if (pagination.nextCursor) parts.push(`[next_cursor] ${pagination.nextCursor}`);
  parts.push(
    `[coverage] complete=${coverage.complete !== false}, issues=${coverage.issues?.length ? coverage.issues.join(";") : "none"}`,
  );

  // Append diagnostic metadata so the calling AI knows what happened
  const meta = result._meta;
  if (meta) {
    const fbNote = meta.fellBack ? ` (fell back from requested depth)` : "";
    parts.push("");
    let configLine = `[config] tree_depth=${meta.treeDepth}${fbNote}, tree_size=${meta.treeSizeKB}KB, max_turns=${maxTurns}, max_results=${maxResults}, timeout_ms=${timeoutMs}`;
    if (excludePaths.length) configLine += `, exclude_paths=[${excludePaths.join(", ")}]`;
    parts.push(configLine);
    if (meta.graph) {
      parts.push(`[diagnostic] local_graph=${meta.graph.status}, used=${meta.graph.used}, reason=${meta.graph.reason || "n/a"}`);
    }
    if (meta.hybrid) {
      parts.push(
        `[diagnostic] local_hybrid=${meta.hybrid.status}, used=${meta.hybrid.used}` +
        `${typeof meta.hybrid.candidates === "number" ? `, candidates=${meta.hybrid.candidates}` : ""}` +
        `, reason=${meta.hybrid.reason || "n/a"}`,
      );
    }
    if (meta.localFirst) {
      parts.push(
        `[diagnostic] local_first=on reasons=${(meta.localFirstReasons || []).join(",") || "n/a"} (skipped remote Devstral)`,
      );
    }
    if (meta.speedProfile) {
      parts.push(`[diagnostic] speed_profile=${meta.speedProfile}`);
    }
    if (meta.recoveredFromEvidence) {
      parts.push(
        `[diagnostic] recovered_from=verified_local_tools` +
        `${result.earlyReturn ? ", skipped_final_relay=true" : ""}`,
      );
    }
    if (typeof meta.maxTurns === "number" && meta.maxTurns !== maxTurns) {
      parts.push(`[diagnostic] max_turns effective=${meta.maxTurns} requested=${meta.maxTurnsRequested ?? maxTurns}`);
    }
  }

  return parts.join("\n");
}
