import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import ignore from "../../vendor/ignore/index.js";

// 注意：不读 .dockerignore——它的语义是"缩小 Docker 构建上下文"，会排除
// docker-compose.yml/Caddyfile/scripts/*.md 这类恰恰最该被检索到的文件
// （实测 frontend/.dockerignore 曾让 compose 文件全部从索引消失）。
// 想把文件排除出检索，用 .locusignore。
export const PROJECT_IGNORE_FILES = Object.freeze([
  ".gitignore",
  ".cursorignore",
  ".locusignore",
  ".ignore",
]);

// 与 server.mjs 的 BUILTIN_DEFAULT_EXCLUDES 保持对齐：远程 tree/glob 挡掉的目录，
// 本地 graph/hybrid 索引也必须挡掉，否则杂物文件参与打分挤掉正经代码
// （实测 .codex/ 下的案例 HTML 曾进过检索结果前三）。
const HARD_EXCLUDES = Object.freeze([
  ".git/",
  ".hg/",
  ".svn/",
  ".locus-mcp/",
  ".model-cache/",
  "node_modules/",
  "dist/",
  "build/",
  "out/",
  "coverage/",
  ".next/",
  ".nuxt/",
  ".svelte-kit/",
  ".turbo/",
  ".cache/",
  "__pycache__/",
  ".venv/",
  "venv/",
  "vendor/",
  "target/",
  ".codegraph/",
  ".codex/",
  ".ace-tool/",
  ".idea/",
  ".vscode/",
  "*.min.*",
  "*.exe",
  "*.log",
]);

function toPosix(path) {
  return String(path || "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

function safeRead(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function makeIgnore(patterns = []) {
  const matcher = ignore();
  matcher.add(patterns.filter(Boolean));
  return matcher;
}

/**
 * Directory-aware ignore rules. Each ignore file is evaluated relative to the
 * directory that owns it, matching Git's nested .gitignore behavior.
 */
export function createProjectIgnoreMatcher(projectRoot, opts = {}) {
  const root = resolve(projectRoot);
  const hard = makeIgnore([...HARD_EXCLUDES, ...(opts.hardExcludes || [])]);
  const rulesByDirectory = new Map();
  const loadedFiles = new Set();
  const ignoreFileNames = opts.ignoreFileNames || PROJECT_IGNORE_FILES;

  function loadDirectory(absDirectory) {
    const absolute = resolve(absDirectory);
    const relDirectory = toPosix(relative(root, absolute));
    if (relDirectory.startsWith("..")) return;
    const key = relDirectory || ".";
    if (rulesByDirectory.has(key)) return;

    const matcher = ignore();
    let count = 0;
    for (const fileName of ignoreFileNames) {
      const filePath = join(absolute, fileName);
      if (!existsSync(filePath)) continue;
      const content = safeRead(filePath);
      if (!content) continue;
      matcher.add(content);
      loadedFiles.add(toPosix(relative(root, filePath)));
      count += 1;
    }
    rulesByDirectory.set(key, count ? matcher : null);
  }

  function directoryChain(relPath) {
    const chain = ["."];
    const parent = toPosix(dirname(relPath));
    if (!parent || parent === ".") return chain;
    const parts = parent.split("/").filter(Boolean);
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      chain.push(current);
    }
    return chain;
  }

  function isIgnored(relPath, isDirectory = false) {
    const normalized = toPosix(relPath).replace(/\/$/, "");
    if (!normalized) return false;
    const candidate = isDirectory ? `${normalized}/` : normalized;
    if (hard.ignores(candidate)) return true;

    let ignored = false;
    for (const directory of directoryChain(normalized)) {
      loadDirectory(directory === "." ? root : join(root, directory));
      const matcher = rulesByDirectory.get(directory);
      if (!matcher) continue;
      const local = directory === "."
        ? candidate
        : candidate.slice(directory.length + 1);
      if (!local) continue;
      const result = matcher.test(local);
      if (result.ignored) ignored = true;
      if (result.unignored) ignored = false;
    }
    return ignored;
  }

  loadDirectory(root);
  return {
    root,
    loadDirectory,
    isIgnored,
    status() {
      return {
        loadedIgnoreFiles: [...loadedFiles].sort(),
        loadedDirectoryCount: rulesByDirectory.size,
        hardExcludeCount: HARD_EXCLUDES.length + (opts.hardExcludes || []).length,
      };
    },
  };
}
