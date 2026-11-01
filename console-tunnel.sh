#!/usr/bin/env bash
# 本地单文件控制台隧道：不需要克隆仓库、不需要本机 Node。
#
# 用法（在本文件所在目录）：
#   bash console-tunnel.sh                 # 首次提示输入 user@host，之后记住
#   bash console-tunnel.sh user@host       # 指定服务器并记住
#   bash console-tunnel.sh test [user@host] # 只验证隧道/控制台，不开浏览器
#   bash console-tunnel.sh forget          # 清除记住的服务器地址
#
# 依赖：本机 ssh（Windows 10+、macOS、Linux 一般自带）与可选 curl。
# 服务器侧默认端口：3210 控制台 / 5099 SnowLuma / 6081 QQ 扫码；
# 可用 QQ_AGENT_CONSOLE_PORT / QQ_AGENT_WEBUI_PORT / QQ_AGENT_VNC_PORT 覆盖。
set -euo pipefail

CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/qq-agent"
CFG="$CONFIG_DIR/console-tunnel"
CONSOLE_PORT="${QQ_AGENT_CONSOLE_PORT:-3210}"
WEBUI_PORT="${QQ_AGENT_WEBUI_PORT:-5099}"
VNC_PORT="${QQ_AGENT_VNC_PORT:-6081}"
MODE="run"
SRV=""
TUNNEL_PID=""

info() { printf '%s\n' "$*"; }
warn() { printf '！%s\n' "$*" >&2; }

cleanup() {
  if [[ -n "$TUNNEL_PID" ]] && kill -0 "$TUNNEL_PID" 2>/dev/null; then
    kill "$TUNNEL_PID" 2>/dev/null || true
    wait "$TUNNEL_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

case "${1:-}" in
  forget)
    rm -f "$CFG"
    info "已忘记记住的服务器地址（$CFG 已删除）。"
    exit 0
    ;;
  test)
    MODE=test
    [[ -n "${2:-}" ]] && SRV="$2"
    ;;
  -h|--help)
    sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'
    exit 0
    ;;
  "")
    ;;
  *)
    SRV="$1"
    ;;
esac

mkdir -p "$CONFIG_DIR"
if [[ -z "$SRV" && -f "$CFG" ]]; then
  SRV="$(head -n 1 "$CFG" | tr -d '\r\n')"
fi
if [[ -z "$SRV" ]]; then
  info "首次使用：请输入服务器地址（格式 user@host，例如 ubuntu@203.0.113.10）"
  printf '服务器: '
  IFS= read -r SRV
fi
[[ -n "$SRV" ]] || { warn '没有服务器地址，已退出。'; exit 1; }
printf '%s\n' "$SRV" >"$CFG"

if ! command -v ssh >/dev/null 2>&1; then
  warn '本机缺少 ssh。Windows 可在“设置 → 应用 → 可选功能”添加 OpenSSH 客户端；macOS/Linux 请先安装 openssh-client。'
  exit 1
fi

# 优先走密钥（BatchMode）；没有密钥时退回普通 SSH，让用户输一次密码。
# 远端读取和隧道各一次认证，密码登录可能会提示两次。
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=10)
if ! ssh "${SSH_OPTS[@]}" "$SRV" true >/dev/null 2>&1; then
  SSH_OPTS=(-o ConnectTimeout=10)
fi

# 读取控制台令牌与 SnowLuma/noVNC 密码。只读，不落盘。
# 支持自定义部署根目录；legacy /data/qq-agent 仍作为兜底。
STACK_DIR="${QQ_AGENT_STACK_DIR:-/mnt/data/qq-agent}"
REMOTE_READ="$(cat <<EOF
STACK_DIR='$STACK_DIR'
for f in "\$STACK_DIR/data/console-access.txt" /data/qq-agent/data/console-access.txt; do
  if [ -f "\$f" ]; then awk '/^Token/{print \$2; exit}' "\$f"; break; fi
done
echo __CREDS__
for f in "\$STACK_DIR/deployment-access.txt" /data/qq-agent/deployment-access.txt; do
  if [ -f "\$f" ]; then grep -E '^(SnowLuma password|noVNC password): ' "\$f"; break; fi
