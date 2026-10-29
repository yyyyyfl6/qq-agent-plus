#!/bin/sh
# 容器入口：先以 root 修正数据卷属主，再降权到 node 运行应用。
#
# 为什么需要这一步：Docker 新建的命名卷/绑定目录通常属于 root，而应用镜像按非 root 运行。
# 如果直接 USER node 启动，第一次写 config.json 就会 EACCES，用户看到的只是一个
# "权限不足"的堆栈。这里只在启动瞬间用 root（chown），随后立刻 exec 成 node；
# 应用进程本身始终不是 root。
#
# 降权工具优先 gosu（镜像里已安装），退回 util-linux 的 setpriv。
# 两者都没有时明确失败，而不是悄悄以 root 跑应用。
set -eu

DATA_DIR="${QQ_AGENT_DATA_DIR:-/data}"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  # NFS root-squash / 只读卷等场景 chown 会失败：不在这里中断，交给 bootstrap 的写测试
  # 给出带宿主机修法的错误。
  chown -R node:node "$DATA_DIR" 2>/dev/null || true
  # 数据目录只给 node 自己：SQLite 与 session 文件默认 0644，multi-user 宿主机上
  # 其他用户可以读聊天记录。bare-metal 部署同样把数据目录设成 0700。
  chmod 700 "$DATA_DIR" 2>/dev/null || true
  if command -v gosu >/dev/null 2>&1; then
    exec env HOME=/home/node gosu node "$0" "$@"
  elif command -v setpriv >/dev/null 2>&1; then
    exec env HOME=/home/node setpriv --reuid=node --regid=node --init-groups "$0" "$@"
  else
    echo "[docker] 缺少 gosu/setpriv，无法降权到 node；拒绝以 root 身份运行应用。" >&2
    exit 1
  fi
fi

# 用户显式传了命令（docker run <镜像> sh / node -v / 排障脚本）：只做降权，然后执行它。
# 没有这条分支时，ENTRYPOINT 会吞掉命令直接启动机器人 —— 排障时看起来像"命令没生效"。
if [ "$#" -gt 0 ]; then
  exec "$@"
fi

# 非 root：引导脚本负责首次配置与令牌，然后 exec 成应用进程（PID 1 直接是 node，
# docker stop 的 SIGTERM 能走到 server.js 的优雅退出）。
# umask 077：config.json / SQLite / session 新建文件默认 0600，不靠每个写入点各自 chmod。
umask 077
node /app/scripts/docker-bootstrap.mjs
exec node /app/src/server.js
