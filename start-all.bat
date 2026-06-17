@echo off
echo Starting Mandala Exchange Local Environment...

echo [1/4] Starting BEI Service...
start "BEI Service" cmd /k "cd BEI && docker-compose up -d && npm run dev"

echo [2/4] Starting MATS Service...
start "MATS Service" cmd /k "cd MATS && docker-compose up -d && go run cmd/mats/main.go"

echo [3/4] Starting Sekuritas Backend...
start "Sekuritas Backend" cmd /k "cd SEKURITAS\backend && npm run dev"

echo [4/4] Starting Sekuritas Frontend...
start "Sekuritas Frontend" cmd /k "cd SEKURITAS\frontend && npm run dev"

echo.
echo All services have been launched in separate windows!
echo - Sekuritas Frontend will be available at http://localhost:5173
echo - Sekuritas Backend will run on port 3002
echo - MATS Service will run on port 8082
echo - BEI Service will run on port 4100
echo.
pause
