/**
 * Tool executor for Windsurf's restricted commands.
 *
 * Uses @vscode/ripgrep for built-in rg binary — no system install needed.
 * Matches Python ToolExecutor behavior exactly.
 */

import { execFileSync, execFile as execFileCb } from "node:child_process";
import { readdirSync, readFileSync, statSync, existsSync, promises as fsPromises } from "node:fs";
import { join, resolve, relative, sep, basename } from "node:path";
import { promisify } from "node:util";
import { rgPath } from "../vendor/ripgrep/lib/index.js";
import treeNodeCli from "../vendor/tree-node-cli/src/index.js";

const execFileAsync = promisify(execFileCb);

/**
 * Parse an integer env var with optional clamping.
 * @param {string} name
 * @param {number} defaultValue
 * @param {{ min?: number, max?: number }} [opts]
 * @returns {number}
 */
function readIntEnv(name, defaultValue, opts = {}) {
  const raw = process.env[name];
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed)) return defaultValue;
  const min = typeof opts.min === "number" ? opts.min : null;
  const max = typeof opts.max === "number" ? opts.max : null;
  let value = parsed;
  if (min !== null) value = Math.max(min, value);
  if (max !== null) value = Math.min(max, value);
  return value;
}

// Per-command line budgets: readfile needs whole semantic blocks (the system prompt
// demands untruncated ranges), rg/ls stay at Windsurf parity, tree is orientation-only.
// LOCUS_RESULT_MAX_LINES (when set) keeps its legacy behavior of overriding ALL commands.
const RESULT_MAX_LINES_OVERRIDE = readIntEnv("LOCUS_RESULT_MAX_LINES", 0, { min: 1, max: 500 });
const RESULT_MAX_LINES_BY_TYPE = {
  readfile: readIntEnv("LOCUS_READFILE_MAX_LINES", 250, { min: 1, max: 1000 }),
  rg: readIntEnv("LOCUS_RG_MAX_LINES", 50, { min: 1, max: 500 }),
  tree: readIntEnv("LOCUS_TREE_MAX_LINES", 40, { min: 1, max: 500 }),
  ls: readIntEnv("LOCUS_LS_MAX_LINES", 50, { min: 1, max: 500 }),
  glob: readIntEnv("LOCUS_GLOB_MAX_LINES", 50, { min: 1, max: 500 }),
};
const RESULT_MAX_LINES = 50;
const RG_MAX_BUFFER_BYTES = readIntEnv("LOCUS_RG_MAX_BUFFER_BYTES", 64 * 1024 * 1024, {
  min: 1024 * 1024,
  max: 512 * 1024 * 1024,
});

/**
 * Effective line budget for a command type.
 * @param {string} kind
 * @returns {number}
 */
function resultMaxLines(kind) {
  if (RESULT_MAX_LINES_OVERRIDE > 0) return RESULT_MAX_LINES_OVERRIDE;
  return RESULT_MAX_LINES_BY_TYPE[kind] ?? RESULT_MAX_LINES;
}

function normalizeResultOffset(value) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

// readfile safety valve: full-file reads of huge files (bundles, logs) block the
// event loop for a truncated-anyway result.
const READFILE_MAX_BYTES = readIntEnv("LOCUS_READFILE_MAX_BYTES", 5 * 1024 * 1024, {
  min: 64 * 1024,
});

export class ToolExecutor {
  /**
   * @param {string} projectRoot
   * @param {{ excludes?: string[] }} [opts] - excludes: dir/file name patterns
   *   (same list the server passes to getRepoMap) applied to tree/glob so
   *   model-issued commands never walk node_modules etc.
   */
  constructor(projectRoot, opts = {}) {
    this.root = resolve(projectRoot);
    /** @type {string[]} */
    this.collectedRgPatterns = [];
    /** @type {string[]} */
    this.excludes = Array.isArray(opts.excludes) ? opts.excludes : [];
    /** @type {RegExp[]} */
    this.excludeRegexes = this.excludes.map(_excludePatternToRegex);
  }

