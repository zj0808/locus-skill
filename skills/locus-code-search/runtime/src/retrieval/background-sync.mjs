/**
 * F4: 常驻文件监听——保存文件即后台增量同步图/向量索引，把索引维护
 * 移出查询路径（改完代码后的第一次查询不再付同步成本）。
 *
 * 设计约束：
 * - fs.watch 失败（网络盘 / 旧内核 Linux 不支持 recursive）时静默降级，
 *   行为退回"查询时同步"，与关闭本功能完全一致。
 * - 事件先过项目忽略规则（.gitignore/.locusignore/硬排除），npm install
 *   之类的 node_modules 抖动不会触发重建风暴。
 * - 防抖 + 最小同步间隔双保险；同步进行中再来事件则记账，结束后补一轮。
 * - 后台同步任何失败都只记在状态里，绝不影响查询路径。
 * - LOCUS_WATCH=off 一键停用。
 */

import { watch } from "node:fs";
import { resolve } from "node:path";

import { syncNativeJsGraphIndex } from "../graph/native-js-provider.mjs";
import { ensureVectorIndex } from "./vector-provider.mjs";
import { createProjectIgnoreMatcher } from "./project-ignore.mjs";
import { MAX_RESIDENT_PROJECTS } from "../resource-limits.mjs";

function watchEnabled() {
  return !["0", "false", "no", "off"].includes(
    String(process.env.LOCUS_WATCH ?? "on").trim().toLowerCase(),
  );
}

