@echo off
setlocal enabledelayedexpansion

set "MODE=%~1"
if "%MODE%"=="" set "MODE=development"
if /I "%MODE%"=="dev" set "MODE=development"
if /I "%MODE%"=="prod" set "MODE=production"

echo Starting BOT Service in %MODE% mode...
set "APP_ENV=%MODE%"

:: Memuat file .env yang sesuai
set "ENV_FILE=.env.%MODE%"
if exist "%ENV_FILE%" (
    echo Memuat konfigurasi dari %ENV_FILE%...
    for /f "usebackq tokens=1,* delims==" %%A in ("%ENV_FILE%") do (
        :: Abaikan baris kosong atau komentar (dimulai dengan #)
        set "line=%%A"
        if not "!line:~0,1!"=="#" (
            if not "%%B"=="" (
                set "%%A=%%B"
            )
        )
    )
) else (
    echo [WARN] File %ENV_FILE% tidak ditemukan. Pastikan konfigurasi sudah di-set.
)

go run cmd/bot/main.go

pause