  /**
   * Map virtual /codebase path to real filesystem path.
   * @param {string} virtual
   * @returns {string}
   */
  _real(virtual) {
    // Guard against undefined/null from malformed AI responses
    if (virtual == null || typeof virtual !== "string") {
      return this.root;
    }
    if (virtual.startsWith("/codebase") || virtual.startsWith("\\codebase")) {
      const rel = virtual.slice("/codebase".length).replace(/^[\/\\]+/, "");
      return join(this.root, rel);
    }
    return virtual;
  }

  /**
   * Page line-oriented command output without modifying individual lines.
   * When another page exists, the marker contains the exact continuation
   * argument needed to retrieve it.
   * @param {string} text
   * @param {number} [maxLines]
   * @param {{ offset?: number, note?: string }} [options]
   * @returns {string}
   */
  static _truncate(text, maxLines = RESULT_MAX_LINES, options = {}) {
    const { offset: rawOffset = 0, note = "" } = options || {};
    const offset = normalizeResultOffset(rawOffset);
    const normalized = String(text ?? "").replace(/\r\n/g, "\n");
    const lines = normalized.split("\n");
    if (lines.at(-1) === "") lines.pop();
    const end = Math.min(lines.length, offset + maxLines);
    const page = lines.slice(offset, end);
    if (page.length === 0) {
      if (lines.length === 0) return "";
      return `(no results at result_offset=${offset}; total_results=${lines.length})`;
    }
    let result = page.join("\n");
    if (end < lines.length) {
      const suffix = note ? `; ${note}` : "";
      result += `\n[continuation] result_offset=${offset}; returned=${page.length}; total_results=${lines.length}; next_result_offset=${end}${suffix}`;
    }
    return result;
  }

  /**
   * Replace real project root with /codebase in output.
   * @param {string} text
   * @returns {string}
   */
  _remap(text) {
    // Replace both forward-slash and native-sep versions
    return text.replaceAll(this.root, "/codebase");
  }

