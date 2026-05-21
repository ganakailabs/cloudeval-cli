#Requires -Version 7.0
$ErrorActionPreference = "Stop"

$refUrl = "https://api.github.com/repos/ganakailabs/cloudeval-cli/git/ref/heads/main"
$ref = Invoke-RestMethod -Uri $refUrl -Headers @{ "User-Agent" = "cloudeval-installer" }
$commitSha = $ref.object.sha
if (-not $commitSha) {
  Write-Error "Unable to resolve the latest Cloudeval installer version."
  exit 1
}

$installerUrl = "https://raw.githubusercontent.com/ganakailabs/cloudeval-cli/$commitSha/scripts/install.ps1"
$tmp = [System.IO.Path]::GetTempFileName()
try {
  Invoke-WebRequest -Uri $installerUrl -OutFile $tmp -UseBasicParsing
  & $tmp @args
  exit $LASTEXITCODE
} finally {
  Remove-Item -Path $tmp -Force -ErrorAction SilentlyContinue
}