done
EOF
)"
ERR_FILE="$(mktemp "${TMPDIR:-/tmp}/qq-tunnel-ssh.XXXXXX")"
REMOTE_OUT="$(ssh "${SSH_OPTS[@]}" "$SRV" "$REMOTE_READ" 2>"$ERR_FILE" || true)"
if [[ -s "$ERR_FILE" ]]; then
  # 密码回退时不能把 stderr 丢掉：首次连接的 host key 提示/认证错误都在这里。
  sed 's/^/[ssh] /' "$ERR_FILE" >&2
fi
rm -f "$ERR_FILE"
TOKEN="$(printf '%s\n' "$REMOTE_OUT" | sed -n '1,/^__CREDS__$/p' | sed '$d' | head -n 1 | tr -d '\r')"
CREDS="$(printf '%s\n' "$REMOTE_OUT" | sed -n '/^__CREDS__$/,$p' | tail -n +2)"

CONSOLE_URL="http://127.0.0.1:${CONSOLE_PORT}/"
if [[ -n "$TOKEN" ]]; then
  CONSOLE_URL="${CONSOLE_URL}?token=${TOKEN}"
fi

info '============================================================'
info "  QQ Agent 控制台（SSH 隧道到 $SRV）"
info '============================================================'
info ''
info '正在建立 SSH 隧道（密钥登录不会提示；密码登录可能提示输入两次密码）...'
info ''
info "   QQ Agent 控制台 ....... http://127.0.0.1:${CONSOLE_PORT}"
info "   SnowLuma WebUI ........ http://127.0.0.1:${WEBUI_PORT}"
info "   QQ 远程桌面 / 扫码 .... http://127.0.0.1:${VNC_PORT}"
if [[ -n "$CREDS" ]]; then
  printf '%s\n' "$CREDS" | sed 's/^/   /'
  info '   （SnowLuma 登录账号固定 admin；noVNC 密码用于 QQ 扫码/远程桌面）'
fi
info ''
info '关闭本终端 = 断开隧道；服务器上的机器人照常运行。'

# 隧道放后台，失败即退出（ExitOnForwardFailure）。
ssh -N \
  "${SSH_OPTS[@]}" \
  -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 \
  -o ExitOnForwardFailure=yes \
  -L "${CONSOLE_PORT}:127.0.0.1:${CONSOLE_PORT}" \
  -L "${WEBUI_PORT}:127.0.0.1:${WEBUI_PORT}" \
  -L "${VNC_PORT}:127.0.0.1:${VNC_PORT}" \
  "$SRV" &
TUNNEL_PID=$!

READY=false
if command -v curl >/dev/null 2>&1; then
  for _ in $(seq 1 45); do
    if curl -fsS --max-time 2 "$CONSOLE_URL" >/dev/null 2>&1; then READY=true; break; fi
    sleep 1
  done
else
  if [[ "$MODE" == test ]]; then
    warn '本机没有 curl，test 模式无法验证隧道/控制台；请安装 curl 后重试。'
    exit 1
  fi
  sleep 8
  READY=true
fi

if [[ "$READY" != true ]]; then
  warn '45 秒内没能连上控制台。检查：服务器地址、SSH 密钥、控制台是否在跑。'
  exit 1
fi

if [[ "$MODE" == test ]]; then
  info 'TEST_OK: 隧道与控制台均就绪（测试模式，未打开浏览器）'
  exit 0
fi

info ''
info '隧道就绪，正在打开控制台...'
if command -v xdg-open >/dev/null 2>&1; then
  xdg-open "$CONSOLE_URL" >/dev/null 2>&1 &
elif command -v open >/dev/null 2>&1; then
  open "$CONSOLE_URL" >/dev/null 2>&1 &
elif command -v wslview >/dev/null 2>&1; then
  wslview "$CONSOLE_URL" >/dev/null 2>&1 &
else
  info "请把下面这条粘进浏览器：$CONSOLE_URL"
fi
info ''
info "控制台地址：$CONSOLE_URL"
info '按 Ctrl+C 断开隧道。'
wait "$TUNNEL_PID" 2>/dev/null || true
