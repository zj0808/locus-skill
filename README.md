# Locus Code Search

An authenticated Codex Skill for semantic code discovery. It runs a bundled Locus runtime directly, so an MCP server is not required.

The Skill requires the user's own ACE API key for search, index status, and index refresh. It never falls back to unauthenticated retrieval and does not modify an existing Locus MCP installation.

No package download or `npm install` is required.

## Quick start

### 1. Install

Paste this into Codex:

```text
Use $skill-installer to install https://github.com/zj0808/locus-skill/tree/main/skills/locus-code-search
```

The Skill becomes available on the next Codex turn as `$locus-code-search`.

### 2. Add your ACE API key

Run this once in PowerShell 7:

```powershell
$codexHome = $env:CODEX_HOME
if (-not $codexHome) { $codexHome = Join-Path $env:USERPROFILE ".codex" }
$skillDir = Join-Path $codexHome "skills\locus-code-search"
pwsh -NoProfile -File "$skillDir\scripts\ace.ps1" auth login
```

The key is entered through a hidden prompt and stored in Windows Credential Manager. It is not written to the Skill or its config file.

### 3. Search

```text
Use $locus-code-search to find where session tokens are validated in this project.
```

## Requirements

- Windows 10/11 x64
- PowerShell 7 (`pwsh`)
- Node.js 18 or newer
- An ACE API key

## Authentication details

```powershell
pwsh -NoProfile -File "$skillDir\scripts\ace.ps1" auth doctor
pwsh -NoProfile -File "$skillDir\scripts\ace.ps1" auth status
```

Persistent credentials are stored in Windows Credential Manager under service `Ace.Locus.ApiKey` and account `ACE`. The API key is not written to the Skill or its config file. `ACE_API_KEY` provides a temporary override for CI or the current process.

PowerShell `ConstrainedLanguage` is supported because credential access and hidden key input are handled by the bundled Node native adapter.

Remove the stored key with:

```powershell
pwsh -NoProfile -File "$skillDir\scripts\ace.ps1" auth logout
```

## Manual use

Manual search is also available:

```powershell
pwsh -NoProfile -File "$skillDir\scripts\ace.ps1" search `
  --query "function that validates session tokens" `
  --project-path "backend" `
  --max-turns 2
```

The relay defaults to `https://ace.panrun.me/relay`. Configure a different non-secret endpoint with `config set base-url` or the temporary `ACE_BASE_URL` environment variable.

## License

MIT. Bundled dependency licenses are retained next to their files and summarized in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
