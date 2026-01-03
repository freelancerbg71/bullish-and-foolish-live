# Daily Price Update Script (Robust)
# Logs to G:\NewBullish\logs\daily_update.log

$LogDir = "G:\NewBullish\logs"
if (!(Test-Path $LogDir)) { New-Item -ItemType Directory -Force -Path $LogDir }
$LogFile = "$LogDir\daily_update.log"

Start-Transcript -Path $LogFile -Append

Write-Host "--- Starting Daily Update: $(Get-Date) ---"

$ErrorActionPreference = "Stop"
try {
    Set-Location "G:\NewBullish"

    Write-Host "[daily-update] Syncing repository..."
    # Use git fetch + reset/rebase to be safer? No, standard pull is fine for simple setups.
    # But if there are local changes (like the ones I just made to .local), pull might fail if not rebased?
    # I'll rely on pull --rebase as existing script did.
    
    # Check if git is available
    if (!(Get-Command git -ErrorAction SilentlyContinue)) {
        throw "Git command not found in PATH"
    }
    
    git pull origin main --rebase
    
    Write-Host "[daily-update] Fetching latest prices..."
    
    # Check if node is available
    if (!(Get-Command node -ErrorAction SilentlyContinue)) {
        # Try to find node in standard places if not in PATH
        $NodePath = "C:\Program Files\nodejs\node.exe"
        if (Test-Path $NodePath) {
            Write-Host "Using node at $NodePath"
            & $NodePath worker/jobs/daily-last-trade.js --force
        } else {
            throw "Node.js not found in PATH or standard location"
        }
    } else {
        node worker/jobs/daily-last-trade.js --force
    }

    if ($LASTEXITCODE -ne 0) {
        throw "Price fetch script failed with exit code $LASTEXITCODE"
    }

    $status = git status --porcelain data/prices.json
    if ($status) {
        Write-Host "[daily-update] Prices changed. Committing and pushing..."
        git add data/prices.json
        $date = Get-Date -Format "yyyy-MM-dd"
        git commit -m "data: update prices.json for $date"
        git push origin main
        Write-Host "[daily-update] Pushed successfully."
    } else {
        Write-Host "[daily-update] No price changes detected."
    }
    
    Write-Host "--- Success: $(Get-Date) ---"
} catch {
    Write-Error "Update Failed: $_"
    Write-Host "--- Failed: $(Get-Date) ---"
    exit 1
} finally {
    Stop-Transcript
}
