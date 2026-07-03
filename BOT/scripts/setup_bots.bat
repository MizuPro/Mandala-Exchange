@echo off
setlocal enabledelayedexpansion

set "ENV_FILE=.env.development"
if exist "%ENV_FILE%" (
    for /f "usebackq tokens=1,* delims==" %%A in ("%ENV_FILE%") do (
        set "line=%%A"
        if not "!line:~0,1!"=="#" (
            if not "%%B"=="" (
                set "%%A=%%B"
            )
        )
    )
) else (
    echo [ERROR] File %ENV_FILE% tidak ditemukan.
    exit /b 1
)

echo Provisioning 10 Noise Traders...
go run cmd/provision/main.go -count 10 -prefix noise
if errorlevel 1 exit /b 1

echo Provisioning 5 Market Makers...
go run cmd/provision/main.go -count 5 -prefix mm
if errorlevel 1 exit /b 1

echo Provisioning 5 Momentum Traders...
go run cmd/provision/main.go -count 5 -prefix mom
if errorlevel 1 exit /b 1

echo Updating strategies in database...
psql "%BOT_DATABASE_URL%" -c "UPDATE bots SET strategy_type='market_maker' WHERE external_bot_id LIKE 'mm-%%';"
psql "%BOT_DATABASE_URL%" -c "UPDATE bots SET strategy_type='momentum_trader' WHERE external_bot_id LIKE 'mom-%%';"

echo Running Genesis...
go run cmd/genesis/main.go
if errorlevel 1 exit /b 1

echo Bots successfully provisioned and seeded!
