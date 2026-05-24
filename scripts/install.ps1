#Requires -Version 7.0
[CmdletBinding()]
param(
  [string] $Version = "latest",
  [switch] $SelfTestDownloadPlan,
  [string] $SelfTestAsset = "cloudeval-macos-arm64",
  [switch] $SelfTestTelemetryConfigure,
  [string] $SelfTestTelemetryDest = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$Repo = "ganakailabs/cloudeval-cli"
$BinName = "cloudeval"

function Write-Info([string] $Message) { Write-Host $Message -ForegroundColor Cyan }
function Write-Ok([string] $Message) { Write-Host $Message -ForegroundColor Green }
function Write-Warn([string] $Message) { Write-Host $Message -ForegroundColor Yellow }
function Write-Err([string] $Message) { Write-Host $Message -ForegroundColor Red }

function Test-AssumeYes {
  return $env:CLOUDEVAL_ASSUME_YES -eq "1" -or $env:CI -eq "true"
}

function Test-CanPrompt {
  return -not (Test-AssumeYes) -and -not [Console]::IsInputRedirected
}

function Ask-YesNo {
  param(
    [string] $Prompt,
    [bool] $Default = $false
  )
  if (Test-AssumeYes) { return $Default }
  $suffix = if ($Default) { "[Y/n]" } else { "[y/N]" }
  $answer = Read-Host "$Prompt $suffix"
  if ([string]::IsNullOrWhiteSpace($answer)) { return $Default }
  return $answer -match "^(y|yes)$" -or $answer -match "^(Y|YES)$"
}

function Test-TelemetryEnvDisables {
  $disabled = @("1", "true", "TRUE", "yes", "YES", "on", "ON")
  $off = @("0", "false", "FALSE", "no", "NO", "off", "OFF")
  return $disabled -contains $env:CLOUDEVAL_TELEMETRY_DISABLED -or
    $off -contains $env:CLOUDEVAL_TELEMETRY
}

function Write-TelemetryNotice {
  Write-Info "Telemetry"
  Write-Host "  CloudEval sends limited CLI usage events to Azure Application Insights to improve reliability."
  Write-Host "  It does not send prompts, command output, tokens, local paths, project/resource/account/session/tenant IDs, stack traces, or cloud resource names."
  Write-Host "  It may include CLI/runtime versions and signed-in email/name after login."
}

function Set-TelemetryOptOut {
  param([string] $Dest)
  try {
    & $Dest config set telemetry.enabled false --format json | Out-Null
    Write-Ok "Telemetry disabled in CloudEval CLI config."
  } catch {
    Write-Warn "Could not write telemetry preference automatically. Run:"
    Write-Host "  $BinName config set telemetry.enabled false"
  }
}

function Set-TelemetryPreference {
  param([string] $Dest)
  Write-Host ""
  Write-TelemetryNotice

  if (Test-TelemetryEnvDisables) {
    Set-TelemetryOptOut -Dest $Dest
    return
  }

  if (-not [string]::IsNullOrWhiteSpace($env:CLOUDEVAL_SELF_TEST_TELEMETRY_ANSWER)) {
    if ($env:CLOUDEVAL_SELF_TEST_TELEMETRY_ANSWER -match "^(y|yes|true|1)$") {
      Write-Ok "Telemetry enabled. Disable later with: $BinName config set telemetry.enabled false"
    } else {
      Set-TelemetryOptOut -Dest $Dest
    }
    return
  }

  if (Test-CanPrompt) {
    if (Ask-YesNo "Share limited CLI telemetry?" $true) {
      Write-Ok "Telemetry enabled. Disable later with: $BinName config set telemetry.enabled false"
    } else {
      Set-TelemetryOptOut -Dest $Dest
    }
    return
  }

  Write-Ok "Telemetry enabled by default."
  Write-Host "  Disable with CLOUDEVAL_TELEMETRY=0 or $BinName config set telemetry.enabled false."
}

function Send-InstallTelemetry {
  param(
    [string] $Dest,
    [string] $RequestedVersion,
    [string] $ResolvedVersion,
    [string] $Platform,
    [string] $Aliases,
    [string] $Completions
  )
  try {
    & $Dest __telemetry install `
      --installer-type powershell `
      --requested-version $RequestedVersion `
      --resolved-version $ResolvedVersion `
      --platform $Platform `
      --aliases $Aliases `
      --completions $Completions `
      --mcp-setup not_run `
      --result success | Out-Null
  } catch {
    # Telemetry must never block installation.
  }
}

function Get-InstallDestDir {
  if ($IsWindows -or $env:OS -match "Windows") {
    return Join-Path $env:USERPROFILE ".local\bin"
  }
  return Join-Path $HOME ".local\bin"
}

function Get-PlatformArch {
  $arch = switch -Regex ($env:PROCESSOR_ARCHITECTURE) {
    "ARM64" { "arm64" }
    "AMD64" { "x64" }
    default {
      if ([System.Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture -eq
        [System.Runtime.InteropServices.Architecture]::Arm64) {
        "arm64"
      } else {
        "x64"
      }
    }
  }

  if ($IsWindows -or $env:OS -match "Windows") {
    return "win", $arch
  }
  if ($IsMacOS) { return "macos", $arch }
  if ($IsLinux) { return "linux", $arch }

  throw "Unsupported operating system for the PowerShell installer."
}

function Get-AssetUrl {
  param([string] $Asset)
  if ($Version -eq "latest") {
    return "https://github.com/$Repo/releases/latest/download/$Asset"
  }
  return "https://github.com/$Repo/releases/download/$Version/$Asset"
}

function Resolve-ReleaseVersion {
  if ($Version -ne "latest") { return $Version }
  try {
    $response = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" -Headers @{
      Accept = "application/vnd.github+json"
      "User-Agent" = "cloudeval-installer"
    }
    if ($response.tag_name) { return $response.tag_name }
  } catch {
    Write-Warn "Could not resolve latest release tag; continuing with 'latest'."
  }
  return "latest"
}

function Test-AssetExists {
  param([string] $Url)
  try {
    Invoke-WebRequest -Uri $Url -Method Head -UseBasicParsing -TimeoutSec 30 | Out-Null
    return $true
  } catch {
    return $false
  }
}

function Get-DownloadTimeoutSec {
  $value = $env:CLOUDEVAL_CURL_MAX_TIME
  if ([string]::IsNullOrWhiteSpace($value)) { return 900 }
  return [int]$value
}

function Invoke-DownloadFile {
  param(
    [string] $Url,
    [string] $Destination,
    [string] $Label,
    [int] $Attempts = 2
  )
  $timeout = Get-DownloadTimeoutSec
  for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
    if ($Attempts -gt 1) {
      Write-Info "$Label (attempt $attempt/$Attempts)"
    }
    try {
      Invoke-WebRequest -Uri $Url -OutFile $Destination -UseBasicParsing -TimeoutSec $timeout | Out-Null
      return
    } catch {
      if ($attempt -lt $Attempts) {
        Write-Warn "Download attempt $attempt failed for $Label; retrying..."
        $retryDelay = if ([string]::IsNullOrWhiteSpace($env:CLOUDEVAL_CURL_RETRY_DELAY)) { 2 } else { [int]$env:CLOUDEVAL_CURL_RETRY_DELAY }
        Start-Sleep -Seconds $retryDelay
        continue
      }
      throw
    }
  }
}

