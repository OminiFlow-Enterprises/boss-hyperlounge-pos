$ErrorActionPreference = 'Stop'
$source = Join-Path $PSScriptRoot 'dist\client'
$target = 'C:\Program Files\THE BOSS POS\resources\app\dist\client'
$index = Join-Path $target 'index.html'
if ([IO.File]::ReadAllText($index) -notmatch '/assets/index-(?:eDolNeF3|F8eQjx6X|BiGFIMj0)\.js') {
    throw 'Expected installed frontend was not found.'
}
foreach ($asset in Get-ChildItem -LiteralPath "$source\assets" -File) {
    $destination = Join-Path "$target\assets" $asset.Name
    if (!(Test-Path -LiteralPath $destination)) {
        Copy-Item -LiteralPath $asset.FullName -Destination $destination
    }
    if ((Get-FileHash -LiteralPath $destination).Hash -ne (Get-FileHash -LiteralPath $asset.FullName).Hash) {
        throw "Asset verification failed for $($asset.Name)"
    }
}
$updateId = [guid]::NewGuid().ToString('N')
$stagedIndex = Join-Path $target "index-$updateId.tmp"
$backup = Join-Path $target "index-before-club-remain-$updateId.bak"
Copy-Item -LiteralPath "$source\index.html" -Destination $stagedIndex
[IO.File]::Replace($stagedIndex, $index, $backup)
if ((Get-FileHash -LiteralPath $index).Hash -ne (Get-FileHash -LiteralPath "$source\index.html").Hash) {
    throw 'Entry page verification failed.'
}
Write-Host "Frontend update installed. Previous entry page backed up at $backup"

