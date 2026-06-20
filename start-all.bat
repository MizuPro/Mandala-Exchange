@echo off
setlocal

set "MODE=%~1"
if "%MODE%"=="" set "MODE=development"
if /I "%MODE%"=="local" set "MODE=development"
if /I "%MODE%"=="dev" set "MODE=development"
if /I "%MODE%"=="tunnel" set "MODE=production"
if /I "%MODE%"=="prod" set "MODE=production"

if /I "%MODE%"=="development" (
  set "FRONTEND_COMMAND=dev -- --host 127.0.0.1 --port 5173"
  set "FRONTEND_URL=http://localhost:5173"
  set "FRONTEND_NEEDS_BUILD=false"
  set "START_TUNNEL=false"
  set "COMPOSE_PROJECT_SUFFIX=dev"
) else (
  if /I "%MODE%"=="production" (
    set "FRONTEND_BUILD=build -- --mode production"
    set "FRONTEND_COMMAND=preview -- --host 127.0.0.1 --port 4174"
    set "FRONTEND_URL=http://localhost:4174"
    set "FRONTEND_NEEDS_BUILD=true"
    set "START_TUNNEL=true"
    set "COMPOSE_PROJECT_SUFFIX=prod"
  ) else (
    echo Unknown mode: %MODE%
    echo Usage:
    echo   start-all.bat development
    echo   start-all.bat production
    exit /b 1
  )
)

echo Starting Mandala Exchange Environment in %MODE% mode...

echo [1/4] Launching Docker Containers (Databases and Redis)...
pushd BEI
docker compose --env-file ".env.docker.%MODE%" -p "mandala-bei-%COMPOSE_PROJECT_SUFFIX%" up -d
if errorlevel 1 echo [WARN] Docker compose gagal untuk BEI, melanjutkan...
popd

pushd MATS
docker compose --env-file ".env.docker.%MODE%" -p "mandala-mats-%COMPOSE_PROJECT_SUFFIX%" up -d
if errorlevel 1 echo [WARN] Docker compose gagal untuk MATS, melanjutkan...
popd

pushd SEKURITAS
docker compose --env-file ".env.docker.%MODE%" -p "mandala-sekuritas-%COMPOSE_PROJECT_SUFFIX%" up -d
if errorlevel 1 echo [WARN] Docker compose gagal untuk SEKURITAS, melanjutkan...
popd

echo Waiting 5 seconds for databases and Redis to be ready...
timeout /t 5 /nobreak >nul

echo [2/4] Running Database Migrations and Seeding...
pushd BEI
set "DOTENV_CONFIG_PATH=.env.%MODE%"
call npm run db:migrate
if errorlevel 1 echo [WARN] Migration gagal untuk BEI, melanjutkan...
if /I "%MODE%"=="development" (
  call npm run db:seed
) else (
  echo Skipping BEI seed in production mode.
)
popd

pushd SEKURITAS\backend
set "DOTENV_CONFIG_PATH=.env.%MODE%"
call npm run db:migrate
if errorlevel 1 echo [WARN] Migration gagal untuk SEKURITAS, melanjutkan...
popd

if /I "%FRONTEND_NEEDS_BUILD%"=="true" (
  echo [3/4] Building Frontend Preview...
  pushd SEKURITAS\frontend
  call npm run %FRONTEND_BUILD%
  if errorlevel 1 (
    echo [ERROR] Frontend build gagal. Tidak bisa melanjutkan tanpa hasil build.
    popd
    exit /b 1
  )
  popd
) else (
  echo [3/4] Skipping frontend build in development mode. Vite dev server will hot reload changes.
)

echo [4/4] Launching Services...

echo Starting BEI Service...
start "BEI Service %MODE%" cmd /k "cd BEI && set DOTENV_CONFIG_PATH=.env.%MODE%&& set APP_ENV=%MODE%&& npm run dev"

echo Waiting 5 seconds for BEI Service to boot...
timeout /t 5 /nobreak >nul

echo Starting MATS Service...
start "MATS Service %MODE%" cmd /k "cd MATS && set MANDALA_ENV_FILE=.env.%MODE%&& set APP_ENV=%MODE%&& go run cmd/mats/main.go"

echo Starting Sekuritas Backend...
start "Sekuritas Backend %MODE%" cmd /k "cd SEKURITAS\backend && set DOTENV_CONFIG_PATH=.env.%MODE%&& set APP_ENV=%MODE%&& npm run dev"

if /I "%MODE%"=="development" (
  echo Starting Sekuritas Frontend Dev Server...
) else (
  echo Starting Sekuritas Frontend Preview...
)
start "Sekuritas Frontend %MODE%" cmd /k "cd SEKURITAS\frontend && npm run %FRONTEND_COMMAND%"

if /I "%START_TUNNEL%"=="true" (
  echo Starting Cloudflare Tunnel...
  where cloudflared >nul 2>nul
  if errorlevel 1 (
    echo cloudflared not found in PATH. Start it manually with: cloudflared tunnel --config deploy\cloudflared\mandala-tunnel.production.yml run
  ) else (
    if not exist "deploy\cloudflared\mandala-tunnel.production.yml" (
      echo deploy\cloudflared\mandala-tunnel.production.yml not found.
      echo Copy deploy\cloudflared\mandala-tunnel.production.example.yml first and set your tunnel UUID.
    ) else (
      start "Cloudflare Tunnel %MODE%" cmd /k "cloudflared tunnel --config deploy\cloudflared\mandala-tunnel.production.yml run"
    )
  )
)

echo.
echo All services have been launched in separate windows!
if /I "%MODE%"=="development" (
  echo - Sekuritas Frontend dev server: %FRONTEND_URL%
  echo - Sekuritas Backend: http://localhost:3002
  echo - MATS Service: http://localhost:8082
  echo - BEI Service: http://localhost:4100
) else (
  echo - Sekuritas Frontend preview: %FRONTEND_URL%
  echo - Sekuritas Backend: http://localhost:3003
  echo - MATS Service: http://localhost:8083
  echo - BEI Service: http://localhost:4101
  echo - Public Frontend: https://mandala-sekuritas.michaelk.fun
  echo - Public API: https://api-mandala-sekuritas.michaelk.fun
)
echo.
pause
