# Daily Price Update Script
# This script fetches new prices, commits them to git, and pushes to Railway.

$ErrorActionPreference = "Stop"
cd "G:\NewBullish"

Write-Host "[daily-update] Syncing repository..."
# Pull latest changes to avoid conflicts when pushing
git pull origin main --rebase

Write-Host "[daily-update] Fetching latest prices..."
node worker/jobs/daily-last-trade.js --force

if ($LASTEXITCODE -ne 0) {
    Write-Error "Price fetch failed with exit code $LASTEXITCODE"
}

$status = git status --porcelain data/prices.json
if ($status) {
    Write-Host "[daily-update] Prices changed. Committing and pushing..."
    git add data/prices.json
    $date = Get-Date -Format "yyyy-MM-dd"
    git commit -m "data: update prices.json for $date"
    git push origin main
    Write-Host "[daily-update] Done! Railway will deploy automatically."
} else {
    Write-Host "[daily-update] No price changes detected."
}
