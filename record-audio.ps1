param(
    [string]$OutputFile,
    [int]$Duration = 5
)

$ffmpegPath = Join-Path $PSScriptRoot "node_modules/ffmpeg-static/ffmpeg.exe"

Write-Host "Recording to: $OutputFile"
Write-Host "Duration: $Duration seconds"

if (-not (Test-Path $ffmpegPath)) {
    Write-Host "FFmpeg not found"
    exit 1
}

Write-Host "Detecting audio device..."
$detectOutput = & $ffmpegPath -f dshow -list_devices true -i dummy 2>&1 | Out-String

# Parse the alternative device ID (format: @device_cm_... which is more reliable)
# Look for pattern: "(...)" (audio) followed by Alternative name "@device_cm_..."
$audioDeviceMatch = $detectOutput -match '(?s)\(audio\)\s+Alternative name\s+"(@device_cm_[^"]+)"'
if ($audioDeviceMatch) {
    # Extract using regex
    $match = [regex]::Match($detectOutput, '\(audio\)\s+Alternative name\s+"(@device_cm_[^"]+)"', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
    if ($match.Success) {
        $deviceId = $match.Groups[1].Value.Trim()
        Write-Host "Found device ID: $deviceId"
    }
}

if (-not $deviceId) {
    Write-Host "Could not detect device ID, using fallback"
    $deviceId = "@device_cm_{33D9A762-90C8-11D0-BD43-00A0C911CE86}\wave_{C80CE169-8869-4A27-AA88-66B617C4DD7E}"
}

Write-Host "Recording audio with device: $deviceId"
& $ffmpegPath -f dshow -i "audio=$deviceId" -c:a pcm_s16le -t $Duration -y $OutputFile 2>&1 | Out-String | Write-Host

if (Test-Path $OutputFile) {
    $size = (Get-Item $OutputFile).Length
    Write-Host "Success! File size: $size bytes"
    exit 0
} else {
    Write-Host "Failed: file not created"
    exit 1
}
