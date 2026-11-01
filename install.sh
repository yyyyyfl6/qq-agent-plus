#!/usr/bin/env bash
# 一键安装入口（"小白版"）：把能默认的都默认掉，全程零提问。
#
# 它只是 deploy-all.sh 的一层薄封装：
#   1) 用大白话做前置检查（root 交给 root-install.sh 降权；脚本要和整仓在一起）；
#   2) 以 --yes 调 deploy-all.sh（端口/目录/凭据全走默认，Docker 缺失时自动装）；
#   3) 模型配置默认跳过（留到网页控制台里配：有服务预设和连通性测试，比命令行好填）——
#      要现在就配就传 --model-base-url / --model-api-key / --model，或设同名环境变量；
#   4) 装完打印"接下来三步"（控制台一键登录链接、扫码登录入口、白名单），外加最常见的
#      排障提示。以前这些都要人去看文档，小白看不到就来报问题（2026-10-12）。
#
# 进阶用法照旧：交互式用 deploy-all.sh；本脚本接受并透传它的一切参数（--image-mirror、
# --root-dir、--image…），--help 也会转到 deploy-all.sh 的帮助。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
DEPLOY_ALL="$SCRIPT_DIR/deploy-all.sh"

info() { printf '%s\n' "$*"; }
warn() { printf '警告：%s\n' "$*" >&2; }
die() { printf '\n[一键安装] %s\n' "$*" >&2; exit 1; }

# ── 前置检查：全部给出"下一步怎么做"，别只报错 ──────────────────────────────
case "${BASH_VERSINFO[0]:-0}" in
  0|1|2|3) die "需要 bash 4 以上（当前 ${BASH_VERSION:-unknown}）。请用 bash install.sh 运行。" ;;
esac

# --help 只打印帮助，不能继续走到“安装完成”清单（否则会打印空 token 的假成功页）。
if [[ -f "$DEPLOY_ALL" ]]; then
  for arg in "$@"; do
    case "$arg" in
      -h|--help) exec bash "$DEPLOY_ALL" --help ;;
    esac
  done
fi

# 发行版/运行环境体检：Alpine（musl）、无 systemd、无包管理器的环境直接说清楚，
# 不要让用户在装到一半才看到 Node 二进制或 systemctl 报错。
if [[ "$(uname -s)" == "Linux" && "${QQ_AGENT_PLATFORM_CHECKED:-}" != "1" ]]; then
  if ! bash "$SCRIPT_DIR/scripts/check-platform.sh" --strict; then
    die '当前系统不受支持（原因见上）。推荐 Ubuntu 22.04/24.04、Debian 12、Rocky/Alma 9；openSUSE 等 dnf/zypper 系可尝试，但属于预期可用、未实测。'
  fi
  export QQ_AGENT_PLATFORM_CHECKED=1
fi

# root 不是问题，但机器人不该以 root 跑：交给 root 包装层创建/复用普通服务用户，
# 完成 Docker、docker 组、linger、目录属主这些 root 才能做的事，再以服务用户重跑本脚本。
if [[ "$(id -u)" == "0" ]]; then
  ROOT_INSTALLER="$SCRIPT_DIR/scripts/root-install.sh"
  [[ -f "$ROOT_INSTALLER" ]] \
    || die "缺少 scripts/root-install.sh；请使用完整仓库，或改用普通用户运行 bash install.sh"
  exec bash "$ROOT_INSTALLER" "$@"
fi

if [[ ! -f "$DEPLOY_ALL" ]]; then
  die "找不到同目录的 deploy-all.sh：$DEPLOY_ALL
  这个脚本要和整个项目放在一起跑，单独一个文件不行。克隆完整仓库后重试：
      git clone https://github.com/sakurawwwxh/qq-agent-plus.git
      cd qq-agent-plus
      bash install.sh"
fi

# ── 机器规格提示：不阻断安装，但别让 1C1G 机器装完就 OOM ────────────────────
# SnowLuma 里是 Chromium，再叠 Node 与 ffmpeg；1GB 内存的 VPS 很容易在扫码/回复时被 OOM。
STACK_DIR="${QQ_AGENT_STACK_DIR:-/mnt/data/qq-agent}"
PREV_ARG=""
for arg in "$@"; do
  if [[ "$PREV_ARG" == "--root-dir" ]]; then STACK_DIR="$arg"; fi
  case "$arg" in
    --root-dir=*) STACK_DIR="${arg#*=}" ;;
  esac
  PREV_ARG="$arg"
done
if [[ -r /proc/meminfo ]]; then
  MEM_KB="$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)"
  if [[ -n "$MEM_KB" ]] && (( MEM_KB > 0 && MEM_KB < 1800000 )); then
    warn "内存约 $((MEM_KB / 1024))MB，低于建议的 2GB。SnowLuma/Chromium 可能 OOM；建议 2 核 2GB 以上，或加 swap。"
  fi
