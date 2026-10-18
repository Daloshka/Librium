$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$cargoCommand = Get-Command cargo -ErrorAction SilentlyContinue
$cargoPath = if ($cargoCommand) { $cargoCommand.Source } else { Join-Path $env:USERPROFILE '.cargo\bin\cargo.exe' }
if (-not (Test-Path -LiteralPath $cargoPath)) {
    throw 'Rust is required: install it from https://rustup.rs, then run this script again.'
}
& $cargoPath run --locked
exit $LASTEXITCODE
