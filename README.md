# Locus Code Search

一个需要 ACE 账户认证的 Agent Skill，用于语义代码检索。运行时已随 Skill
打包，不需要安装 MCP 服务或执行 `npm install`。

## 要求

- Windows 10/11 x64
- PowerShell 7（`pwsh`）
- Node.js 18 或更高版本
- ACE 账户

## 安装与登录

以下命令适用于 Windows 上全局安装到 Codex：

```powershell
# 卸载旧版本（首次安装可跳过）
npx skills remove -g -a codex -s locus-code-search -y

# 从 GitHub 安装最新版
npx skills add zj0808/locus-skill -g -a codex -s locus-code-search -y

# 进入 Skill 目录
Set-Location "$HOME\.agents\skills\locus-code-search"

# 浏览器登录
.\locus auth login

# 查看登录状态
.\locus auth status
```

登录后，API Key 保存在 Windows Credential Manager，不会写入 Skill、仓库或
普通文本配置文件。检查凭据适配器：

```powershell
.\locus auth doctor
```

退出登录并删除本机凭据：

```powershell
.\locus auth logout
```

## 使用

安装并登录后，在 Codex 或其他兼容 Agent 中直接提出检索请求，例如：

```text
Use locus-code-search to find where session tokens are validated in this project.
```

也可以在终端直接运行：

```powershell
.\locus search `
  --query "function that validates session tokens" `
  --project-path "D:\path\to\project" `
  --max-turns 2
```

## 更新与卸载

```powershell
npx skills update locus-code-search -g
npx skills remove -g -a codex -s locus-code-search -y
```

## 其他 Agent

安装到其他支持 Agent Skills 的宿主时，去掉 `-a codex` 或替换为目标宿主的
名称，并使用安装命令输出的目录。Skill 只负责调用本地检索运行时，不会替换
或修改已有的 Locus MCP 安装。

## 许可证

MIT。第三方依赖许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
