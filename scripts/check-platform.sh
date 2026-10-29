#!/bin/sh
# 只读的发行版/运行环境体检：安装前告诉用户“这台机器能不能装、属于哪一档”，
# 也用于在容器/假 os-release 里模拟不同发行版（不改系统）。
#
# 用法：
#   sh scripts/check-platform.sh            # 打印体检结果
#   sh scripts/check-platform.sh --strict   # 明确不支持时退出 1
#
# 测试/模拟注入（不设就走真实探测）：
#   OS_RELEASE_FILE=/path/to/os-release
#   PLATFORM_PACKAGE_MANAGER=apt-get|dnf|yum|zypper|pacman|apk
#   PLATFORM_HAS_SYSTEMD=1|0
#   PLATFORM_LIBC=glibc|musl
set -eu

STRICT=false
[ "${1:-}" = "--strict" ] && STRICT=true

OS_RELEASE_FILE="${OS_RELEASE_FILE:-/etc/os-release}"
ID=""
ID_LIKE=""
PRETTY_NAME=""
if [ -r "$OS_RELEASE_FILE" ]; then
  # shellcheck disable=SC1090
  . "$OS_RELEASE_FILE"
fi

detect_pm() {
  if [ -n "${PLATFORM_PACKAGE_MANAGER:-}" ]; then
    printf '%s' "$PLATFORM_PACKAGE_MANAGER"
    return
  fi
  for pm in apt-get dnf yum zypper pacman apk; do
    if command -v "$pm" >/dev/null 2>&1; then
      printf '%s' "$pm"
      return
    fi
  done
  printf 'none'
}

PM="$(detect_pm)"

if [ -n "${PLATFORM_HAS_SYSTEMD:-}" ]; then
  HAS_SYSTEMD="$PLATFORM_HAS_SYSTEMD"
elif [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1 && command -v loginctl >/dev/null 2>&1; then
  HAS_SYSTEMD=1
else
  HAS_SYSTEMD=0
fi

if [ -n "${PLATFORM_LIBC:-}" ]; then
  LIBC="$PLATFORM_LIBC"
elif command -v ldd >/dev/null 2>&1 && ldd --version 2>&1 | head -n 1 | grep -qi musl; then
  LIBC=musl
else
  LIBC=glibc
fi

# ID/ID_LIKE 的归一化：小写、空格分隔。
DISTRO="$(printf '%s %s' "${ID:-}" "${ID_LIKE:-}" | tr '[:upper:]' '[:lower:]')"

SUPPORTED=false
TIER=unknown
case " $DISTRO " in
  *" ubuntu "*)
    SUPPORTED=true; TIER=tested ;;
  *" debian "*|*" rocky "*|*" almalinux "*|*" fedora "*|*" centos "*|*" rhel "*|*" amzn "*|*" oracle "*|*" arch "*|*" manjaro "*|*" opensuse-leap "*|*" opensuse-tumbleweed "*|*" sles "*|*" openeuler "*|*" anolis "*|*" kylin "*|*" uos "*)
    SUPPORTED=true; TIER=expected ;;
esac

VERDICT=supported
REASON=""
if [ "$LIBC" = musl ]; then
  VERDICT=unsupported
  REASON="Alpine/musl：项目使用 glibc 版 Node 官方二进制，musl 发行版不支持"
elif [ "$HAS_SYSTEMD" != 1 ]; then
  VERDICT=unsupported
  REASON="需要 systemd 用户服务（容器/WSL1/Alpine 等没有 systemd 的环境不支持）"
elif [ "$PM" = none ]; then
  VERDICT=unsupported
  REASON="找不到受支持的包管理器（apt/dnf/yum/zypper/pacman）"
elif [ "$SUPPORTED" != true ]; then
  VERDICT=unknown
  REASON="未明确测试过的发行版；脚本会按包管理器尝试，失败时请提供 /etc/os-release"
fi

echo "distro: ${PRETTY_NAME:-${ID:-unknown}}"
echo "id: ${ID:-unknown}${ID_LIKE:+ (like: $ID_LIKE)}"
echo "package-manager: $PM"
echo "systemd: $([ "$HAS_SYSTEMD" = 1 ] && echo yes || echo no)"
echo "libc: $LIBC"
echo "tier: $TIER"
echo "verdict: $VERDICT"
[ -z "$REASON" ] || echo "reason: $REASON"

if [ "$VERDICT" = unsupported ] && [ "$STRICT" = true ]; then
  exit 1
fi
exit 0