fi
CPU_COUNT="$(nproc 2>/dev/null || true)"
if [[ -n "$CPU_COUNT" ]] && (( CPU_COUNT < 2 )); then
  warn "只有 $CPU_COUNT 个 CPU 核心；建议至少 2 核，否则扫码登录和模型回复会明显变慢。"
fi
DISK_CHECK_DIR="$(dirname "$STACK_DIR")"
[[ -d "$DISK_CHECK_DIR" ]] || DISK_CHECK_DIR=/
FREE_KB="$(df -Pk "$DISK_CHECK_DIR" 2>/dev/null | awk 'NR==2 {print $4}')"
if [[ -n "$FREE_KB" ]] && (( FREE_KB < 8 * 1024 * 1024 )); then
  warn "部署盘剩余约 $((FREE_KB / 1024))MB，低于建议的 8GB；镜像、日志和媒体文件可能把磁盘写满。"
fi

# ── 模型配置：显式给了就不跳过，否则留到控制台里配 ──────────────────────────
MODEL_REQUESTED=false
if [[ -n "${QQ_AGENT_MODEL_BASE_URL:-}${QQ_AGENT_MODEL_API_KEY:-}${QQ_AGENT_MODEL:-}" ]]; then
  MODEL_REQUESTED=true
fi
for arg in "$@"; do
  case "$arg" in
    --model-base-url|--model-api-key|--model) MODEL_REQUESTED=true ;;
  esac
done

ARGS=(--yes)
[[ "$MODEL_REQUESTED" == true ]] || ARGS+=(--skip-model-config)

info '== QQ Agent 一键安装 =='
info '接下来全自动完成：装 Docker → 拉协议端镜像 → 部署 QQ Agent → 生成凭据。'
info '全程不问问题；模型 Key 和群号装完在网页控制台里填（结束时会打印入口）。'
info ''

# 透传用户参数；放在内置 flag 之后，后出现的同名参数会覆盖前面的（与 deploy-all.sh 的解析顺序一致）。
# 输出同时落一份日志：失败时给出日志路径，成功时从日志里抠出凭据文件位置（不重复推导默认值）。
LOG_FILE="${TMPDIR:-/tmp}/qq-install-$(date +%Y%m%d-%H%M%S).log"
set +e
bash "$DEPLOY_ALL" "${ARGS[@]}" "$@" 2>&1 | tee "$LOG_FILE"
status=${PIPESTATUS[0]}
set -e
if [[ "$status" -ne 0 ]]; then
  printf '\n[一键安装] 安装没有完成（退出码 %s），上面最后几行通常就是原因。\n' "$status" >&2
  printf '完整日志：%s\n' "$LOG_FILE" >&2
  printf '按提示处理好后重跑同一条命令即可（已装好的部分不会被重复安装）。\n' >&2
  exit "$status"
fi

# ── --check-only 只预检、什么都不装：别把"预检通过"说成"安装完成"（2026-10-13 审查） ──
CHECK_ONLY=false
for arg in "$@"; do
  if [[ "$arg" == "--check-only" ]]; then CHECK_ONLY=true; fi
done
if [[ "$CHECK_ONLY" == true ]]; then
  printf '\n（--check-only：只做了预检、没有安装任何东西。去掉这个参数重跑即可正式安装。）\n'
  exit 0
fi

# ── 装完的"接下来三步"：从凭据文件里取真实地址，别让新人去翻文档 ────────────
ACCESS_FILE="$(sed -n 's/^Credentials: *//p' "$LOG_FILE" 2>/dev/null | tail -n 1 || true)"
rm -f "$LOG_FILE"
if [[ -z "$ACCESS_FILE" || ! -f "$ACCESS_FILE" ]]; then
  ACCESS_FILE="${QQ_AGENT_STACK_DIR:-/mnt/data/qq-agent}/deployment-access.txt"
fi
read_field() {
  # 文件不存在/读不了时**安静地**给空串：清单会退回通用文案，不能因为读凭据失败就报错退出
  #（set -e + pipefail 下，裸 sed 失败会把整个脚本带走）。分隔符用 | ——键名里有斜杠
  #（"QQ login/noVNC"），用默认的 / 会把 s/// 表达式拆坏、静默匹配不到。
  { sed -n "s|^$1: *||p" "$ACCESS_FILE" 2>/dev/null || true; } | tail -n 1
}
CONSOLE_URL="$(read_field 'Agent console')"
CONSOLE_TOKEN="$(read_field 'Agent token')"
VNC_URL="$(read_field 'QQ login/noVNC')"
VNC_PASSWORD="$(read_field 'noVNC password')"
MODE="$(read_field 'Mode')"
ROOT_GUESS="$(dirname "$ACCESS_FILE")"
# 安全组清单里的端口要从**实际地址**里取：端口可被 --agent-port 等参数改掉，重跑既有实例时
# 还来自 .env —— 写死默认值会给小白指错端口（"打不开网页"的根因；2026-10-13 审查）。
port_of() { sed -nE 's#^https?://[^:/]+:([0-9]+).*$#\1#p' <<<"$1"; }
CONSOLE_PORT="$(port_of "$CONSOLE_URL")"
[[ -n "$CONSOLE_PORT" ]] || CONSOLE_PORT=3210
SNOWLUMA_PORT="$(port_of "$(read_field 'SnowLuma WebUI')")"
[[ -n "$SNOWLUMA_PORT" ]] || SNOWLUMA_PORT=5099
NOVNC_PORT="$(port_of "$VNC_URL")"
[[ -n "$NOVNC_PORT" ]] || NOVNC_PORT=6081

