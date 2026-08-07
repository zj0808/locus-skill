---
name: locus-code-search
description: Run authenticated Locus semantic code search from this Skill's bundled runtime, without requiring an MCP server. Use automatically for code discovery when a file, symbol, implementation, subsystem, caller flow, dependency path, or cross-package behavior is unknown or must be found by meaning. Also use for Locus authentication setup, index status, and refresh. Do not use for an already-known exact file or symbol, or for pure git, build, test, and formatting work.
---

# Locus Code Search

This Skill executes the bundled Locus retrieval runtime directly. It is a capability, not instructions for calling the Locus MCP server.

## Entry Point

Resolve the directory containing this `SKILL.md` as `SKILL_DIR`. Run every operation through the bundled `locus` command:

```powershell
& "$SKILL_DIR/locus" <command> [options]
```

Never import files under `runtime/` directly. The wrapper enforces authentication before search, index creation, refresh, or status inspection.

## Authentication

The command requires a valid Locus API key. Credential precedence is:

1. The signed-in account stored in Windows Credential Manager.
2. A temporary environment or command-line override for CI, when supported by the runtime.

Use these commands for persistent credentials:

```powershell
& "$SKILL_DIR/locus" auth login
& "$SKILL_DIR/locus" auth set-key
& "$SKILL_DIR/locus" auth status
& "$SKILL_DIR/locus" auth logout
& "$SKILL_DIR/locus" auth doctor
```

Treat the bundled command as the public entry point. When the user asks to configure, log in, or update authentication, run:

```powershell
& "$SKILL_DIR/locus" auth login
```

This opens the Locus sign-in page. Tell the user to finish browser sign-in, then retry the requested operation. The Skill receives a short-lived authorization code on `127.0.0.1`, exchanges it with PKCE, and stores the signed-in account's key in Windows Credential Manager. Do not ask the user to paste a key into the agent conversation.

Require Windows x64, PowerShell 7, and Node.js 18 or newer. `auth login` uses browser authorization. `auth set-key` is the manual fallback and securely prompts for a key without opening a browser. `auth doctor` verifies that the bundled native credential adapter can round-trip a temporary value. The Node entry point performs all Credential Manager access, including under PowerShell `ConstrainedLanguage` mode.

Do not place keys in prompts, source files, config files, command output, or search arguments. Use `--key` only for non-interactive automation when command-line exposure is acceptable.

### Windows terminal setup

For a clean global Codex installation, run this sequence from PowerShell:

```powershell
npx skills remove -g -a codex -s locus-code-search -y
npx skills add zj0808/locus-skill -g -a codex -s locus-code-search -y
Set-Location "$HOME\.agents\skills\locus-code-search"
.\locus auth login
.\locus auth status
```

The first two commands replace the installed Skill from GitHub. `auth login`
opens browser authorization and saves the signed-in account key in Windows
Credential Manager. Do not paste the key into the terminal transcript, this
file, or an agent conversation.

The non-secret relay URL is stored in the Skill's local configuration. Use the `config` command only when a custom Locus endpoint is required.

```powershell
& "$SKILL_DIR/locus" config set base-url "https://HOST/relay"
& "$SKILL_DIR/locus" config get base-url
```

When authentication is missing or rejected, stop the discovery operation and launch the authentication window once. Do not fall back to local-only Locus retrieval or another credential.

## Search

Start with one descriptive natural-language query at the smallest plausible package root:

```powershell
& "$SKILL_DIR/locus" search `
  --query "function that validates user email and returns a boolean" `
  --project-path "backend" `
  --max-turns 2
```

Supported options mirror `locus_mcp_search`:

- `--project-path PATH`
- `--path-filter PATH`
- `--tree-depth 1..6`
- `--max-turns 1..5`
- `--max-results 1..30`
- `--result-mode complete|focused`
- `--cursor CURSOR`
- `--page-size 1..100`
- `--include-all-ranges true|false`
- `--exhaustive true|false`
- `--exclude-path PATH` (repeatable)

After the first result, read at least one strong hit and nearby code. If context is incomplete, run at most one narrowed retry with `--path-filter` set to the best hit's directory. Once the file or symbol is known, use direct reads or `rg` for exact and exhaustive occurrences.

Use `--max-turns 1` or `2` for simple discovery and `3` to `5` for cross-package tracing. Prefer package roots over a monorepo root, and use `--tree-depth 1` or `2` for large repositories.

## Index Status

Authentication is required for status and refresh:

```powershell
& "$SKILL_DIR/locus" index-status --project-path "backend"
& "$SKILL_DIR/locus" index-status --project-path "backend" --refresh
```

The runtime snapshot is private to this Skill. Updating this Skill does not edit or load the repository's MCP server files.
