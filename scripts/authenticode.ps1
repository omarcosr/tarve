[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$PathsJson,
    [switch]$VerifyOnly,
    [switch]$RequireTimestamp
)

$ErrorActionPreference = "Stop"

function Resolve-SignTool {
    if ($env:TARVE_SIGNTOOL_PATH) {
        return (Resolve-Path -LiteralPath $env:TARVE_SIGNTOOL_PATH -ErrorAction Stop).Path
    }
    $command = Get-Command signtool.exe -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    $kits = Join-Path ${env:ProgramFiles(x86)} "Windows Kits\10\bin"
    if (Test-Path -LiteralPath $kits) {
        $candidate = Get-ChildItem -Path (Join-Path $kits "*\x64\signtool.exe") -File -ErrorAction SilentlyContinue |
            Sort-Object FullName -Descending |
            Select-Object -First 1
        if ($candidate) { return $candidate.FullName }
    }
    throw "signtool.exe was not found. Install the Windows SDK or set TARVE_SIGNTOOL_PATH."
}

$requestedPaths = @(
    ($PathsJson | ConvertFrom-Json) |
        Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) }
)
if ($requestedPaths.Count -eq 0) { throw "At least one path is required." }
$resolvedPaths = @($requestedPaths | ForEach-Object { (Resolve-Path -LiteralPath $_ -ErrorAction Stop).Path })

$temporaryPfx = $null
if (-not $VerifyOnly) {
    $base64 = $env:TARVE_AUTHENTICODE_PFX_BASE64
    $pfxPath = $env:TARVE_AUTHENTICODE_PFX_PATH
    $password = $env:TARVE_AUTHENTICODE_PFX_PASSWORD
    if ([string]::IsNullOrWhiteSpace($password)) { throw "TARVE_AUTHENTICODE_PFX_PASSWORD is required." }
    if ([string]::IsNullOrWhiteSpace($base64) -eq [string]::IsNullOrWhiteSpace($pfxPath)) {
        throw "Set exactly one of TARVE_AUTHENTICODE_PFX_BASE64 or TARVE_AUTHENTICODE_PFX_PATH."
    }
    if (-not [string]::IsNullOrWhiteSpace($base64)) {
        $temporaryPfx = Join-Path ([IO.Path]::GetTempPath()) ("tarve-authenticode-{0}.pfx" -f [Guid]::NewGuid())
        [IO.File]::WriteAllBytes($temporaryPfx, [Convert]::FromBase64String($base64.Trim()))
        $pfxPath = $temporaryPfx
    } else {
        $pfxPath = (Resolve-Path -LiteralPath $pfxPath -ErrorAction Stop).Path
    }
    $timestampUrl = if ([string]::IsNullOrWhiteSpace($env:TARVE_AUTHENTICODE_TIMESTAMP_URL)) {
        "http://timestamp.digicert.com"
    } else {
        $env:TARVE_AUTHENTICODE_TIMESTAMP_URL
    }
    $signTool = Resolve-SignTool
    try {
        foreach ($path in $resolvedPaths) {
            & $signTool sign /fd SHA256 /td SHA256 /tr $timestampUrl /f $pfxPath /p $password $path | Out-Null
            if ($LASTEXITCODE -ne 0) { throw "signtool.exe failed for $path with exit code $LASTEXITCODE" }
        }
    } finally {
        if ($temporaryPfx -and (Test-Path -LiteralPath $temporaryPfx)) {
            Remove-Item -LiteralPath $temporaryPfx -Force
        }
    }
}

$results = @()
foreach ($path in $resolvedPaths) {
    $signature = Get-AuthenticodeSignature -LiteralPath $path
    if ($null -eq $signature.SignerCertificate) { throw "Authenticode signature is missing: $path" }
    if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
        throw "Authenticode signature is not valid for ${path}: $($signature.Status) $($signature.StatusMessage)"
    }
    if ($RequireTimestamp -and $null -eq $signature.TimeStamperCertificate) {
        throw "Authenticode timestamp is missing: $path"
    }
    $results += [pscustomobject]@{
        path = $path
        status = [string]$signature.Status
        signerSubject = $signature.SignerCertificate.Subject
        thumbprint = $signature.SignerCertificate.Thumbprint
        timestampSubject = if ($signature.TimeStamperCertificate) { $signature.TimeStamperCertificate.Subject } else { $null }
    }
}

$results | ConvertTo-Json -Compress
