@echo off
setlocal

set "MODE=%~1"
if "%MODE%"=="" set "MODE=development"
if /I "%MODE%"=="local" set "MODE=development"
if /I "%MODE%"=="dev" set "MODE=development"
if /I "%MODE%"=="tunnel" set "MODE=production"
if /I "%MODE%"=="prod" set "MODE=production"

if /I "%MODE%"=="development" (
  set "PORT_FRONTEND=5173"
  set "PORT_SEKURITAS=3002"
  set "PORT_MATS=8082"
  set "PORT_BEI=4100"
  set "PORT_BOT=8080"
  set "COMPOSE_PROJECT_SUFFIX=dev"
) else (
  if /I "%MODE%"=="production" (
    set "PORT_FRONTEND=4174"
    set "PORT_SEKURITAS=3003"
    set "PORT_MATS=8083"
    set "PORT_BEI=4101"
    set "PORT_BOT=9090"
    set "COMPOSE_PROJECT_SUFFIX=prod"
  ) else (
    echo Unknown mode: %MODE%
    echo Usage:
    echo   stop-all.bat development
    echo   stop-all.bat production
    exit /b 1
  )
)

echo.
echo =============================================================
echo  Stopping Mandala Exchange Ecosystem in %MODE% mode...
echo =============================================================
echo.

echo [1/3] Terminating Backend/Frontend Services by Ports...

:: Mematikan proses berdasarkan Port (Sangat andal karena judul window cmd bisa berubah)
echo - Checking Port %PORT_FRONTEND% (Frontend)...
for /f "tokens=5" %%p in ('netstat -aon ^| findstr LISTENING ^| findstr :%PORT_FRONTEND%') do (
  echo   Killing PID %%p on Port %PORT_FRONTEND%...
  taskkill /t /f /pid %%p >nul 2>&1
)

echo - Checking Port %PORT_SEKURITAS% (Sekuritas Backend)...
for /f "tokens=5" %%p in ('netstat -aon ^| findstr LISTENING ^| findstr :%PORT_SEKURITAS%') do (
  echo   Killing PID %%p on Port %PORT_SEKURITAS%...
  taskkill /t /f /pid %%p >nul 2>&1
)

echo - Checking Port %PORT_MATS% (MATS Service)...
for /f "tokens=5" %%p in ('netstat -aon ^| findstr LISTENING ^| findstr :%PORT_MATS%') do (
  echo   Killing PID %%p on Port %PORT_MATS%...
  taskkill /t /f /pid %%p >nul 2>&1
)

echo - Checking Port %PORT_BEI% (BEI Service)...
for /f "tokens=5" %%p in ('netstat -aon ^| findstr LISTENING ^| findstr :%PORT_BEI%') do (
  echo   Killing PID %%p on Port %PORT_BEI%...
  taskkill /t /f /pid %%p >nul 2>&1
)

echo - Checking Port %PORT_BOT% (BOT Service)...
for /f "tokens=5" %%p in ('netstat -aon ^| findstr LISTENING ^| findstr :%PORT_BOT%') do (
  echo   Killing PID %%p on Port %PORT_BOT%...
  taskkill /t /f /pid %%p >nul 2>&1
)

:: Backup: Matikan sisa window cmd menggunakan filter WINDOWTITLE jika proses belum sempat listening port
echo - Cleaning up remaining CMD Windows by Title...
taskkill /fi "WINDOWTITLE eq BOT Service %MODE%*" /t /f >nul 2>&1
taskkill /fi "WINDOWTITLE eq MATS Service %MODE%*" /t /f >nul 2>&1
taskkill /fi "WINDOWTITLE eq Sekuritas Backend %MODE%*" /t /f >nul 2>&1
taskkill /fi "WINDOWTITLE eq Sekuritas Frontend %MODE%*" /t /f >nul 2>&1
taskkill /fi "WINDOWTITLE eq BEI Service %MODE%*" /t /f >nul 2>&1
taskkill /fi "WINDOWTITLE eq Cloudflare Tunnel %MODE%*" /t /f >nul 2>&1

echo Waiting 3 seconds for ports to release...
timeout /t 3 /nobreak >nul

echo.
echo [2/3] Gracefully Stopping Docker Containers (Databases and Redis)...
echo.

pushd BEI
echo Stopping BEI Database...
docker compose --env-file ".env.docker.%MODE%" -p "mandala-bei-%COMPOSE_PROJECT_SUFFIX%" down
if errorlevel 1 echo [WARN] Failed to stop BEI Database, continuing...
popd
echo.

pushd MATS
echo Stopping MATS Database...
docker compose --env-file ".env.docker.%MODE%" -p "mandala-mats-%COMPOSE_PROJECT_SUFFIX%" down
if errorlevel 1 echo [WARN] Failed to stop MATS Database, continuing...
popd
echo.

pushd SEKURITAS
echo Stopping Sekuritas Database...
docker compose --env-file ".env.docker.%MODE%" -p "mandala-sekuritas-%COMPOSE_PROJECT_SUFFIX%" down
if errorlevel 1 echo [WARN] Failed to stop Sekuritas Database, continuing...
popd
echo.

echo =============================================================
echo  [3/3] Mandala Exchange Stack Stopped Safely!
echo =============================================================
echo.
pause
