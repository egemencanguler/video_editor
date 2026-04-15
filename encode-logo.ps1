# Encodes logo.png into logo.js as a base64 data URL.
# This embeds the logo so it works on file:// protocol without tainting the canvas
# (required for VideoFrame export to succeed).

$logoPath = "$PSScriptRoot\logo.png"
$outputPath = "$PSScriptRoot\logo.js"

if (-not (Test-Path $logoPath)) {
    Write-Host "ERROR: logo.png not found at $logoPath" -ForegroundColor Red
    exit 1
}

$bytes = [System.IO.File]::ReadAllBytes($logoPath)
$base64 = [Convert]::ToBase64String($bytes)
$dataUrl = "data:image/png;base64,$base64"
$js = "window.LOGO_DATA_URL = `"$dataUrl`";"
[System.IO.File]::WriteAllText($outputPath, $js)

$sizeKB = [Math]::Round($bytes.Length / 1KB, 1)
$encodedKB = [Math]::Round($base64.Length / 1KB, 1)
Write-Host "Encoded logo.png ($sizeKB KB) -> logo.js ($encodedKB KB base64)" -ForegroundColor Green
