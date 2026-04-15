# Encode logo.png into logo.js (embedded base64) so it works on file:// without tainting the canvas
& "$PSScriptRoot\encode-logo.ps1"

# Read current build number and increment
$buildFile = "$PSScriptRoot\build.txt"
$build = [int](Get-Content $buildFile -Raw).Trim()
$build++

# Update build number in index.html
$htmlFile = "$PSScriptRoot\index.html"
$html = Get-Content $htmlFile -Raw
$html = $html -replace 'Video Editör - #\d+', "Video Editör - #$build"
Set-Content $htmlFile $html -NoNewline

# Save new build number
Set-Content $buildFile $build -NoNewline

Write-Host "Deploying build #$build..." -ForegroundColor Cyan
npx surge . video-editor.surge.sh
