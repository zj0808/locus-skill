$ErrorActionPreference = "Continue"

$entryPoint = Join-Path $PSScriptRoot "ace.ps1"
$pwsh = @(Get-Command pwsh -CommandType Application -ErrorAction Stop)[0].Source

Write-Host "Locus Code Search authentication"
Write-Host ""
Write-Host "Your browser will open for ACE sign-in."
Write-Host "After sign-in, this window stores the account key in Windows Credential Manager."
Write-Host "Press Ctrl+C to cancel."
Write-Host ""
& $pwsh -NoProfile -File $entryPoint auth login
$exitCode = $LASTEXITCODE

Write-Host ""
if ($exitCode -eq 0) {
    Write-Host "Authentication complete. This window will close automatically."
    Start-Sleep -Seconds 2
} else {
    Write-Host "Authentication was not completed. Review the message above and try again."
    Read-Host "Press Enter to close this window"
}
exit $exitCode
