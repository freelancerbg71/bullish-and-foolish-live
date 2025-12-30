$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$outDir = Join-Path $root "assets\\promo"
$outFile = Join-Path $outDir "quality_score_vo.wav"

if (!(Test-Path $outDir)) {
  New-Item -ItemType Directory -Path $outDir | Out-Null
}

Add-Type -AssemblyName System.Speech

$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$synth.Rate = 0
$synth.Volume = 100

$text = "Sort all U.S. stocks by quality score."

$synth.SetOutputToWaveFile($outFile)
$synth.Speak($text)
$synth.SetOutputToNull()
$synth.Dispose()

Write-Host "Wrote voiceover:" $outFile
