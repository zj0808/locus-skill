/**
 * 中英查询桥接（检索前查询增强）。
 *
 * 本地雷达的打分是词法/标识符导向的，向量模型的中英跨语言对齐也弱——
 * 纯中文查询在本地几乎拿不到可靠信号，只能花几秒走远程验证。
 * 这里用一份精选的开发领域中英词表，把中文查询扩展出英文标识符词，
 * 注入三路本地雷达：中文题在本地就能命中，远程只留给真正的硬题。
 *
 * 纯本地、零网络调用；LOCUS_QUERY_BRIDGE=off 可整体关闭。
 */

const BRIDGE_ENABLED = !["0", "false", "no", "off"].includes(
  String(process.env.LOCUS_QUERY_BRIDGE ?? "on").trim().toLowerCase(),
);

// 中文词 → 英文标识符词（空格分隔多个）。按高频开发词汇精选；
// 命中按键长优先（连接池 优先于 连接）。
const DICT = {
  // 认证与安全
  "鉴权": "auth authorize", "认证": "auth authentication", "登录": "login signin",
  "登出": "logout signout", "注册": "register signup", "令牌": "token",
  "刷新": "refresh", "会话": "session", "密钥": "key secret apikey",
  "密码": "password", "加密": "encrypt", "解密": "decrypt",
  "签名": "sign signature", "校验": "validate check", "验证": "verify validate",
  "权限": "permission role", "管理员": "admin", "越权": "privilege",
  "注入": "injection", "跨域": "cors",
  // 配额与限流
  "配额": "quota", "限额": "limit quota", "额度": "quota limit",
  "限流": "rate limit throttle", "限速": "rate limit", "签到": "checkin",
  "计费": "billing billable", "扣费": "charge deduct",
  // 网络与服务
  "请求": "request", "响应": "response", "接口": "api endpoint",
  "路由": "route router", "中间件": "middleware", "拦截器": "interceptor",
  "网关": "gateway", "代理": "proxy", "转发": "forward relay",
  "负载均衡": "load balancer", "熔断": "circuit breaker", "降级": "fallback degrade",
  "超时": "timeout", "重试": "retry", "重连": "reconnect", "断线": "disconnect",
  "长连接": "keepalive", "轮询": "poll polling", "心跳": "heartbeat",
  "探针": "probe", "健康检查": "health healthcheck", "状态码": "status code",
  "头部": "header", "请求头": "header", "响应头": "header",
  "流式": "stream streaming", "推送": "push", "订阅": "subscribe",
  "发布": "publish release", "广播": "broadcast", "套接字": "socket websocket",
  // 数据与存储
  "数据库": "database db", "连接池": "connection pool", "事务": "transaction",
  "迁移": "migration", "索引": "index", "缓存": "cache", "队列": "queue",
  "分页": "pagination page", "排序": "sort order", "过滤": "filter",
  "去重": "dedupe deduplicate", "序列化": "serialize", "反序列化": "deserialize",
  "压缩": "compress gzip", "快照": "snapshot", "备份": "backup",
  "恢复": "restore recover recovery", "回滚": "rollback", "落库": "persist insert",
  "持久化": "persist persistence", "读取": "read load", "写入": "write save",
  "删除": "delete remove", "更新": "update", "查询": "query search",
  "字段": "field column", "表": "table", "行": "row", "列": "column",
  // 检索领域
  "检索": "search retrieval", "搜索": "search", "召回": "recall",
  "精确": "exact precision", "模糊": "fuzzy", "匹配": "match",
  "打分": "score scoring", "评分": "score rating", "排行榜": "leaderboard ranking",
  "阈值": "threshold", "置信度": "confidence", "权重": "weight",
  "分词": "tokenize token", "词表": "vocab dictionary", "向量": "vector embedding",
  "语义": "semantic", "图谱": "graph", "符号": "symbol",
  // 任务与调度
  "定时任务": "cron schedule scheduled", "调度": "schedule scheduler",
  "并发": "concurrent concurrency", "异步": "async", "同步": "sync",
  "锁": "lock mutex", "线程": "thread", "进程": "process",
  "协程": "goroutine coroutine", "通道": "channel", "上下文": "context",
  "中断": "abort cancel", "取消": "cancel", "信号": "signal",
  "退出": "exit shutdown", "优雅停机": "graceful shutdown",
  "启动": "start startup boot", "重启": "restart", "守护进程": "daemon",
  "监听": "listen watch watcher", "回调": "callback", "钩子": "hook",
  "事件": "event", "消息": "message", "通知": "notification notify",
  "防抖": "debounce", "节流": "throttle",
  // 配置与部署
  "配置": "config configuration", "环境变量": "env environment variable",
  "部署": "deploy deployment", "构建": "build", "打包": "bundle package",
  "编译": "compile", "安装": "install", "升级": "upgrade update",
  "版本": "version", "发版": "release", "镜像": "image docker",
  "容器": "container docker", "编排": "compose orchestration",
  "证书": "certificate cert tls ssl", "域名": "domain dns",
  "端口": "port", "挂载": "mount volume", "日志轮转": "log rotation",
  // 可观测
  "日志": "log logging", "监控": "monitor monitoring", "告警": "alert",
  "指标": "metric", "埋点": "telemetry track", "遥测": "telemetry",
  "统计": "stats statistics count", "趋势": "trend", "图表": "chart",
  "仪表盘": "dashboard", "耗时": "duration elapsed latency", "延迟": "latency delay",
  "性能": "performance perf", "内存": "memory", "泄漏": "leak",
  "瓶颈": "bottleneck", "采样": "sample sampling", "吞吐": "throughput",
  // 错误处理
  "错误": "error", "异常": "exception", "报错": "error fail",
  "失败": "fail failure failed", "成功": "success ok", "崩溃": "crash panic",
  "兜底": "fallback", "容错": "fault tolerant", "断言": "assert",
  "边界": "boundary edge", "空值": "null nil undefined empty",
  // 代码结构
  "函数": "function func", "方法": "method", "类": "class",
  "结构体": "struct", "枚举": "enum", "常量": "const constant",
  "变量": "variable var", "参数": "param parameter argument",
  "返回值": "return result", "类型": "type", "泛型": "generic",
  "实现": "implement implementation", "定义": "define definition declare",
  "声明": "declare declaration", "调用": "call invoke", "引用": "reference ref",
  "继承": "extend inherit", "实例": "instance", "单例": "singleton",
  "工厂": "factory", "适配器": "adapter", "装饰器": "decorator",
  "处理器": "handler", "处理": "handle process", "解析": "parse parser",
  "生成": "generate create", "创建": "create new", "初始化": "init initialize",
  "销毁": "destroy dispose", "注册表": "registry", "模块": "module",
  "依赖": "dependency import", "导入": "import", "导出": "export",
  "包": "package", "注释": "comment", "递归": "recursive recursion",
  "遍历": "traverse iterate loop", "迭代": "iterate iteration",
  "哈希": "hash", "字典": "dict map", "数组": "array list",
  "字符串": "string", "布尔": "bool boolean", "指针": "pointer",
  "切片": "slice", "截断": "truncate", "拼接": "concat join",
  "分割": "split", "替换": "replace", "转换": "convert transform",
  "格式化": "format", "编码": "encode encoding", "解码": "decode",
  // 测试与质量
  "测试": "test", "单测": "unit test", "集成测试": "integration test",
  "冒烟": "smoke", "基准": "benchmark", "覆盖率": "coverage",
  "模拟": "mock", "修复": "fix", "缺陷": "bug defect",
  "重构": "refactor", "优化": "optimize optimization",
  // 前端
  "组件": "component", "样式": "style css", "布局": "layout",
  "响应式": "responsive", "主题": "theme", "暗色": "dark",
  "亮色": "light", "弹窗": "modal dialog popup", "表单": "form",
  "输入框": "input", "按钮": "button", "下拉": "dropdown select",
  "列表": "list", "表格": "table", "卡片": "card", "标签": "tag label badge",
  "详情": "detail", "首页": "home landing", "控制台": "console dashboard",
  "侧边栏": "sidebar", "导航": "nav navigation", "图标": "icon",
  "骨架屏": "skeleton", "加载": "load loading", "渲染": "render",
  "滚动": "scroll", "拖拽": "drag drop", "复制": "copy clipboard",
  "粘贴": "paste", "快捷键": "shortcut hotkey keybinding",
  "高亮": "highlight", "动画": "animation animate", "过渡": "transition",
  "水合": "hydrate hydration", "静态": "static", "服务端渲染": "ssr server render",
  // 时间与窗口
  "每日": "daily", "今日": "today daily", "当日": "daily today",
  "每周": "weekly", "每月": "monthly", "时区": "timezone",
  "日期": "date", "时间戳": "timestamp", "窗口": "window",
  "区间": "range interval", "自然日": "calendar day daily",
  // 文件与路径
  "文件": "file", "目录": "directory folder dir", "路径": "path",
  "后缀": "extension ext", "扩展名": "extension", "行号": "line number",
  "根目录": "root", "相对路径": "relative path", "绝对路径": "absolute path",
  "忽略": "ignore exclude", "排除": "exclude", "通配符": "glob wildcard",
  // 服务角色
  "服务端": "server backend", "后端": "backend server", "客户端": "client",
  "前端": "frontend client", "上游": "upstream", "下游": "downstream",
  "中继": "relay", "用户": "user", "账号": "account", "订单": "order",
  "支付": "payment pay", "商品": "product item",
};

