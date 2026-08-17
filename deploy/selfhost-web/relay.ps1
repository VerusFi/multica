# relay.ps1 — one-liner bootstrap for multica-relay (Windows)
# Downloads and runs the relay binary for the current platform

# Detect architecture
$Arch = $env:PROCESSOR_ARCHITECTURE
if ($Arch -eq "AMD64" -or $Arch -eq "x86_64") {
    $Asset = "multica-relay-windows-amd64.exe"
} else {
    Write-Error "ERROR: Unsupported Windows architecture: $Arch" -ErrorAction Stop
    exit 1
}

# Default URL base (can be overridden via MULTICA_RELAY_URL_BASE env var).
# Pinned to the rolling `selfhost-latest` release tag, not
# `releases/latest/download` -- this repo's GitHub "latest release" is
# claimed by the ordinary vX.Y.Z app releases, which ship no relay
# binaries at all; a plain "latest" URL here would 404. See
# deploy/selfhost-web/dev/NOTES.md ("rolling selfhost-latest release
# channel").
$UrlBase = if ($env:MULTICA_RELAY_URL_BASE) { $env:MULTICA_RELAY_URL_BASE } else { "https://github.com/VerusFi/multica/releases/download/selfhost-latest" }
$DownloadUrl = "$UrlBase/$Asset"

# Target directory and file
$TargetDir = "$env:USERPROFILE\.multica"
$TargetFile = "$TargetDir\multica-relay.exe"

# Create target directory if it doesn't exist
if (-not (Test-Path $TargetDir)) {
    New-Item -ItemType Directory -Path $TargetDir | Out-Null
}

# Download the binary
Write-Host "Downloading $Asset from $DownloadUrl..."
try {
    $ProgressPreference = 'SilentlyContinue'
    Invoke-WebRequest -Uri $DownloadUrl -OutFile $TargetFile -ErrorAction Stop
} catch {
    Write-Error "ERROR: Failed to download $Asset" -ErrorAction Stop
    exit 1
}

# Print the address and run in foreground.
#
# The relay accepts WebSockets only from localhost origins by default (it is
# an unauthenticated outbound proxy -- see relay/main.go), so a page served
# from a real deployment (GitHub Pages) must be allowed explicitly. The
# page's own "Run a relay" one-liner sets MULTICA_RELAY_ORIGIN to its own
# origin for exactly that.
Write-Host "wisp://localhost:8086"
if ($env:MULTICA_RELAY_ORIGIN) {
    & $TargetFile -origin $env:MULTICA_RELAY_ORIGIN
} else {
    & $TargetFile
}