printf '\n============================================================\n'
printf '安装完成。接下来三步（都在浏览器里做）：\n\n'
printf '① 打开控制台\n'
printf '   推荐：在你自己的电脑上建 SSH 隧道（不用下载项目）：\n'
printf '     ssh -N -L %s:127.0.0.1:%s -L %s:127.0.0.1:%s -L %s:127.0.0.1:%s <你的登录用户>@<服务器公网IP>\n' \
  "$CONSOLE_PORT" "$CONSOLE_PORT" "$SNOWLUMA_PORT" "$SNOWLUMA_PORT" "$NOVNC_PORT" "$NOVNC_PORT"
printf '   然后打开（链接已带登录令牌）：http://127.0.0.1:%s/?token=%s\n' "$CONSOLE_PORT" "$CONSOLE_TOKEN"
printf '   只有当你已经在云安全组放行 %s 时，才能直接打开：%s/?token=%s\n' \
  "$CONSOLE_PORT" "$CONSOLE_URL" "$CONSOLE_TOKEN"
printf '   也可以只下载一个连接脚本（Windows / macOS / Linux 都有，不用克隆项目）：\n'
printf '     Windows:  scp <你的登录用户>@<服务器公网IP>:%s/app/console-tunnel.bat .  然后双击\n' "$ROOT_GUESS"
printf '     macOS/Linux: scp <你的登录用户>@<服务器公网IP>:%s/app/console-tunnel.sh .  然后 bash console-tunnel.sh\n' "$ROOT_GUESS"
printf '     （把 <你的登录用户>@<服务器公网IP> 换成你平时 SSH 登录用的地址）\n'
printf '     也可以直接从 GitHub 下载（GitHub 可达时）：\n'
printf '       https://raw.githubusercontent.com/sakurawwwxh/qq-agent-plus/main/console-tunnel.bat\n'
printf '       https://raw.githubusercontent.com/sakurawwwxh/qq-agent-plus/main/console-tunnel.sh\n'
printf '   （Windows 10+ 自带 ssh；没有就在“设置 → 应用 → 可选功能”里装 OpenSSH 客户端。）\n'
printf '   在「设置 → 模型 API」里选服务、填 Key、保存，点「测试连通性」通过即可。\n\n'
printf '   注意：新装默认只监听 127.0.0.1（SnowLuma WebUI %s / QQ 远程桌面 %s）；\n' "$SNOWLUMA_PORT" "$NOVNC_PORT"
printf '   远程访问只走上面的 SSH 隧道。存量安装如果是旧安装器部署的，可能仍绑 0.0.0.0；\n'
printf '   需要收紧就重跑 deploy-all.sh --loopback（显式对外开放才用 --publish）。\n\n'
if [[ -n "$VNC_URL" ]]; then
  printf '② 登录 QQ：隧道里打开 http://127.0.0.1:%s（密码：%s）→ 按页面提示扫码登录。\n' "$NOVNC_PORT" "$VNC_PASSWORD"
  printf '   （若已放行 %s，也可直接打开 %s）\n' "$NOVNC_PORT" "$VNC_URL"
else
  printf '② 扫码登录 QQ（登录入口与控制台在同一份凭据文件里）。\n'
fi
printf '   登录后回控制台首页，看到「OneBot 已连接」就对了。\n\n'
printf '③ 把要用它的群加进白名单：控制台「设置 → 聊天白名单」填群号并保存。\n'
if [[ "$MODE" == "observe" ]]; then
  printf '   （机器人默认「观察」模式只看不说话；确认没问题后在控制台首页把运行模式切到「启用」。）\n'
fi
printf '\n全套凭据也在：%s\n' "$ACCESS_FILE"
if [[ "${QQ_AGENT_ROOT_INSTALL_WRAPPED:-}" == "1" ]]; then
  printf '\n出问题先看日志：\n   sudo qq-agent-manage logs\n'
  printf '（服务用户是 qqagent；机器人进程不是 root）\n'
else
  printf '\n出问题先看日志：\n   bash %s/app/manage.sh logs\n' "$ROOT_GUESS"
fi
printf '============================================================\n'
