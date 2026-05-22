@echo off
cd /d "%~dp0"
echo =============================================================
echo   Initializing Lumina AI ^& Face Attendance Server...
echo =============================================================
echo.
if not exist node_modules (
    echo [INFO] Installing required backend dependencies [Express, Cors]...
    call npm install express cors
)

:: Get local IP address using Node.js
set "LOCAL_IP=localhost"
for /f "tokens=*" %%i in ('node -e "Object.values(require('os').networkInterfaces()).flat().forEach(i => { if (i.family.toString().includes('4')) { if (!i.internal) { console.log(i.address); process.exit(0); } } })" 2^>nul') do (
    set "LOCAL_IP=%%i"
)

echo.
echo =============================================================
echo   Lumina Server is starting!
echo.
echo   - Local Access:         http://localhost:3000
echo   - Network Access (LAN): http://%LOCAL_IP%:3000
echo.
echo   To open this bot on other devices (phone, tablet, etc.):
echo   1. Connect both devices to the same Wi-Fi network.
echo   2. Open the Network Access link above in your device's browser.
echo =============================================================
echo.
echo Starting Backend Server...
node server.js
pause
