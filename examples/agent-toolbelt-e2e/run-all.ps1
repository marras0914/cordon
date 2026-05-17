# run-all.ps1 — orchestrates the three e2e verification scripts.
# Bails on first failure with a clear summary. Run from this directory.

$ErrorActionPreference = 'Stop'

Push-Location $PSScriptRoot
try {
    if (-not (Test-Path "node_modules/@modelcontextprotocol/sdk")) {
        Write-Host "[run-all] node_modules missing - running npm install..." -ForegroundColor Cyan
        npm install
        if ($LASTEXITCODE -ne 0) {
            Write-Host "[run-all] npm install failed" -ForegroundColor Red
            exit 1
        }
    }

    $stages = @(
        @{ Num = '01'; File = '01-toolbelt-direct.mjs';   Desc = 'agent-toolbelt MCP server (direct stdio)' },
        @{ Num = '02'; File = '02-cordon-stdio.mjs';      Desc = 'cordon proxy via stdio'                  },
        @{ Num = '03'; File = '03-cordon-http-audit.mjs'; Desc = 'cordon HTTP transport + audit capture'   }
    )

    foreach ($stage in $stages) {
        Write-Host ""
        Write-Host "=== Stage $($stage.Num) - $($stage.Desc) ===" -ForegroundColor Cyan
        node $stage.File
        if ($LASTEXITCODE -ne 0) {
            Write-Host ""
            Write-Host "[run-all] Stage $($stage.Num) failed - bailing." -ForegroundColor Red
            exit $LASTEXITCODE
        }
        Write-Host "[run-all] Stage $($stage.Num) passed." -ForegroundColor Green
    }

    Write-Host ""
    Write-Host "[run-all] All stages passed. The dev.to walkthrough's chain is verified end to end." -ForegroundColor Green
}
finally {
    Pop-Location
}
