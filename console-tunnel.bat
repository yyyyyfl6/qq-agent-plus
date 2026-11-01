@echo off
chcp 65001 >nul
title QQ Agent 控制台 - SSH 隧道
setlocal enabledelayedexpansion

rem ===========================================================================
rem  一键打开 QQ Agent 控制台：建 SSH 隧道 + 自动免登录打开浏览器。
rem  不需要记服务器地址、不需要在服务器上开任何公网端口。
rem
rem  用法（在本文件所在目录）：
rem    console-tunnel.bat               首次运行会提示输入 用户@服务器，之后自动记住
rem    console-tunnel.bat user@host     指定服务器并记住它
rem    console-tunnel.bat test          只验证隧道与控制台连通，不开浏览器（供脚本调用）
rem    console-tunnel.bat forget        忘记已记住的服务器地址
rem
rem  依赖：Windows 10+ 自带的 ssh 与 curl。
rem        （ssh 若缺失：设置 → 应用 → 可选功能 → 添加“OpenSSH 客户端”）
rem  服务器侧默认端口：3210 控制台 / 5099 SnowLuma WebUI / 6081 QQ 扫码登录；
rem  可用环境变量 QQ_AGENT_CONSOLE_PORT / QQ_AGENT_WEBUI_PORT / QQ_AGENT_VNC_PORT 覆盖。
rem
rem  等价工具（本机已装 Node 时）：node src/ops.js console --open
rem ===========================================================================

set "CFG=%~dp0.console-tunnel.cfg"
if "%QQ_AGENT_STACK_DIR%"=="" (set "STACK_DIR=/mnt/data/qq-agent") else (set "STACK_DIR=%QQ_AGENT_STACK_DIR%")
set "SSHOPTS=-o"BatchMode=yes" -o"ServerAliveInterval=30" -o"ServerAliveCountMax=3" -o"ConnectTimeout=15" -o"ExitOnForwardFailure=yes""
set "SSH_READ=-o"BatchMode=yes" -o"ConnectTimeout=10""
if "%QQ_AGENT_CONSOLE_PORT%"=="" (set "CONSOLE_PORT=3210") else (set "CONSOLE_PORT=%QQ_AGENT_CONSOLE_PORT%")
if "%QQ_AGENT_WEBUI_PORT%"=="" (set "WEBUI_PORT=5099") else (set "WEBUI_PORT=%QQ_AGENT_WEBUI_PORT%")
if "%QQ_AGENT_VNC_PORT%"=="" (set "VNC_PORT=6081") else (set "VNC_PORT=%QQ_AGENT_VNC_PORT%")

rem ── 解析参数、读取/记住服务器地址 ─────────────────────────────────────────
set "MODE=run"
set "SRV="
if /i "%~1"=="forget" goto forget
if /i "%~1"=="test" (
  set "MODE=test"
  if not "%~2"=="" set "SRV=%~2"
) else if not "%~1"=="" set "SRV=%~1"

if "%SRV%"=="" if exist "%CFG%" set /p SRV=<"%CFG%"
if "%SRV%"=="" (
  echo 首次使用：请输入服务器地址（格式 user@host，例如 ubuntu@203.0.113.10）
  set /p "SRV=服务器: "
)
if "%SRV%"=="" goto nohost
echo %SRV%>"%CFG%"

rem ── 认证方式：优先密钥；没有密钥就退回普通 SSH，让用户输密码 ─────────────
ssh %SSH_READ% %SRV% "exit 0" >nul 2>&1
if errorlevel 1 (
  set "SSH_READ=-o"ConnectTimeout=10""
  set "SSHOPTS=-o"ServerAliveInterval=30" -o"ServerAliveCountMax=3" -o"ConnectTimeout=15" -o"ExitOnForwardFailure=yes""
  set "PASSWORD_MODE=1"
)

rem ── 从服务器读取控制台 Token，用于打开浏览器时免登录 ─────────────────────
set "TOKEN="
set "REMOTE_CMD=for f in %STACK_DIR%/data/console-access.txt /data/qq-agent/data/console-access.txt; do if [ -f $f ]; then awk '/^Token/{print $2; exit}' $f; break; fi; done"
rem 注意：ssh 的 -o 选项必须用「贴紧」写法（-o"K=V"），带空格的写法在 for /f 里会被拆坏。
rem 令牌可能含 !，这一段必须关掉 delayed expansion；用临时文件把值带回外层作用域。
set "TOKEN_FILE=%TEMP%\qq-agent-token-%RANDOM%-%RANDOM%.txt"
setlocal disabledelayedexpansion
for /f "usebackq delims=" %%t in (`ssh %SSH_READ% %SRV% "%REMOTE_CMD%"`) do >>"%TOKEN_FILE%" echo %%t
endlocal
if exist "%TOKEN_FILE%" set /p TOKEN=<"%TOKEN_FILE%"
del "%TOKEN_FILE%" >nul 2>&1
if "%TOKEN%"=="" (set "URL=http://127.0.0.1:%CONSOLE_PORT%/") else (set "URL=http://127.0.0.1:%CONSOLE_PORT%/?token=%TOKEN%")

where ssh >nul 2>&1 || goto nossh

