@echo off
setlocal

set "MODE=%~1"
if "%MODE%"=="" set "MODE=local"

set "FRONTEND_BUILD=build"
set "START_TUNNEL=false"

if /I "%MODE%"=="tunnel" (
  set "FRONTEND_BUILD=build:tunnel"
  set "START_TUNNEL=true"
) else (
  if /I not "%MODE%"=="local" (
    echo Unknown mode: %MODE%
    echo Usage:
    echo   start-all.bat
    echo   start-all.bat local
    echo   start-all.bat tunnel
    exit /b 1
  )
)

echo Starting Mandala Exchange Environment in %MODE% mode...

echo [1/4] Launching Docker Containers (Databases & Redis)...
pushd BEI
docker compose up -d
if errorlevel 1 echo [WARN] Docker compose gagal untuk BEI, melanjutkan...
popd

pushd MATS
docker compose up -d
if errorlevel 1 echo [WARN] Docker compose gagal untuk MATS, melanjutkan...
popd

pushd SEKURITAS
docker compose up -d
if errorlevel 1 echo [WARN] Docker compose gagal untuk SEKURITAS, melanjutkan...
popd

echo Waiting 5 seconds for databases and Redis to be ready...
timeout /t 5 /nobreak >nul

echo [2/4] Running Database Migrations & Seeding...
pushd BEI
call npm run db:migrate
if errorlevel 1 echo [WARN] Migration gagal untuk BEI, melanjutkan...
call npm run db:seed
popd

pushd SEKURITAS\backend
call npm run db:migrate
if errorlevel 1 echo [WARN] Migration gagal untuk SEKURITAS, melanjutkan...
popd

echo [3/4] Building Frontend Preview...
pushd SEKURITAS\frontend
call npm run %FRONTEND_BUILD%
if errorlevel 1 (
  echo [ERROR] Frontend build gagal. Tidak bisa melanjutkan tanpa hasil build.
  popd
  exit /b 1
)
popd

echo [4/4] Launching Services...

echo Starting BEI Service...
start "BEI Service" cmd /k "cd BEI && npm run dev"

echo Starting MATS Service...
start "MATS Service" cmd /k "cd MATS && go run cmd/mats/main.go"

echo Starting Sekuritas Backend...
start "Sekuritas Backend" cmd /k "cd SEKURITAS\backend && npm run dev"

echo Starting Sekuritas Frontend Preview...
start "Sekuritas Frontend" cmd /k "cd SEKURITAS\frontend && npm run preview"

if /I "%START_TUNNEL%"=="true" (
  echo Starting Cloudflare Tunnel...
  where cloudflared >nul 2>nul
  if errorlevel 1 (
    echo cloudflared not found in PATH. Start it manually with: cloudflared tunnel run mandala-exchange
  ) else (
    start "Cloudflare Tunnel" cmd /k "cloudflared tunnel run mandala-exchange"
  )
)

echo.
echo All services have been launched in separate windows!
echo - Sekuritas Frontend preview will be available at http://localhost:4173
echo - Sekuritas Backend will run on port 3002
echo - MATS Service will run on port 8082
echo - BEI Service will run on port 4100
if /I "%START_TUNNEL%"=="true" (
  echo - Public Frontend: https://mandala-sekuritas.michaelk.fun
  echo - Public API: https://api-mandala-sekuritas.michaelk.fun
)
echo.
pause
