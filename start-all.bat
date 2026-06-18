@echo off
echo Starting Mandala Exchange Local Environment...

echo [1/2] Launching Docker Containers (Databases & Redis)...
pushd BEI
docker compose up -d
popd

pushd MATS
docker compose up -d
popd

echo Waiting 5 seconds for databases and Redis to be ready...
timeout /t 5 /nobreak >nul

echo [2/3] Running BEI Database Migrations & Seeding...
pushd BEI
call npm run db:migrate
call npm run db:seed
popd

echo [3/3] Launching Dev Servers...

echo Starting BEI Service...
start "BEI Service" cmd /k "cd BEI && npm run dev"

echo Starting MATS Service...
start "MATS Service" cmd /k "cd MATS && go run cmd/mats/main.go"

echo Starting Sekuritas Backend...
start "Sekuritas Backend" cmd /k "cd SEKURITAS\backend && npm run dev"

echo Starting Sekuritas Frontend...
start "Sekuritas Frontend" cmd /k "cd SEKURITAS\frontend && npm run dev"

echo.
echo All services have been launched in separate windows!
echo - Sekuritas Frontend will be available at http://localhost:5173
echo - Sekuritas Backend will run on port 3002
echo - MATS Service will run on port 8082
echo - BEI Service will run on port 4100
echo.
pause