const DEFAULT_DEBOUNCE_MS = (() => {
  const parsed = Number.parseInt(process.env.LOCUS_WATCH_DEBOUNCE_MS ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 800;
})();
const DEFAULT_MIN_SYNC_GAP_MS = 5000;

const states = new Map(); // projectRoot -> state

function toPosix(path) {
  return String(path || "").replace(/\\/g, "/").replace(/^\.\//, "");
}

function scheduleSync(state) {
  if (state.disposed) return;
  if (state.pendingTimer) clearTimeout(state.pendingTimer);
  state.pendingTimer = setTimeout(() => {
    state.pendingTimer = null;
    if (!state.disposed) void runSync(state);
  }, state.debounceMs);
  state.pendingTimer.unref?.();
}

async function runSync(state) {
  if (state.disposed) return;
  if (state.syncing) {
    state.dirtyWhileSyncing = true;
    return;
  }
  const sinceLast = Date.now() - state.lastSyncAtMs;
  if (state.lastSyncAtMs && sinceLast < state.minSyncGapMs) {
    // 距上次同步太近：把剩余间隔当作新的防抖窗口
    if (state.pendingTimer) clearTimeout(state.pendingTimer);
    state.pendingTimer = setTimeout(() => {
      state.pendingTimer = null;
      void runSync(state);
    }, state.minSyncGapMs - sinceLast);
    state.pendingTimer.unref?.();
    return;
  }
  state.syncing = true;
  try {
    if (state.graphEnabled) {
      try {
        await syncNativeJsGraphIndex(state.root);
      } catch (error) {
        state.lastError = `graph: ${error?.message || error}`;
      }
    }
    try {
      // 向量索引以图符号为切块单元，跟在图同步之后；模型缺失时自身静默返回 null。
      await ensureVectorIndex(state.root);
    } catch (error) {
      state.lastError = `vector: ${error?.message || error}`;
    }
    state.syncCount += 1;
    state.lastSyncAtMs = Date.now();
  } finally {
    state.syncing = false;
    if (!state.disposed && state.dirtyWhileSyncing) {
      state.dirtyWhileSyncing = false;
      scheduleSync(state);
    }
  }
}

function onWatchEvent(state, fileName) {
  if (state.disposed) return;
  const rel = toPosix(fileName);
  if (!rel) return;
  if (rel === ".locus-mcp" || rel.startsWith(".locus-mcp/")) return; // 自写文件
  try {
    // 忽略规则挡掉 node_modules/.git/构建产物等抖动源。matcher 在注册时
    // 加载一次忽略文件；之后对忽略文件本身的修改不热更（重启进程生效）。
    // fs.watch 的事件名不区分文件/目录，而 "node_modules/" 这类 dir-only
    // 模式匹配不到裸目录名——两种解释都测，任一命中即跳过。
    if (state.matcher?.isIgnored(rel, false) || state.matcher?.isIgnored(rel, true)) return;
  } catch {
    // 匹配器异常时保守放行，宁可多同步一轮
  }
  state.eventCount += 1;
  state.lastEventAtMs = Date.now();
  scheduleSync(state);
}

/**
 * 注册（或更新）一个项目根的常驻监听。幂等：同一 root 复用已有 watcher，
 * 只刷新 graphEnabled 开关。返回状态对象；停用或失败时 active=false。
 */
export function watchProjectForIndexSync(projectRoot, opts = {}) {
  if (!watchEnabled() || opts.enabled === false) return null;
  const root = resolve(projectRoot);
  const existing = states.get(root);
  if (existing) {
    if (typeof opts.graphEnabled === "boolean") existing.graphEnabled = opts.graphEnabled;
    states.delete(root);
    states.set(root, existing);
    return existing;
  }

  const state = {
    root,
    active: false,
    error: null,
    lastError: null,
    eventCount: 0,
    syncCount: 0,
    lastEventAtMs: 0,
    lastSyncAtMs: 0,
    pendingTimer: null,
    syncing: false,
    dirtyWhileSyncing: false,
    graphEnabled: opts.graphEnabled !== false,
    debounceMs: Number.isFinite(opts.debounceMs) ? Math.max(0, opts.debounceMs) : DEFAULT_DEBOUNCE_MS,
    minSyncGapMs: Number.isFinite(opts.minSyncGapMs) ? Math.max(0, opts.minSyncGapMs) : DEFAULT_MIN_SYNC_GAP_MS,
    matcher: null,
    handle: null,
    disposed: false,
  };
  try {
    state.matcher = createProjectIgnoreMatcher(root);
    state.handle = watch(root, { recursive: true, persistent: false }, (_eventType, fileName) => {
      onWatchEvent(state, fileName);
    });
    state.handle.unref?.();
    state.handle.on("error", (error) => {
      state.active = false;
      state.error = error?.message || String(error);
    });
    state.active = true;
  } catch (error) {
    state.error = error?.message || String(error);
  }
  states.set(root, state);
  while (states.size > MAX_RESIDENT_PROJECTS) {
    const oldestRoot = states.keys().next().value;
    const oldest = states.get(oldestRoot);
    states.delete(oldestRoot);
    disposeState(oldest);
  }
  return state;
}

function disposeState(state) {
  if (!state || state.disposed) return;
  state.disposed = true;
  state.active = false;
  state.dirtyWhileSyncing = false;
  if (state.pendingTimer) clearTimeout(state.pendingTimer);
  state.pendingTimer = null;
  try { state.handle?.close(); } catch { /* already closed */ }
  state.handle = null;
}

/** 状态快照（供 locus_index_status 观测）。未注册返回 null。 */
export function getBackgroundSyncStatus(projectRoot) {
  const state = states.get(resolve(projectRoot));
  if (!state) return { registered: false, enabled: watchEnabled() };
  return {
    registered: true,
    enabled: watchEnabled(),
    active: state.active,
    graphEnabled: state.graphEnabled,
    eventCount: state.eventCount,
    syncCount: state.syncCount,
    lastEventAtMs: state.lastEventAtMs,
    lastSyncAtMs: state.lastSyncAtMs,
    syncing: state.syncing,
    error: state.error,
    lastError: state.lastError,
  };
}

export function getBackgroundSyncResidentStatus() {
  return {
    maxResidentProjects: MAX_RESIDENT_PROJECTS,
    residentRoots: [...states.keys()],
  };
}

/** 停掉全部监听（测试/退出用）。 */
export function stopAllBackgroundSync() {
  for (const state of states.values()) disposeState(state);
  states.clear();
}
