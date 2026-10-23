@echo off
chcp 65001 >nul
title LivePilot · 智播副驾
cd /d "%~dp0backend"

echo ============================================
echo   LivePilot · 智播副驾  正在启动
echo ============================================
echo.

if not exist "..\node_modules\.bin\tsx.cmd" (
  echo [错误] 找不到依赖，请先在项目根目录执行：npm install
  echo.
  pause
  exit /b 1
)

if not exist "..\frontend\dist\index.html" (
  echo [提示] 前端产物不存在，正在构建...
  pushd ..
  call npm run build -w frontend
  popd
  echo.
)

echo 浏览器将自动打开 http://localhost:4000/
echo 关闭本窗口即停止服务。
echo.

:: 3 秒后打开浏览器（等服务起来）
start "" cmd /c "timeout /t 3 >nul & start http://localhost:4000/"

:: 前台运行，Ctrl+C 或关窗口即停
"..\node_modules\.bin\tsx.cmd" src/index.ts

echo.
echo 服务已停止。
pause