  /**
   * Check if a file matches any glob pattern (simplified fnmatch).
   * @param {string} relPath
   * @param {string} filename
   * @param {string[]} patterns
   * @returns {boolean}
   */
  static _globMatch(relPath, filename, patterns) {
    for (const pat of patterns) {
      const normalized = pat.replace(/\\/g, "/");
      if (normalized.startsWith("**/")) {
        const sub = normalized.slice(3);
        if (sub.includes("/**")) continue; // directory pattern, handled by skipDirs
        if (_fnmatch(filename, sub)) return true;
      } else if (_fnmatch(relPath, normalized)) {
        return true;
      } else if (_fnmatch(filename, normalized)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Search for pattern using @vscode/ripgrep (async version).
   * @param {string} pattern
   * @param {string} path
   * @param {string[]|null} [include]
   * @param {string[]|null} [exclude]
   * @returns {Promise<string>}
   */
  async rgAsync(pattern, path, include = null, exclude = null, resultOffset = 0) {
    if (!pattern || typeof pattern !== "string") {
      return "Error: missing or invalid pattern";
    }
    if (!path || typeof path !== "string") {
      return "Error: missing or invalid path";
    }
    this.collectedRgPatterns.push(pattern);
    const rp = this._real(path);
    if (!existsSync(rp)) {
      return `Error: path does not exist: ${path}`;
    }

    const args = ["--no-heading", "-n", "--sort", "path"];
    if (include) {
      for (const g of include) {
        args.push("--glob", g);
      }
    }
    if (exclude) {
      for (const g of exclude) {
        args.push("--glob", `!${g}`);
      }
    }
    args.push("--", pattern, rp);

    try {
      const { stdout } = await execFileAsync(rgPath, args, {
        timeout: 30000,
        maxBuffer: RG_MAX_BUFFER_BYTES,
        env: { ...process.env, RIPGREP_CONFIG_PATH: "" },
        encoding: "utf-8",
      });
      return ToolExecutor._truncate(this._remap(stdout || "(no matches)"), resultMaxLines("rg"), {
        offset: resultOffset,
        note: `repeat the same rg command with result_offset=${normalizeResultOffset(resultOffset) + resultMaxLines("rg")}`,
      });
    } catch (err) {
      if (err.code === 1 || err.status === 1) {
        return "(no matches)";
      }
      if (err.stderr) {
        return ToolExecutor._truncate(this._remap(err.stderr), resultMaxLines("rg"));
      }
      return `Error: ${err.message}`;
    }
  }

  /**
   * Search for pattern using @vscode/ripgrep.
   * @param {string} pattern
   * @param {string} path
   * @param {string[]|null} [include]
   * @param {string[]|null} [exclude]
   * @returns {string}
   */
  rg(pattern, path, include = null, exclude = null, resultOffset = 0) {
    if (!pattern || typeof pattern !== "string") {
      return "Error: missing or invalid pattern";
    }
    if (!path || typeof path !== "string") {
      return "Error: missing or invalid path";
    }
    this.collectedRgPatterns.push(pattern);
    const rp = this._real(path);
    if (!existsSync(rp)) {
      return `Error: path does not exist: ${path}`;
    }

    const args = ["--no-heading", "-n", "--sort", "path"];
    if (include) {
      for (const g of include) {
        args.push("--glob", g);
      }
    }
    if (exclude) {
      for (const g of exclude) {
        args.push("--glob", `!${g}`);
      }
    }
    args.push("--", pattern, rp);

    try {
      const stdout = execFileSync(rgPath, args, {
        timeout: 30000,
        maxBuffer: RG_MAX_BUFFER_BYTES,
        env: { ...process.env, RIPGREP_CONFIG_PATH: "" },
        encoding: "utf-8",
      });
      return ToolExecutor._truncate(this._remap(stdout || "(no matches)"), resultMaxLines("rg"), {
        offset: resultOffset,
        note: `repeat the same rg command with result_offset=${normalizeResultOffset(resultOffset) + resultMaxLines("rg")}`,
      });
    } catch (err) {
      // rg exits with code 1 when no matches found — that's normal
      if (err.status === 1) {
        return "(no matches)";
      }
      // rg exits with code 2 on errors
      if (err.stderr) {
        return ToolExecutor._truncate(this._remap(err.stderr), resultMaxLines("rg"));
      }
      return `Error: ${err.message}`;
    }
  }

  /**
   * Read file contents with optional line range (1-indexed, inclusive).
   * @param {string} file
   * @param {number|null} [startLine]
   * @param {number|null} [endLine]
   * @returns {string}
   */
  readfile(file, startLine = null, endLine = null) {
    if (!file || typeof file !== "string") {
      return "Error: missing or invalid file path";
    }
    const rp = this._real(file);
    const guard = ToolExecutor._readfileGuard(rp, file, startLine, endLine);
    if (guard) return guard;

    let content;
    try {
      content = readFileSync(rp, "utf-8");
    } catch (e) {
      return `Error: ${e.message}`;
    }
    return ToolExecutor._formatReadfile(content, startLine, endLine);
  }

  /**
   * Async variant of readfile — avoids blocking the event loop while other
   * commands of the same round run.
   * @param {string} file
   * @param {number|null} [startLine]
   * @param {number|null} [endLine]
   * @returns {Promise<string>}
   */
  async readfileAsync(file, startLine = null, endLine = null) {
    if (!file || typeof file !== "string") {
      return "Error: missing or invalid file path";
    }
    const rp = this._real(file);
    const guard = ToolExecutor._readfileGuard(rp, file, startLine, endLine);
    if (guard) return guard;

    let content;
    try {
      content = await fsPromises.readFile(rp, "utf-8");
    } catch (e) {
      return `Error: ${e.message}`;
    }
    return ToolExecutor._formatReadfile(content, startLine, endLine);
  }

  /**
   * Common readfile validation: existence + huge-file safety valve.
   * Returns an error string, or null when the read may proceed.
   * @param {string} rp - real path
   * @param {string} file - virtual path (for messages)
   * @param {number|null} startLine
   * @param {number|null} endLine
   * @returns {string|null}
   */
  static _readfileGuard(rp, file, startLine, endLine) {
    let stat;
    try {
      stat = statSync(rp);
      if (!stat.isFile()) {
        return `Error: file not found: ${file}`;
      }
    } catch {
      return `Error: file not found: ${file}`;
    }
    // Whole-file reads of huge files (bundles/logs) are truncated anyway;
    // demand an explicit line range instead of stalling on megabytes.
    if (stat.size > READFILE_MAX_BYTES && !startLine && !endLine) {
      const sizeMB = (stat.size / (1024 * 1024)).toFixed(1);
      return `Error: file too large (${sizeMB}MB) for a full read; pass start_line/end_line to read a window`;
    }
    return null;
  }

  /**
   * Slice, number and truncate readfile content.
   * @param {string} content
   * @param {number|null} startLine
   * @param {number|null} endLine
   * @returns {string}
   */
  static _formatReadfile(content, startLine, endLine) {
    const allLines = content.split("\n");
    // If the file ends with a newline, there'll be an empty string at the end
    // Keep behavior consistent with Python readlines()
    const requestedStart = Math.max(1, Number.parseInt(startLine ?? "", 10) || 1);
    const requestedEnd = Math.min(
      allLines.length,
      Math.max(requestedStart, Number.parseInt(endLine ?? "", 10) || allLines.length),
    );
    const selected = allLines.slice(requestedStart - 1, requestedEnd);
    const page = selected.slice(0, resultMaxLines("readfile"));
    if (page.length === 0) {
      return `(no lines in requested range ${requestedStart}-${requestedEnd})`;
    }
    let out = page.map((line, idx) => `${requestedStart + idx}:${line}`).join("\n");
    if (page.length < selected.length) {
      const nextStart = requestedStart + page.length;
      out += `\n[continuation] returned=${page.length}; requested_range=${requestedStart}-${requestedEnd}; next_start_line=${nextStart}; end_line=${requestedEnd}`;
    }
    return out;
  }

  /**
   * Display directory structure as a tree.
   * @param {string} path
   * @param {number|null} [levels]
   * @returns {string}
   */
  tree(path, levels = null, resultOffset = 0) {
    if (!path || typeof path !== "string") {
      return "Error: missing or invalid path";
    }
    const rp = this._real(path);
    try {
      const stat = statSync(rp);
      if (!stat.isDirectory()) {
        return `Error: dir not found: ${path}`;
      }
    } catch {
      return `Error: dir not found: ${path}`;
    }

    try {
      const opts = {};
      if (levels) opts.maxDepth = levels;
      if (this.excludeRegexes.length) opts.exclude = this.excludeRegexes;
      let stdout = treeNodeCli(rp, opts);
      // tree-node-cli outputs basename as root line; replace with virtual path
      const dirName = rp.split("/").pop() || rp.split("\\").pop() || rp;
      const lines = stdout.split("\n");
      if (lines[0] === dirName) {
        lines[0] = path;
        stdout = lines.join("\n");
      }
      return ToolExecutor._truncate(this._remap(stdout), resultMaxLines("tree"), {
        offset: resultOffset,
        note: `repeat the same tree command with result_offset=${normalizeResultOffset(resultOffset) + resultMaxLines("tree")}`,
      });
    } catch {
      return `Error: failed to generate tree for ${path}`;
    }
  }

  /**
   * List files in a directory.
   * @param {string} path
   * @param {boolean} [longFormat=false]
   * @param {boolean} [allFiles=false]
   * @returns {string}
   */
  ls(path, longFormat = false, allFiles = false, resultOffset = 0) {
    if (!path || typeof path !== "string") {
      return "Error: missing or invalid path";
    }
    const rp = this._real(path);
    try {
      const stat = statSync(rp);
      if (!stat.isDirectory()) {
        return `Error: not a directory: ${path}`;
      }
    } catch {
      return `Error: dir not found: ${path}`;
    }

    let entries;
    try {
      entries = readdirSync(rp).sort();
    } catch (e) {
      return `Error: ${e.message}`;
    }

    if (!allFiles) {
      entries = entries.filter((e) => !e.startsWith("."));
    }

    if (!longFormat) {
      return ToolExecutor._truncate(entries.join("\n"), resultMaxLines("ls"), {
        offset: resultOffset,
        note: `repeat the same ls command with result_offset=${normalizeResultOffset(resultOffset) + resultMaxLines("ls")}`,
      });
    }

    // Long format: emulate ls -l output
    const lines = [`total ${entries.length}`];
    for (const name of entries) {
      const fp = join(rp, name);
      try {
        const st = statSync(fp);
        const isDir = st.isDirectory();
        const type = isDir ? "d" : "-";
        const perm = "rwxr-xr-x";
        const size = String(st.size).padStart(8);
        const mtime = st.mtime;
        const month = mtime.toLocaleString("en", { month: "short" });
        const day = String(mtime.getDate()).padStart(2);
        const hh = String(mtime.getHours()).padStart(2, "0");
        const mm = String(mtime.getMinutes()).padStart(2, "0");
        const dateStr = `${month} ${day} ${hh}:${mm}`;
        lines.push(`${type}${perm}  1 user  staff ${size} ${dateStr} ${name}`);
      } catch {
        lines.push(`?---------  ? ?     ?        ? ? ?     ? ${name}`);
      }
    }
    return ToolExecutor._truncate(this._remap(lines.join("\n")), resultMaxLines("ls"), {
      offset: resultOffset,
      note: `repeat the same ls command with result_offset=${normalizeResultOffset(resultOffset) + resultMaxLines("ls")}`,
    });
  }

  /**
   * Glob pattern matching.
   * @param {string} pattern
   * @param {string} path
   * @param {string} [typeFilter="all"]
   * @returns {string}
   */
  glob(pattern, path, typeFilter = "all", resultOffset = 0) {
    if (!pattern || typeof pattern !== "string") {
      return "Error: missing or invalid pattern";
    }
    if (!path || typeof path !== "string") {
      return "Error: missing or invalid path";
    }
    const rp = this._real(path);

    // Use recursive readdir + fnmatch since Node 22 globSync may not be available
    const matches = [];

    try {
      _globWalk(rp, pattern, matches, typeFilter, this.excludeRegexes);
    } catch {
      // fallback: try simple readdir
      try {
        const entries = readdirSync(rp);
        for (const entry of entries) {
          const fp = join(rp, entry);
          if (_fnmatch(entry, pattern)) {
            try {
              const st = statSync(fp);
              if (typeFilter === "file" && !st.isFile()) continue;
              if (typeFilter === "directory" && !st.isDirectory()) continue;
              matches.push(fp);
            } catch { /* skip */ }
          }
        }
      } catch { /* skip */ }
    }

    const sorted = matches.sort();
    const out = sorted.map((m) => this._remap(m)).join("\n");
    return ToolExecutor._truncate(out || "(no matches)", resultMaxLines("glob"), {
      offset: resultOffset,
      note: `repeat the same glob command with result_offset=${normalizeResultOffset(resultOffset) + resultMaxLines("glob")}`,
    });
  }

  /**
   * Dispatch a command dict to the appropriate method (async).
   * Uses async rg for parallelism, sync for others (they are fast enough).
   * @param {Object} cmd
   * @returns {Promise<string>}
   */
  async execCommandAsync(cmd) {
    if (!cmd || typeof cmd !== "object") {
      return "Error: missing or invalid command";
    }
    const t = cmd.type || "";
    switch (t) {
      case "rg":
        return this.rgAsync(cmd.pattern, cmd.path, cmd.include || null, cmd.exclude || null, cmd.result_offset || 0);
      case "readfile":
        return this.readfileAsync(cmd.file, cmd.start_line || null, cmd.end_line || null);
      case "tree":
        return this.tree(cmd.path, cmd.levels || null, cmd.result_offset || 0);
      case "ls":
        return this.ls(cmd.path, cmd.long_format || false, cmd.all || false, cmd.result_offset || 0);
      case "glob":
        return this.glob(cmd.pattern, cmd.path, cmd.type_filter || "all", cmd.result_offset || 0);
      default:
        return `Error: unknown command type '${t}'`;
    }
  }

  /**
   * Dispatch a command dict to the appropriate method.
   * @param {Object} cmd
   * @returns {string}
   */
  execCommand(cmd) {
    if (!cmd || typeof cmd !== "object") {
      return "Error: missing or invalid command";
    }
    const t = cmd.type || "";
    switch (t) {
      case "rg":
        return this.rg(cmd.pattern, cmd.path, cmd.include || null, cmd.exclude || null, cmd.result_offset || 0);
      case "readfile":
        return this.readfile(cmd.file, cmd.start_line || null, cmd.end_line || null);
      case "tree":
        return this.tree(cmd.path, cmd.levels || null, cmd.result_offset || 0);
      case "ls":
        return this.ls(cmd.path, cmd.long_format || false, cmd.all || false, cmd.result_offset || 0);
      case "glob":
        return this.glob(cmd.pattern, cmd.path, cmd.type_filter || "all", cmd.result_offset || 0);
      default:
        return `Error: unknown command type '${t}'`;
    }
  }

  /**
   * Execute all commandN keys from a tool call args dict (parallel).
   * @param {Object} args
   * @returns {Promise<string>}
   */
  async execToolCallAsync(args) {
    if (!args || typeof args !== "object") {
      return "Error: missing or invalid tool args";
    }
    const keys = Object.keys(args).filter((k) => k.startsWith("command")).sort();
    const tasks = keys.map(async (key) => {
      const output = await this.execCommandAsync(args[key]);
      return `<${key}_result>\n${output}\n</${key}_result>`;
    });
    const results = await Promise.all(tasks);
    return results.join("");
  }

  /**
   * Execute all commandN keys from a tool call args dict.
   * @param {Object} args
   * @returns {string}
   */
  execToolCall(args) {
    const parts = [];
    if (!args || typeof args !== "object") {
      return "Error: missing or invalid tool args";
    }
    const keys = Object.keys(args).filter((k) => k.startsWith("command")).sort();
    for (const key of keys) {
      const output = this.execCommand(args[key]);
      parts.push(`<${key}_result>\n${output}\n</${key}_result>`);
    }
    return parts.join("");
  }
}

// ─── Helpers ───────────────────────────────────────────────

/**
 * Simple fnmatch-like glob matching.
 * Supports *, ?, and ** patterns.
 * @param {string} str
 * @param {string} pattern
 * @returns {boolean}
 */
function _fnmatch(str, pattern) {
  // Convert glob pattern to regex
  let regex = "^";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        // ** matches everything including /
        regex += ".*";
        i += 2;
        if (pattern[i] === "/") i++; // skip trailing /
        continue;
      }
      regex += "[^/]*";
    } else if (c === "?") {
      regex += "[^/]";
    } else if (c === "[") {
      // Pass through character classes
      const end = pattern.indexOf("]", i);
      if (end === -1) {
        regex += "\\[";
      } else {
        regex += pattern.slice(i, end + 1);
        i = end;
      }
    } else if (".+^${}()|\\".includes(c)) {
      regex += "\\" + c;
    } else {
      regex += c;
    }
    i++;
  }
  regex += "$";
  try {
    return new RegExp(regex).test(str);
  } catch {
    return false;
  }
}