function Get-FileSha256 {
  param([string] $Path)
  return (Get-FileHash -Path $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Test-AssetChecksum {
  param(
    [string] $Asset,
    [string] $FilePath
  )
  if ($env:CLOUDEVAL_SKIP_CHECKSUM -eq "1") {
    Write-Warn "Skipping checksum verification because CLOUDEVAL_SKIP_CHECKSUM=1"
    return
  }

  $checksumPath = [System.IO.Path]::GetTempFileName()
  try {
    Invoke-DownloadFile -Url (Get-AssetUrl "$Asset.sha256") -Destination $checksumPath -Label "$Asset.sha256"
    $expected = (Get-Content -Path $checksumPath -TotalCount 1).Split()[0].ToLowerInvariant()
    $actual = Get-FileSha256 -Path $FilePath
    if ([string]::IsNullOrWhiteSpace($expected) -or $expected -ne $actual) {
      throw "Checksum verification failed for $Asset."
    }
    Write-Ok "Verified $Asset checksum"
  } finally {
    Remove-Item -Path $checksumPath -Force -ErrorAction SilentlyContinue
  }
}

function Save-VerifiedAsset {
  param(
    [string] $Asset,
    [string] $Destination,
    [string] $Mode = "File"
  )

  $tmp = [System.IO.Path]::GetTempFileName()
  $compressedTmp = "$tmp.gz"
  try {
    $compressedUrl = Get-AssetUrl "$Asset.gz"
    if ($env:CLOUDEVAL_DISABLE_COMPRESSED_ASSETS -ne "1") {
      if ((Test-AssetExists $compressedUrl)) {
        Invoke-DownloadFile -Url $compressedUrl -Destination $compressedTmp -Label "$Asset.gz"
        $inputStream = [System.IO.File]::OpenRead($compressedTmp)
        try {
          $gzip = New-Object System.IO.Compression.GzipStream(
            $inputStream,
            [System.IO.Compression.CompressionMode]::Decompress
          )
          $outputStream = [System.IO.File]::Create($tmp)
          try { $gzip.CopyTo($outputStream) } finally { $outputStream.Close() }
        } finally {
          $inputStream.Close()
        }
        Remove-Item -Path $compressedTmp -Force -ErrorAction SilentlyContinue
        Test-AssetChecksum -Asset $Asset -FilePath $tmp
        Move-Item -Path $tmp -Destination $Destination -Force
        if ($Mode -eq "Executable") {
          if (-not $IsWindows -and $env:OS -notmatch "Windows") {
            & chmod 755 $Destination
          }
        }
        return
      }
    }

    Invoke-DownloadFile -Url (Get-AssetUrl $Asset) -Destination $tmp -Label $Asset
    Test-AssetChecksum -Asset $Asset -FilePath $tmp
    Move-Item -Path $tmp -Destination $Destination -Force
    if ($Mode -eq "Executable" -and -not $IsWindows -and $env:OS -notmatch "Windows") {
      & chmod 755 $Destination
    }
  } finally {
    Remove-Item -Path $tmp -Force -ErrorAction SilentlyContinue
    Remove-Item -Path $compressedTmp -Force -ErrorAction SilentlyContinue
  }
}

function Save-OptionalNoticeAsset {
  param(
    [string] $Asset,
    [string] $Destination
  )
  try {
    Save-VerifiedAsset -Asset $Asset -Destination $Destination
    Write-Ok "Downloaded $Asset"
  } catch {
    Write-Warn "Could not download $Asset; continuing install."
    Remove-Item -Path $Destination -Force -ErrorAction SilentlyContinue
  }
}

function Test-PathInPath {
  param([string] $Directory)
  $parts = ($env:PATH -split [System.IO.Path]::PathSeparator) | Where-Object { $_ }
  return $parts -contains $Directory
}

function Add-ToUserPath {
  param([string] $Directory)
  if ($IsWindows -or $env:OS -match "Windows") {
    $current = [Environment]::GetEnvironmentVariable("Path", "User")
    if ($current -split ";" | Where-Object { $_ -eq $Directory }) {
      Write-Warn "PATH entry already exists for $Directory"
      return
    }
    $updated = if ([string]::IsNullOrWhiteSpace($current)) { $Directory } else { "$Directory;$current" }
    [Environment]::SetEnvironmentVariable("Path", $updated, "User")
    $env:PATH = "$Directory;$env:PATH"
    Write-Ok "Added $Directory to your user PATH"
    Write-Warn "Open a new PowerShell or terminal window if cloudeval is not found yet."
    return
  }

  $profile = if ($PROFILE) { $PROFILE } else { Join-Path $HOME ".config/powershell/profile.ps1" }
  $marker = "# Cloudeval CLI"
  if (Test-Path $profile) {
    $content = Get-Content -Path $profile -Raw
    if ($content -match [regex]::Escape($Directory)) {
      Write-Warn "PATH entry already exists in $profile"
      return
    }
  } else {
    New-Item -ItemType Directory -Path (Split-Path $profile -Parent) -Force | Out-Null
    New-Item -ItemType File -Path $profile -Force | Out-Null
  }
  Add-Content -Path $profile -Value ""
  Add-Content -Path $profile -Value $marker
  Add-Content -Path $profile -Value "`$env:PATH = `"$Directory`" + [System.IO.Path]::PathSeparator + `$env:PATH"
  Write-Ok "Added PATH entry to $profile"
  Write-Warn "Restart PowerShell or run: . `"$profile`""
}

function Write-Banner {
  Write-Host ""
  Write-Host "Welcome to" -ForegroundColor Green
  Write-Host " ██████╗  ██╗       ██████╗  ██╗   ██╗ ██████╗  ███████╗ ██╗   ██╗  █████╗  ██╗     " -ForegroundColor Yellow
  Write-Host "██╔════╝  ██║      ██╔═══██╗ ██║   ██║ ██╔══██╗ ██╔════╝ ██║   ██║ ██╔══██╗ ██║     " -ForegroundColor DarkYellow
  Write-Host "██║       ██║      ██║   ██║ ██║   ██║ ██║  ██║ █████╗   ██║   ██║ ███████║ ██║     " -ForegroundColor DarkYellow
  Write-Host "██║       ██║      ██║   ██║ ██║   ██║ ██║  ██║ ██╔══╝   ╚██╗ ██╔╝ ██╔══██║ ██║     " -ForegroundColor DarkYellow
  Write-Host "╚██████╗  ███████╗ ╚██████╔╝ ╚██████╔╝ ██████╔╝ ███████╗  ╚████╔╝  ██║  ██║ ███████╗" -ForegroundColor DarkYellow
  Write-Host " ╚═════╝  ╚══════╝  ╚═════╝   ╚═════╝  ╚═════╝  ╚══════╝   ╚═══╝   ╚═╝  ╚═╝ ╚══════╝" -ForegroundColor DarkYellow
  Write-Host "                                                                           Installer" -ForegroundColor Green
  Write-Host ""
}

if ($SelfTestDownloadPlan) {
  Write-Output (Get-AssetUrl "$SelfTestAsset.gz")
  Write-Output (Get-AssetUrl $SelfTestAsset)
  exit 0
}

if ($SelfTestTelemetryConfigure) {
  if ([string]::IsNullOrWhiteSpace($SelfTestTelemetryDest)) {
    throw "SelfTestTelemetryDest is required."
  }
  Set-TelemetryPreference -Dest $SelfTestTelemetryDest
  exit 0
}

Write-Banner

$platform, $arch = Get-PlatformArch
$ext = if ($platform -eq "win") { ".exe" } else { "" }
$asset = if ($platform -eq "win") { "$BinName-win-$arch.exe" } else { "$BinName-$platform-$arch" }

$destDir = Get-InstallDestDir
$dest = Join-Path $destDir "$BinName$ext"
$yogaDest = Join-Path $destDir "yoga.wasm"
$licenseDir = if ($IsWindows -or $env:OS -match "Windows") {
  Join-Path $env:LOCALAPPDATA "cloudeval/licenses"
} else {
  Join-Path $HOME ".local/share/cloudeval/licenses"
}
$resolvedVersion = Resolve-ReleaseVersion
$installAliases = "not_applicable"
$installCompletions = "not_applicable"

Write-Info "Installation Details:"
Write-Host "  Requested Version: $Version"
Write-Host "  Resolved Release: $resolvedVersion"
Write-Host "  Platform: $platform-$arch"
Write-Host "  Binary Asset: $asset"
Write-Host "  Install Directory: $destDir"
Write-Host "  Executable: $dest"
Write-Host "  Yoga Runtime: $yogaDest"
Write-Host "  License Notices: $licenseDir"
Write-Host "  Checksum Verification: required"
Write-Host ""

if (-not (Ask-YesNo "Do you want to proceed with the installation?" $true)) {
  Write-Warn "Installation cancelled."
  exit 0
}

New-Item -ItemType Directory -Path $destDir -Force | Out-Null

Write-Info "Downloading $BinName binary..."
try {
  Save-VerifiedAsset -Asset $asset -Destination $dest -Mode "Executable"
  Write-Ok "Downloaded $BinName binary"
} catch {
  Write-Err "Could not install the pre-built release."
  Write-Warn "Retry on a slower network or install from npm:"
  Write-Host "  npm install -g @ganakailabs/cloudeval-cli"
  Write-Warn "Other options:"
  Write-Host "  https://github.com/$Repo/releases"
  exit 1
}

Write-Info "Downloading yoga.wasm..."
try {
  Save-VerifiedAsset -Asset "yoga.wasm" -Destination $yogaDest
  Write-Ok "Downloaded yoga.wasm"
} catch {
  Write-Err "The CLI requires yoga.wasm. Installation cannot continue safely."
  Remove-Item -Path $dest -Force -ErrorAction SilentlyContinue
  exit 1
}

Write-Info "Downloading license notices..."
New-Item -ItemType Directory -Path $licenseDir -Force | Out-Null
Save-OptionalNoticeAsset -Asset "LICENSE" -Destination (Join-Path $licenseDir "LICENSE")
Save-OptionalNoticeAsset -Asset "NOTICE" -Destination (Join-Path $licenseDir "NOTICE")
Save-OptionalNoticeAsset -Asset "THIRD_PARTY_NOTICES.md" -Destination (Join-Path $licenseDir "THIRD_PARTY_NOTICES.md")
Save-OptionalNoticeAsset -Asset "sbom.spdx.json" -Destination (Join-Path $licenseDir "sbom.spdx.json")

if ($platform -ne "win") {
  if (Ask-YesNo "Create 'eva' and 'cloud' alias symlinks?" $true) {
    $eva = Join-Path $destDir "eva"
    $cloud = Join-Path $destDir "cloud"
    if (Test-Path $eva) { Remove-Item $eva -Force }
    if (Test-Path $cloud) { Remove-Item $cloud -Force }
    New-Item -ItemType SymbolicLink -Path $eva -Target $dest -Force | Out-Null
    New-Item -ItemType SymbolicLink -Path $cloud -Target $dest -Force | Out-Null
    $installAliases = "created"
    Write-Ok "Created 'eva' and 'cloud' aliases"
  } else {
    $installAliases = "declined"
  }
}

Write-Ok "Installation complete!"
Write-Host "  Binary installed to: $dest"
Write-Host ""

Set-TelemetryPreference -Dest $dest

if (Test-PathInPath $destDir) {
  Write-Ok "$destDir is already in your PATH"
} else {
  Write-Warn "$destDir is not in your PATH"
  if (Ask-YesNo "Would you like to add $destDir to your PATH automatically?" $true) {
    Add-ToUserPath -Directory $destDir
  } else {
    Write-Warn "Add this directory to your PATH manually: $destDir"
  }
}

Write-Host ""
Write-Ok "You can now run: $BinName --help"
Write-Host ""

if ($env:CLOUDEVAL_INSTALL_COMPLETION -ne "0") {
  if (Ask-YesNo "Install PowerShell tab completions?" $true) {
    try {
      & $dest completion install --shell powershell
      $installCompletions = "installed"
      Write-Ok "Installed PowerShell completions. Open a new terminal or reload your profile."
    } catch {
      $installCompletions = "failed"
      Write-Warn "Could not install completions automatically. Run: $BinName completion install --shell powershell"
    }
  } else {
    $installCompletions = "declined"
  }
} else {
  $installCompletions = "disabled"
}

Send-InstallTelemetry `
  -Dest $dest `
  -RequestedVersion $Version `
  -ResolvedVersion $resolvedVersion `
  -Platform "$platform-$arch" `
  -Aliases $installAliases `
  -Completions $installCompletions

Write-Info "Next steps:"
Write-Host "  $BinName login"
Write-Host "  $BinName status"
Write-Host "  $BinName mcp setup codex   # optional MCP client setup"