// 键按长度降序排列，扫描时长词优先（避免 连接池 被 连接 抢走）。
const KEYS_BY_LENGTH = Object.keys(DICT).sort((a, b) => b.length - a.length);
const DEFAULT_MAX_BRIDGE_TERMS = 24;

/**
 * 从查询中提取可桥接的英文扩展词。
 * @param {string} query
 * @returns {string[]} 去重后的英文词（≤12 个）；无桥接或已关闭时为空数组
 */
export function bridgeQueryTerms(query, opts = {}) {
  if (!BRIDGE_ENABLED) return [];
  const text = String(query || "");
  if (!/\p{Script=Han}/u.test(text)) return [];

  const maxTerms = Math.max(1, Number.parseInt(opts.maxTerms ?? DEFAULT_MAX_BRIDGE_TERMS, 10) || DEFAULT_MAX_BRIDGE_TERMS);
  const out = [];
  const seen = new Set();
  const occupied = [];
  const matches = [];
  for (const key of KEYS_BY_LENGTH) {
    let from = 0;
    while (from < text.length) {
      const index = text.indexOf(key, from);
      if (index < 0) break;
      matches.push({ key, index, end: index + key.length });
      from = index + Math.max(1, key.length);
    }
  }
  matches.sort((a, b) => a.index - b.index || b.key.length - a.key.length);
  for (const match of matches) {
    if (occupied.some(([start, end]) => match.index < end && match.end > start)) continue;
    occupied.push([match.index, match.end]);
    const key = match.key;
    for (const term of DICT[key].split(" ")) {
      if (seen.has(term)) continue;
      seen.add(term);
      out.push(term);
      if (out.length >= maxTerms) return out;
    }
  }
  return out;
}

/**
 * 返回附加了桥接词的查询文本（供向量嵌入用）。无桥接时原样返回。
 * @param {string} query
 * @returns {{ augmented: string, bridged: string[] }}
 */
export function bridgeQuery(query) {
  const bridged = bridgeQueryTerms(query);
  return {
    bridged,
    augmented: bridged.length ? `${query} ${bridged.join(" ")}` : String(query || ""),
  };
}
