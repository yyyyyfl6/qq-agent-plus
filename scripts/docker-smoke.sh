#!/bin/sh
# 只依赖 Docker 的镜像冒烟：首次启动、控制台健康、容器模式守卫、权限、优雅退出。
# 用法：sh scripts/docker-smoke.sh <镜像> [端口]
# 不依赖宿主机的 node/curl/jq —— 检查都在容器内用 node 执行。
set -eu

IMAGE="${1:-qq-agent-plus:test}"
PORT="${2:-${SMOKE_PORT:-13310}}"
NAME="qq-agent-smoke-$$"
VOL="qq-agent-smoke-$$"

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker volume rm "$VOL" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

fail() {
  echo "[smoke] FAIL: $*" >&2
  docker logs "$NAME" 2>&1 | tail -40 >&2 || true
  exit 1
}

echo "[smoke] image=$IMAGE port=$PORT"
docker volume create "$VOL" >/dev/null

# 1) 用户命令必须被执行（而不是吞掉参数直接启动机器人），且已降权到 uid 1000
UID_OUT=$(docker run --rm "$IMAGE" sh -c 'id -u')
[ "$UID_OUT" = "1000" ] || fail "entrypoint 没有降权到 uid 1000（实际 $UID_OUT）"

# 2) 全新卷 + 只读根文件系统启动
docker run -d --name "$NAME" \
  --read-only --tmpfs /tmp:size=1g \
  --security-opt no-new-privileges:true \
  -p "127.0.0.1:${PORT}:3210" \
  -v "${VOL}:/data" \
  -e QQ_AGENT_RUNTIME=docker \
  "$IMAGE" >/dev/null

i=0
while [ "$i" -lt 40 ]; do
  if docker exec "$NAME" node -e "fetch('http://127.0.0.1:3210/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
    break
  fi
  i=$((i + 1))
  sleep 1
done
[ "$i" -lt 40 ] || fail "40 秒内 /healthz 没有就绪"

# 3) 令牌与访问文件
TOKEN=$(docker exec "$NAME" node -e "console.log(require('/data/config.json').server.token)")
[ -n "$TOKEN" ] || fail "config.json 没有生成令牌"
docker exec "$NAME" sh -c 'test -f /data/console-access.txt' || fail "console-access.txt 没有生成"
# 默认液态玻璃壁纸必须是运行期资源；.dockerignore 的 *.png 曾把它排除
docker exec "$NAME" node -e "fetch('http://127.0.0.1:3210/assets/liquid-wallpaper.png').then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))" \
  || fail "默认壁纸 /assets/liquid-wallpaper.png 返回非 200"

# 4) 容器标记 + 绑定地址
docker exec "$NAME" node -e "
fetch('http://127.0.0.1:3210/api/config',{headers:{'x-console-token':process.argv[1]}})
  .then(r=>r.json())
  .then(j=>{
    if (j.runtime?.container !== true) throw new Error('runtime.container 不是 true');
    if (j.server?.host !== '0.0.0.0') throw new Error('server.host 不是 0.0.0.0');
  })
  .catch(e=>{ console.error(e?.message || e); process.exit(1); })
" "$TOKEN" || fail "容器运行时标记/绑定地址不正确"

# 5) 容器内手动更新必须被拒绝（409），而不是留下一个永远不执行的 pending
docker exec "$NAME" node -e "
fetch('http://127.0.0.1:3210/api/auto-update/run',{
  method:'POST',
  headers:{'content-type':'application/json','x-console-token':process.argv[1]},
  body:JSON.stringify({confirm:true})
}).then(r=>process.exit(r.status===409?0:1)).catch(()=>process.exit(1))
" "$TOKEN" || fail "容器内 /api/auto-update/run 没有返回 409"

# 6) 数据目录归 node（uid 1000）、目录 0700，配置 0600
docker exec "$NAME" sh -c 'test "$(stat -c %u /data)" = "1000"' || fail "/data 属主不是 1000"
docker exec "$NAME" sh -c 'test "$(stat -c %a /data)" = "700"' || fail "/data 权限不是 0700"
docker exec "$NAME" sh -c 'test "$(stat -c %a /data/config.json)" = "600"' || fail "config.json 权限不是 0600"

# 7) docker stop 优雅退出（应用内部收尾期限 25s，这里与 compose 的 30s 对齐）
docker stop -t 30 "$NAME" >/dev/null
CODE=$(docker inspect "$NAME" --format '{{.State.ExitCode}}')
[ "$CODE" = "0" ] || fail "SIGTERM 后退出码为 $CODE（期望 0）"

echo "[smoke] OK"
