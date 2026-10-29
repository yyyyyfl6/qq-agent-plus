// 镜像/编排的静态契约：这些断言不启动 Docker，但能挡住最容易在评审里漏掉的配置回退
// （比如把 3210 发布到 0.0.0.0、把 node_modules 打进镜像、入口又以 root 跑应用）。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');

const dockerfile = read('Dockerfile');
const dockerignore = read('.dockerignore');
const compose = read('docker-compose.yml');
const entrypoint = read('docker/entrypoint.sh');
const workflow = read('.github/workflows/docker.yml');
const docs = read('docs/DOCKER.md');

test('Dockerfile：固定 Node 22、只装生产依赖、带健康检查与入口', () => {
  assert.match(dockerfile, /^ARG NODE_IMAGE=/m);
  assert.match(dockerfile, /^FROM \$\{NODE_IMAGE\}/m);
  assert.match(dockerfile, /npm ci --omit=dev/);
  assert.match(dockerfile, /QQ_AGENT_RUNTIME=docker/);
  assert.match(dockerfile, /QQ_AGENT_DATA_DIR=\/data/);
  assert.match(dockerfile, /HEALTHCHECK[\s\S]*\/healthz/);
  assert.match(dockerfile, /start-period=150s/, '启动等待 120 秒配置时不能被 healthcheck 提前判死');
  assert.match(dockerfile, /ENTRYPOINT \["\/app\/docker\/entrypoint\.sh"\]/);
  assert.match(dockerfile, /EXPOSE 3210/);
  assert.match(dockerfile, /gosu/);
  assert.match(dockerfile, /ffmpeg/);
});

test('.dockerignore：不把 node_modules、数据、测试与构建上下文垃圾打进镜像', () => {
  for (const entry of ['node_modules', 'data', 'test', '.git']) {
    assert.ok(
      dockerignore.split('\n').map((line) => line.trim()).includes(entry),
      `.dockerignore 缺少 ${entry}`
    );
  }
  // 默认液态玻璃壁纸必须进镜像（*.png 排除规则不能把它一起带上）
  assert.ok(
    dockerignore.split('\n').map((line) => line.trim()).includes('!ui/assets/liquid-wallpaper.png'),
    '.dockerignore 缺少壁纸的否定规则'
  );
  // 本地 compose 跑过之后，这些目录/文件可能带着令牌或 QQ 登录态；漏一个就会进镜像层。
  for (const entry of [
    '.env', '.env.*', 'snowluma', 'snowluma-data', 'snowluma-client-config',
    'snowluma-client-data', 'backups', 'console-access.txt', 'deployment-access.txt',
    'config.json', '*.sqlite', '*.sqlite-*', '*.sqlite3', 'docker-compose.yml',
    '.deployment.json', '.deployment-node', '.console-tunnel.cfg',
    '.npmrc', '.netrc', '.dbg/', '.runtime/', '*.pem', '*.key', '*.crt', '*.p12', '*.pfx',
    'deploy.sh', 'deploy-all.sh', 'install.sh', 'manage.sh',
    'console-tunnel.bat', 'console-tunnel.sh'
  ]) {
    assert.ok(
      dockerignore.split('\n').map((line) => line.trim()).includes(entry),
      `.dockerignore 缺少敏感项 ${entry}`
    );
  }
});