echo ============================================================
echo   QQ Agent 控制台（SSH 隧道到 %SRV%）
echo ============================================================
echo.
echo 正在建立 SSH 隧道（密钥登录不会提示；密码登录最多可能提示三次）...
echo.
echo    QQ Agent 控制台 ....... http://127.0.0.1:%CONSOLE_PORT%
echo    SnowLuma WebUI ........ http://127.0.0.1:%WEBUI_PORT%
echo    QQ 远程桌面 / 扫码 .... http://127.0.0.1:%VNC_PORT%
echo.
rem ── 从服务器读 SnowLuma / noVNC 的登录凭据 ───────────────────────────────
rem 只给 URL 不给密码，打开 SnowLuma WebUI 会卡在登录页（那份凭证在服务器上的
rem deployment-access.txt 里，0600 权限；顺手取一次，省得用户再 ssh 去找）。
set "CRED_CMD=for f in %STACK_DIR%/deployment-access.txt /data/qq-agent/deployment-access.txt; do if [ -f $f ]; then grep -E '^(SnowLuma password|noVNC password): ' $f; break; fi; done"
rem ⚠️ 这一段临时关掉 delayed expansion：密码里可能带 ! ，开着会被 cmd 吃掉
rem （实测踩过：Sl-xxxx!Aa 打印成 Sl-xxxxAa，用户照抄就登不上）
setlocal disabledelayedexpansion
for /f "usebackq delims=" %%c in (`ssh %SSH_READ% %SRV% "%CRED_CMD%"`) do (
  echo    %%c
  set "GOT_CRED=1"
)
if defined GOT_CRED echo    （SnowLuma 登录账号固定 admin，只用密码；第二行是 QQ 扫码/远程桌面密码）
endlocal
echo.
echo 关闭本窗口 = 断开隧道；服务器上的机器人照常运行。
if "%TOKEN%"=="" (
  echo.
  echo 没自动读到控制台令牌，打开控制台后手动登录即可。令牌取法：
  echo   ssh %SRV% "cat /data/qq-agent/data/console-access.txt"
) else (
  echo 打开控制台时将自动登录（令牌已通过 SSH 现场读取，不落盘）。
)
echo ============================================================
echo.

rem ── 启动隧道：正常运行挂在当前窗口；测试模式用独立窗口以便收尾清理 ──
if "%MODE%"=="test" (
  start "QQ Agent Tunnel TEST" /min cmd /c ssh %SSHOPTS% -N -L %CONSOLE_PORT%:127.0.0.1:%CONSOLE_PORT% -L %WEBUI_PORT%:127.0.0.1:%WEBUI_PORT% -L %VNC_PORT%:127.0.0.1:%VNC_PORT% %SRV%
) else (
  start /b ssh %SSHOPTS% -N -L %CONSOLE_PORT%:127.0.0.1:%CONSOLE_PORT% -L %WEBUI_PORT%:127.0.0.1:%WEBUI_PORT% -L %VNC_PORT%:127.0.0.1:%VNC_PORT% %SRV%
)

where curl >nul 2>&1
if errorlevel 1 goto nocurl

echo 等待控制台就绪（最多 45 秒）...
set /a tries=0
:waitloop
set /a tries+=1
curl -s -o nul --max-time 2 "http://127.0.0.1:%CONSOLE_PORT%/" >nul 2>&1
if not errorlevel 1 goto ready
if %tries% geq 45 goto stalled
%SystemRoot%\System32\timeout.exe /t 1 >nul
goto waitloop

:ready
if "%MODE%"=="test" (
  taskkill /f /t /fi "WINDOWTITLE eq QQ Agent Tunnel TEST" >nul 2>&1
  echo TEST_OK: 隧道与控制台均就绪（测试模式，未打开浏览器，隧道已清理）
  exit /b 0
)
echo 隧道就绪（用了 %tries% 秒），正在打开控制台...
start "" "%URL%"
echo.
echo 控制台已打开。若浏览器没弹出，把下面这行整条粘进地址栏：
echo   %URL%
echo.
pause >nul
exit /b 0

:nocurl
echo （本机没有 curl，无法验证控制台响应）
if "%MODE%"=="test" (
  taskkill /f /t /fi "WINDOWTITLE eq QQ Agent Tunnel TEST" >nul 2>&1
  echo TEST_FAIL: 本机没有 curl，无法验证隧道/控制台
  exit /b 1
)
%SystemRoot%\System32\timeout.exe /t 8 >nul
start "" "%URL%"
echo 控制台已打开。若浏览器没弹出，把下面这行整条粘进地址栏：
echo   %URL%
pause >nul
exit /b 0

:stalled
echo.
echo ！！45 秒内没能连上控制台。
echo    可能原因：网络不通 / SSH 密钥失效 / 服务器地址不对 / 服务器上控制台没在跑。
echo    可在另一个窗口手动试：ssh %SRV%
if "%MODE%"=="test" (
  taskkill /f /t /fi "WINDOWTITLE eq QQ Agent Tunnel TEST" >nul 2>&1
  exit /b 1
)
pause >nul
exit /b 1

:nossh
echo 本机缺少 ssh 命令。请在“设置 → 应用 → 可选功能”里添加 OpenSSH 客户端后重试。
pause
exit /b 1

:nohost
echo 没有服务器地址，已退出。
echo 可以直接把地址作为参数：console-tunnel.bat user@host
pause
exit /b 1

:forget
if exist "%CFG%" del "%CFG%"
echo 已忘记记住的服务器地址（%CFG% 已删除）。
exit /b 0
