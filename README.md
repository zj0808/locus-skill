# Locus Code Search

An authenticated [Agent Skill](https://agentskills.io) for semantic code discovery. It runs a bundled Locus runtime directly, so an MCP server is not required.

The Skill requires the user's own ACE API key for search, index status, and index refresh. It never falls back to unauthenticated retrieval and does not modify an existing Locus MCP installation.

The runtime dependencies are bundled; users do not need to run `npm install` inside the Skill.

## Quick start

### 1. Install from a terminal (recommended)

The open [`skills`](https://github.com/vercel-labs/skills) CLI supports Codex, Claude Code, Cursor, OpenCode, GitHub Copilot, Windsurf, Gemini CLI, and many other Agent Skills hosts.

Install for the current project:

```powershell
npx skills add zj0808/locus-skill
```

Install globally so the Skill is available in every project:

```powershell
npx skills add zj0808/locus-skill -g
```

The CLI detects installed agents and lets the user choose the target. A fully non-interactive Codex install is:

```powershell
npx skills add zj0808/locus-skill -g -a codex -s locus-code-search -y
```

Replace `codex` with another supported agent name when needed. If a host does not detect the newly installed Skill immediately, start a new agent session.

#### Codex conversation install

Paste this into Codex:

```text
Use $skill-installer to install https://github.com/zj0808/locus-skill/tree/main/skills/locus-code-search
```

This is a Codex-specific convenience. The terminal command above is the portable installation method.

### 2. Sign in to ACE

Ask the installed agent:

> Use locus-code-search to set up authentication.

The Skill opens the ACE website in the default browser. Sign in normally; the browser returns a short-lived authorization code to the Skill on `127.0.0.1`, and the Skill saves the account's API key in Windows Credential Manager. The key is never placed in the browser callback URL, the Skill, or its config file. No PowerShell script command is required in the normal Agent workflow.

### 3. Search

Ask the installed agent:

> Use locus-code-search to find where session tokens are validated in this project.

The host loads the Skill automatically based on its name and description. Installing a Skill does not install an agent host; Codex, Claude Code, Cursor, or another compatible host is still required for automatic invocation.

## Manage the installation

List, update, or remove the Skill from a terminal:

```powershell
npx skills list -g
npx skills update locus-code-search -g
npx skills remove locus-code-search -g
```

## Requirements

- Windows 10/11 x64
- PowerShell 7 (`pwsh`)
- Node.js 18 or newer
- An ACE account

## Authentication details

For standalone terminal administration, change to the installed Skill directory and use its `locus` command:

```powershell
.\locus auth doctor
.\locus auth status
```

Persistent credentials are stored in Windows Credential Manager under service `Ace.Locus.ApiKey` and account `ACE`. The API key is not written to the Skill or its config file. `ACE_API_KEY` provides a temporary override for CI or the current process.

Browser login uses an authorization code with PKCE. The callback listens only on `127.0.0.1` at a random port and stops after login or timeout. For manual key entry, use:

```powershell
.\locus auth set-key
```

PowerShell `ConstrainedLanguage` is supported because credential access and hidden key input are handled by the bundled Node native adapter.

Remove the stored key with:

```powershell
.\locus auth logout
```

## Standalone terminal use

An agent host is optional when calling the bundled command directly:

```powershell
git clone https://github.com/zj0808/locus-skill.git
Set-Location .\locus-skill\skills\locus-code-search
.\locus auth login
```

Then run a search:

```powershell
.\locus search `
  --query "function that validates session tokens" `
  --project-path "D:\path\to\project" `
  --max-turns 2
```

The relay defaults to `https://ace.panrun.me/relay`. Configure a different non-secret endpoint with `config set base-url` or the temporary `ACE_BASE_URL` environment variable.

## License

MIT. Bundled dependency licenses are retained next to their files and summarized in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
