$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$script:DefaultBaseUrl = "https://ace.panrun.me/relay"
$script:NodeEntry = Join-Path $PSScriptRoot "search.mjs"
$script:ConfigDir = Join-Path ([Environment]::GetFolderPath("ApplicationData")) "Ace"
$script:ConfigPath = Join-Path $script:ConfigDir "config.json"

function Read-AceConfig {
    if (-not (Test-Path -LiteralPath $script:ConfigPath)) {
        return @{ baseUrl = $script:DefaultBaseUrl }
    }

    try {
        $config = Get-Content -LiteralPath $script:ConfigPath -Raw | ConvertFrom-Json -AsHashtable
        $baseUrl = [string]$config["baseUrl"]
        if ([string]::IsNullOrWhiteSpace($baseUrl)) {
            $baseUrl = $script:DefaultBaseUrl
        }
        return @{ baseUrl = $baseUrl }
    } catch {
        throw "Invalid ACE config at $script:ConfigPath. Run: ace.ps1 config set base-url URL"
    }
}

function Normalize-BaseUrl([string]$Value) {
    $value = $Value.Trim().TrimEnd("/")
    $uri = $null
    if (-not [Uri]::TryCreate($value, [UriKind]::Absolute, [ref]$uri) -or $uri.Scheme -notin @("http", "https")) {
        throw "ACE base URL must be an absolute http(s) URL."
    }
    return $value
}

function Get-AceBaseUrl {
    if (-not [string]::IsNullOrWhiteSpace($env:ACE_BASE_URL)) {
        return Normalize-BaseUrl $env:ACE_BASE_URL
    }
    $config = Read-AceConfig
    return Normalize-BaseUrl ([string]$config["baseUrl"])
}

function Write-AceBaseUrl([string]$Value) {
    $normalized = Normalize-BaseUrl $Value
    New-Item -ItemType Directory -Force -Path $script:ConfigDir | Out-Null
    @{ baseUrl = $normalized } |
        ConvertTo-Json |
        Set-Content -LiteralPath $script:ConfigPath -Encoding utf8
    return $normalized
}

function Test-Option([string[]]$Values, [string]$Name) {
    return $Values -contains $Name
}

function Invoke-AceNode([string[]]$NodeArguments, [string]$BaseUrl) {
    $node = (Get-Command node -CommandType Application -ErrorAction Stop).Source
    $oldBaseUrl = [Environment]::GetEnvironmentVariable("ACE_BASE_URL", "Process")
    try {
        $env:ACE_BASE_URL = $BaseUrl
        & $node $script:NodeEntry @NodeArguments | Out-Host
        $exitCode = $LASTEXITCODE
    } finally {
        [Environment]::SetEnvironmentVariable("ACE_BASE_URL", $oldBaseUrl, "Process")
    }
    return $exitCode
}

function Show-Help {
    @"
ACE Locus Skill

Usage:
  ace.ps1 search --query TEXT [--project-path PATH] [search options]
  ace.ps1 index-status [--project-path PATH] [--refresh]
  ace.ps1 auth login [--no-browser]
  ace.ps1 auth set-key [--key KEY]
  ace.ps1 auth status
  ace.ps1 auth logout
  ace.ps1 auth doctor
  ace.ps1 config set base-url URL
  ace.ps1 config get base-url

Environment:
  ACE_API_KEY   Temporary/CI key override
  ACE_BASE_URL  Temporary relay URL override

Requirements:
  Windows x64, PowerShell 7, and Node.js 18 or newer
"@
}

$command = if ($args.Count -gt 0) { [string]$args[0] } else { "help" }
$tail = @(
    if ($args.Count -gt 1) { $args[1..($args.Count - 1)] }
)

try {
    switch ($command.ToLowerInvariant()) {
        "auth" {
            $subcommand = if ($tail.Count -gt 0) { ([string]$tail[0]).ToLowerInvariant() } else { "status" }
            $authArgs = @(
                if ($tail.Count -gt 1) { $tail[1..($tail.Count - 1)] }
            )
            switch ($subcommand) {
                "login" {
                    if (-not (Test-Option $authArgs "--no-browser")) {
                        $dashboard = (Get-AceBaseUrl) -replace "/relay$", ""
                        Start-Process -FilePath ($dashboard + "/console")
                    }
                    $forwarded = @($authArgs | Where-Object { $_ -ne "--no-browser" })
                    $exitCode = Invoke-AceNode -NodeArguments (@("auth-set") + $forwarded) -BaseUrl (Get-AceBaseUrl)
                    exit $exitCode
                }
                "set-key" {
                    $exitCode = Invoke-AceNode -NodeArguments (@("auth-set") + $authArgs) -BaseUrl (Get-AceBaseUrl)
                    exit $exitCode
                }
                "status" {
                    $exitCode = Invoke-AceNode -NodeArguments @("auth-status") -BaseUrl (Get-AceBaseUrl)
                    exit $exitCode
                }
                "logout" {
                    $exitCode = Invoke-AceNode -NodeArguments @("auth-logout") -BaseUrl (Get-AceBaseUrl)
                    exit $exitCode
                }
                "doctor" {
                    $exitCode = Invoke-AceNode -NodeArguments @("auth-doctor") -BaseUrl (Get-AceBaseUrl)
                    exit $exitCode
                }
                default { throw "Unknown auth command: $subcommand" }
            }
        }
        "config" {
            if ($tail.Count -lt 2) { throw "Usage: ace.ps1 config get base-url | config set base-url URL" }
            $operation = ([string]$tail[0]).ToLowerInvariant()
            $name = ([string]$tail[1]).ToLowerInvariant()
            if ($name -ne "base-url") { throw "Unknown config key: $name" }
            if ($operation -eq "get") {
                Write-Output (Get-AceBaseUrl)
            } elseif ($operation -eq "set") {
                if ($tail.Count -lt 3) { throw "A base URL value is required." }
                Write-Output "Base URL: $(Write-AceBaseUrl ([string]$tail[2]))"
            } else {
                throw "Unknown config operation: $operation"
            }
        }
        { $_ -in @("search", "index-status") } {
            $nodeArguments = @($command.ToLowerInvariant()) + $tail
            $exitCode = Invoke-AceNode -NodeArguments $nodeArguments -BaseUrl (Get-AceBaseUrl)
            exit $exitCode
        }
        { $_ -in @("help", "--help", "-h") } { Show-Help }
        default { throw "Unknown command: $command" }
    }
} catch {
    Write-Error $_.Exception.Message
    exit 1
}