test('compose：控制台只绑 127.0.0.1、根文件系统只读、不挂 docker.sock', () => {
  assert.match(compose, /image: \$\{SNOWLUMA_IMAGE:-docker\.m\.daocloud\.io\/motricseven7\/snowluma:v1\.14\.22\}/);
  // 应用镜像默认必须是已发布的版本 tag，不能是 latest（首次发布前 latest 不存在）
  assert.match(compose, /image: \$\{QQ_AGENT_IMAGE:-crpi-xejkraqtqkngfp11\.cn-guangzhou\.personal\.cr\.aliyuncs\.com\/wangxinhong\/qq-agent-plus:\d+\.\d+\.\d+\}/);
  assert.doesNotMatch(compose, /QQ_AGENT_IMAGE:-[^}]*:latest/);
  assert.match(compose, /127\.0\.0\.1:\$\{QQ_AGENT_PORT:-3210\}:3210/);
  assert.match(compose, /127\.0\.0\.1:\$\{SNOWLUMA_WEBUI_HOST_PORT:-5099\}:5099/);
  assert.match(compose, /read_only: true/);
  assert.match(compose, /no-new-privileges:true/);
  assert.match(compose, /\.\/data:\/data/);
  assert.match(compose, /QQ_AGENT_ONEBOT_WS_URL: \$\{[^}]+:-ws:\/\/snowluma:3001\}/);
  assert.match(compose, /QQ_AGENT_ONEBOT_HTTP_URL: \$\{[^}]+:-http:\/\/snowluma:3000\}/);
  assert.match(compose, /SNOWLUMA_INTERNAL_URL: \$\{[^}]+:-http:\/\/snowluma:5099\}/);
  assert.match(compose, /QQ_AGENT_NOVNC_URL: \$\{[^}]+:-http:\/\/snowluma:6081\/\}/);
  // OneBot 令牌：只读挂载 SnowLuma 配置自动同步；外部协议端才用显式环境变量
  assert.match(compose, /\.\/snowluma-data\/config:\/snowluma-config:ro/);
  assert.match(compose, /QQ_AGENT_SNOWLUMA_CONFIG_DIR: \/snowluma-config/);
  assert.match(compose, /QQ_AGENT_SNOWLUMA_CONFIG_WAIT_MS: \$\{QQ_AGENT_SNOWLUMA_CONFIG_WAIT_MS:-120000\}/);
  assert.match(compose, /QQ_AGENT_RUNTIME_MODE: \$\{QQ_AGENT_RUNTIME_MODE:-active\}/);
  assert.match(compose, /QQ_AGENT_ONEBOT_ACCESS_TOKEN: \$\{QQ_AGENT_ONEBOT_ACCESS_TOKEN:-/);
  assert.match(compose, /QQ_AGENT_ONEBOT_HTTP_TOKEN: \$\{QQ_AGENT_ONEBOT_HTTP_TOKEN:-/);
  assert.doesNotMatch(compose, /ONEBOT_TOKEN:/);
  // 媒体临时文件上限 96/200MB，64MB 会 ENOSPC
  assert.match(compose, /\/tmp:size=1g/);
  assert.match(compose, /VNC_PASSWD: \$\{VNC_PASSWD:-\}/);
  assert.match(compose, /stop_grace_period: 30s/);
  assert.doesNotMatch(compose, /docker\.sock/);
  assert.doesNotMatch(compose, /"0\.0\.0\.0:\$\{QQ_AGENT_PORT/);
  assert.equal((compose.match(/logging:/g) || []).length, 2, '两个服务都要有日志轮转');
  assert.match(compose, /SNOWLUMA_WEBUI_BOOTSTRAP_PASSWORD: \$\{SNOWLUMA_WEBUI_BOOTSTRAP_PASSWORD:-/,
    'SnowLuma 密码变量名要和 deploy-all 的 .env 一致');
});

test('入口脚本：chown 后降权，最终 exec 成 node（PID 1 能收 SIGTERM）', () => {
  assert.match(entrypoint, /chown -R node:node/);
  assert.match(entrypoint, /chmod 700 "\$DATA_DIR"/);
  assert.match(entrypoint, /umask 077/);
  assert.match(entrypoint, /exec env HOME=\/home\/node gosu node "\$0" "\$@"/,
    '降权时显式设置 HOME，避免 os.homedir() 落到 /root');
  assert.match(entrypoint, /exec node \/app\/src\/server\.js/);
  assert.match(entrypoint, /docker-bootstrap\.mjs/);
  assert.doesNotMatch(entrypoint, /^node \/app\/src\/server\.js$/m, '最后一步必须是 exec，不能是前台子进程');
  // docker run <镜像> sh -c ... 必须执行用户的命令，而不是吞掉参数直接启动机器人
  assert.match(entrypoint, /if \[ "\$#" -gt 0 \]; then\n\s+exec "\$@"/);
});

test('容器启动不再把旧部署标记误报成"部署中断"', () => {
  const server = read('src/server.js');
  assert.match(server, /function reportInterruptedDeploy\(\) \{[\s\S]{0,600}?if \(isContainerRuntime\(\)\) return;/);
});

test('ops 的宿主部署命令在容器里明确拒绝', () => {
  const ops = read('src/ops.js');
  for (const fn of ['cmdDeploy', 'cmdInstallTimers', 'cmdGuard']) {
    assert.match(ops, new RegExp(`function ${fn}\\([^)]*\\)\\s*\\{[\\s\\S]{0,200}?isContainerRuntime\\(\\)`));
  }
});

test('发布工作流：多架构构建并推 GHCR', () => {
  assert.match(workflow, /docker\/build-push-action/);
  assert.match(workflow, /linux\/amd64/);
  assert.match(workflow, /linux\/arm64/);
  assert.match(workflow, /ghcr\.io/);
  assert.match(workflow, /packages: write/);
});

test('文档覆盖：只有 Docker 的机器、升级、迁移与安全边界', () => {
  assert.match(docs, /只有 Docker|只装了 Docker/);
  assert.match(docs, /docker compose pull/);
  assert.match(docs, /docker compose up -d/);
  assert.match(docs, /迁移/);
  assert.match(docs, /127\.0\.0\.1/);
  assert.match(docs, /chown -R 1000:1000/);
});
