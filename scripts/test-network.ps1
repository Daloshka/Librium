param([ValidateSet('all', 'cdp', 'desktop', 'proxy', 'targets', 'wsui', 'catalogue', 'wsarchive', 'wscontext', 'jsonrpc', 'wsprofile', 'rpcstrict', 'roles')][string]$Suite = 'all')
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)

# Never attach integration tests to the user's running core or history.
foreach ($port in @(3000, 8080)) {
    if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) {
        throw "Port $port is occupied. Close Librium before running the isolated network tests."
    }
}
$cargoCommand = Get-Command cargo -ErrorAction SilentlyContinue
$cargoPath = if ($cargoCommand) { $cargoCommand.Source } else { Join-Path $env:USERPROFILE '.cargo\bin\cargo.exe' }
& $cargoPath build --locked
if ($LASTEXITCODE -ne 0) { throw 'Rust build failed' }

$testDirectory = Join-Path (Get-Location) ('target\network-smoke-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $testDirectory | Out-Null
$previousDataDirectory = $env:LIBRIUM_DATA_DIR
$previousRestore = $env:LIBRIUM_RESTORE
$previousTestTls = $env:LIBRIUM_TEST_TLS_DIR
$coreProcess = $null
try {
    $env:LIBRIUM_DATA_DIR = Join-Path $testDirectory 'data'
    $env:LIBRIUM_RESTORE = $null
    if ($Suite -in @('all', 'desktop')) {
        $env:LIBRIUM_TEST_TLS_DIR = Join-Path $testDirectory 'tls'
        & $cargoPath run --locked --example ws-fixture-cert -- $env:LIBRIUM_TEST_TLS_DIR
        if ($LASTEXITCODE -ne 0) { throw 'TLS fixture generation failed' }
    }
    $coreProcess = Start-Process -FilePath (Join-Path (Get-Location) 'target\debug\librium.exe') -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $testDirectory 'core.log') -RedirectStandardError (Join-Path $testDirectory 'core-errors.log')
    $ready = $false
    for ($attempt = 0; $attempt -lt 100; $attempt++) {
        if ($coreProcess.HasExited) { throw 'Test core exited before startup; inspect target/network-smoke-*/core-errors.log' }
        try {
            $response = Invoke-WebRequest 'http://127.0.0.1:3000/' -UseBasicParsing -TimeoutSec 1
            if ($response.StatusCode -eq 200 -and $response.Content -match 'Librium') {
                $ownedPorts = @(Get-NetTCPConnection -LocalPort 3000,8080 -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.OwningProcess -eq $coreProcess.Id })
                if ($ownedPorts.Count -eq 2) { $ready = $true; break }
            }
        } catch { }
        Start-Sleep -Milliseconds 100
    }
    if (-not $ready) { throw 'Test core did not become ready' }
    if ($Suite -eq 'all') {
        & node scripts/cdp-request-entries-smoke.cjs
        if ($LASTEXITCODE -ne 0) { throw 'Chromium request body entries failed' }
        & node scripts/http-body-observer-smoke.cjs
        if ($LASTEXITCODE -ne 0) { throw 'Request body observer integration failed' }
        & node scripts/http-body-capture-smoke.cjs
        if ($LASTEXITCODE -ne 0) { throw 'Request body capture integration failed' }
        & node scripts/startup-repeat-smoke.cjs
        if ($LASTEXITCODE -ne 0) { throw 'Repeated startup capture integration failed' }
        & node node_modules/electron/cli.js scripts/ws-library-observer-smoke.cjs
        if ($LASTEXITCODE -ne 0) { throw 'ws library observer integration failed' }
        & node scripts/startup-watchdog-smoke.cjs
        if ($LASTEXITCODE -ne 0) { throw 'Startup watchdog integration failed' }
        & node scripts/startup-capture-smoke.cjs
        if ($LASTEXITCODE -ne 0) { throw 'Startup capture integration failed' }
        & node scripts/capture-launch-smoke.cjs
        if ($LASTEXITCODE -ne 0) { throw 'Capture launch integration failed' }
        & node node_modules/electron/cli.js scripts/node-ws-observer-smoke.cjs
        if ($LASTEXITCODE -ne 0) { throw 'Node WebSocket observer integration failed' }
    }
    if ($Suite -in @('all', 'cdp')) {
        & npm.cmd run test:cdp
        if ($LASTEXITCODE -ne 0) { throw 'CDP integration failed' }
    }
    if ($Suite -in @('all', 'desktop')) {
        & node node_modules/electron/cli.js scripts/core-compat-runtime-smoke.cjs
        if ($LASTEXITCODE -ne 0) { throw 'Core compatibility startup integration failed' }
        & npm.cmd run test:main-capture
        if ($LASTEXITCODE -ne 0) { throw 'Main-process integration failed' }
    }
    if ($Suite -in @('all', 'desktop', 'targets')) {
        & node scripts/capture-context-smoke.cjs
        if ($LASTEXITCODE -ne 0) { throw 'Capture context lifecycle failed' }
        & node node_modules/electron/cli.js scripts/capture-context-cdp-smoke.cjs
        if ($LASTEXITCODE -ne 0) { throw 'Capture context CDP integration failed' }
        & node scripts/node-workers-smoke.cjs --archive
        if ($LASTEXITCODE -ne 0) { throw 'Node worker capture integration failed' }
        & node scripts/node-workers-smoke.cjs --archive --electron --startup
        if ($LASTEXITCODE -ne 0) { throw 'Electron worker capture integration failed' }
        & node node_modules/electron/cli.js scripts/capture-target-ui-smoke.cjs
        if ($LASTEXITCODE -ne 0) { throw 'Capture target UI integration failed' }
    }
    if ($Suite -in @('all', 'desktop', 'rpcstrict')) {
        & node node_modules/electron/cli.js scripts/rpc-unique-native-smoke.cjs
        if ($LASTEXITCODE -ne 0) { throw 'RPC unique protocol members integration failed' }
    }
    if ($Suite -in @('all', 'desktop', 'wsprofile')) {
        & node node_modules/electron/cli.js scripts/ws-profile-native-smoke.cjs
        if ($LASTEXITCODE -ne 0) { throw 'WebSocket content profile integration failed' }
    }
    if ($Suite -in @('all', 'desktop', 'jsonrpc')) {
        & node node_modules/electron/cli.js scripts/jsonrpc-related-native-smoke.cjs
        if ($LASTEXITCODE -ne 0) { throw 'JSON-RPC pairing integration failed' }
    }
    if ($Suite -in @('all', 'desktop', 'wsarchive', 'wscontext')) {
        & node node_modules/electron/cli.js scripts/ws-archive-native-smoke.cjs
        if ($LASTEXITCODE -ne 0) { throw 'WebSocket archive search integration failed' }
    }
    if ($Suite -in @('all', 'desktop', 'targets', 'catalogue')) {
        & node node_modules/electron/cli.js scripts/capture-context-catalogue-smoke.cjs
        if ($LASTEXITCODE -ne 0) { throw 'Capture context catalogue integration failed' }
    }
    if ($Suite -in @('all', 'desktop')) {
        & node node_modules/electron/cli.js scripts/ws-kind-groups-smoke.cjs
        if ($LASTEXITCODE -ne 0) { throw 'WebSocket grouped filters integration failed' }
        & node node_modules/electron/cli.js scripts/ws-decode-offset-smoke.cjs
        if ($LASTEXITCODE -ne 0) { throw 'WebSocket decode offset integration failed' }
        & node node_modules/electron/cli.js scripts/ws-inflate-smoke.cjs
        if ($LASTEXITCODE -ne 0) { throw 'WebSocket decompression integration failed' }
    }
    if ($Suite -in @('all', 'desktop', 'roles')) {
        & node node_modules/electron/cli.js scripts/ws-role-ui-smoke.cjs
        if ($LASTEXITCODE -ne 0) { throw 'WebSocket role integration failed' }
    }
    if ($Suite -in @('all', 'desktop', 'wsui')) {
        & npm.cmd run test:ws-ui
        if ($LASTEXITCODE -ne 0) { throw 'WebSocket desktop integration failed' }
    }
    if ($Suite -in @('all', 'desktop', 'proxy')) {
        & node scripts/ws-probe.cjs
        if ($LASTEXITCODE -ne 0) { throw 'WebSocket proxy integration failed' }
        & node scripts/ws-control-smoke.cjs
        if ($LASTEXITCODE -ne 0) { throw 'WebSocket control forwarding failed' }
    }
    Write-Host "PASS: isolated $Suite network integration"
} finally {
    if ($coreProcess -and -not $coreProcess.HasExited) { Stop-Process -Id $coreProcess.Id }
    $env:LIBRIUM_DATA_DIR = $previousDataDirectory
    $env:LIBRIUM_RESTORE = $previousRestore
    $env:LIBRIUM_TEST_TLS_DIR = $previousTestTls
}
