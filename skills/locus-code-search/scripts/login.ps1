$ErrorActionPreference = "Continue"

$entryPoint = Join-Path $PSScriptRoot "ace.ps1"
$pwsh = @(Get-Command pwsh -CommandType Application -ErrorAction Stop)[0].Source

Write-Host "Locus Code Search authentication"
Write-Host ""
& $pwsh -NoProfile -File $entryPoint auth login
$exitCode = $LASTEXITCODE

Write-Host ""
if ($exitCode -eq 0) {
    Write-Host "Authentication complete. Return to your agent and retry the search."
} else {
    Write-Host "Authentication was not completed. Review the message above and try again."
}
Read-Host "Press Enter to close this window"
exit $exitCode
