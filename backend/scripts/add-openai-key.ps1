# PowerShell script to help add OpenAI API key to .env file
# Usage: .\add-openai-key.ps1

Write-Host "🔑 OpenAI API Key Setup Helper" -ForegroundColor Cyan
Write-Host ""

$envPath = Join-Path $PSScriptRoot "..\.env"

if (-not (Test-Path $envPath)) {
    Write-Host "❌ .env file not found at: $envPath" -ForegroundColor Red
    exit 1
}

Write-Host "📝 Current .env file location: $envPath" -ForegroundColor Green
Write-Host ""

# Check current value
$currentContent = Get-Content $envPath -Raw
if ($currentContent -match 'OPENAI_API_KEY="([^"]*)"') {
    $currentKey = $matches[1]
    if ($currentKey -eq "") {
        Write-Host "⚠️  OPENAI_API_KEY is currently empty" -ForegroundColor Yellow
    } else {
        Write-Host "✅ OPENAI_API_KEY is already set: $($currentKey.Substring(0, [Math]::Min(10, $currentKey.Length)))..." -ForegroundColor Green
        $overwrite = Read-Host "Do you want to overwrite it? (y/n)"
        if ($overwrite -ne "y" -and $overwrite -ne "Y") {
            Write-Host "Cancelled." -ForegroundColor Yellow
            exit 0
        }
    }
}

Write-Host ""
Write-Host "📋 Instructions:" -ForegroundColor Cyan
Write-Host "1. Go to https://platform.openai.com/api-keys"
Write-Host "2. Create a new secret key (or use existing)"
Write-Host "3. Copy the key (it starts with 'sk-')"
Write-Host ""

$apiKey = Read-Host "Paste your OpenAI API key here"

# Validate key format
if (-not $apiKey) {
    Write-Host "❌ No key provided. Cancelled." -ForegroundColor Red
    exit 1
}

if (-not $apiKey.StartsWith("sk-")) {
    Write-Host "⚠️  Warning: API key should start with 'sk-'. Continue anyway? (y/n)" -ForegroundColor Yellow
    $continue = Read-Host
    if ($continue -ne "y" -and $continue -ne "Y") {
        Write-Host "Cancelled." -ForegroundColor Yellow
        exit 0
    }
}

# Update .env file
$envContent = Get-Content $envPath
$updated = $false
$newContent = $envContent | ForEach-Object {
    if ($_ -match '^OPENAI_API_KEY=') {
        $updated = $true
        "OPENAI_API_KEY=`"$apiKey`""
    } else {
        $_
    }
}

if (-not $updated) {
    # Add new line if it doesn't exist
    $newContent += "OPENAI_API_KEY=`"$apiKey`""
}

$newContent | Set-Content $envPath

Write-Host ""
Write-Host "✅ Successfully updated OPENAI_API_KEY in .env file!" -ForegroundColor Green
Write-Host ""
Write-Host "🔍 Verifying..." -ForegroundColor Cyan

# Verify
$verifyContent = Get-Content $envPath -Raw
if ($verifyContent -match 'OPENAI_API_KEY="([^"]*)"') {
    $savedKey = $matches[1]
    if ($savedKey -eq $apiKey) {
        Write-Host "✅ Verification successful!" -ForegroundColor Green
        Write-Host ""
        Write-Host "📝 Next steps:" -ForegroundColor Cyan
        Write-Host "1. Run: npx ts-node scripts/check-rag-prerequisites.ts"
        Write-Host "2. Restart your backend server if it's running"
    } else {
        Write-Host "⚠️  Warning: Key might not have been saved correctly" -ForegroundColor Yellow
    }
}