/**
 * Convert an exclude pattern (directory/file name or simple glob) to RegExp,
 * mirroring core.mjs's getRepoMap exclude handling.
 * @param {string} pattern - e.g. "node_modules", "dist", "*.min.*"
 * @returns {RegExp}
 */
function _excludePatternToRegex(pattern) {
  if (!/[*?]/.test(pattern)) {
    return new RegExp("^" + pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$");
  }
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
 * Recursive glob walk.
 * @param {string} base
 * @param {string} pattern
 * @param {string[]} matches
 * @param {string} typeFilter
 * @param {RegExp[]} [excludeRegexes] - dir/file names to skip entirely
 */
function _globWalk(base, pattern, matches, typeFilter, excludeRegexes = []) {
  const isRecursive = pattern.includes("**");

  const walk = (dir, depth) => {
    if (matches.length >= 100) return;
    if (!isRecursive && depth > 0) return;

    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (matches.length >= 100) return;
      if (excludeRegexes.length && excludeRegexes.some((rx) => rx.test(entry))) continue;
      const fp = join(dir, entry);
      const relFromBase = relative(base, fp).replace(/\\/g, "/");

      let st;
      try {
        st = statSync(fp);
      } catch {
        continue;
      }

      if (_fnmatch(relFromBase, pattern) || _fnmatch(entry, pattern)) {
        if (typeFilter === "file" && !st.isFile()) continue;
        if (typeFilter === "directory" && !st.isDirectory()) continue;
        matches.push(fp);
      }

      if (st.isDirectory() && !entry.startsWith(".") && isRecursive) {
        walk(fp, depth + 1);
      }
    }
  };

  walk(base, 0);
}
