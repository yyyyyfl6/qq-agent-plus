// 镜像站回退的真实控制流（Issue #5：国内拉不到 Docker Hub）。
//
// 不重跑整个 deploy-all.sh（它会装服务、写系统配置），而是把"镜像站列表"与"拉镜像"两段
// 原样抽出来，用桩 docker 跑：直连失败 → 逐个镜像站重试（用户给的在前、内置兜底在后）→
// 成功就把 .env 里的引用一起改掉；全失败才打指引并退出。抽的是源码本身，所以断言的是真控制流。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scriptPath = path.join(repo, 'deploy-all.sh');

function hasBash() {
  const probe = spawnSync('bash', ['--version'], { encoding: 'utf8' });
  return probe.status === 0;
}

/** 抽出 deploy-all.sh 里"下载镜像"整段（从注释到 die 之后的 fi）。 */
function pullBlock() {
  const lines = fs.readFileSync(scriptPath, 'utf8').split('\n');
  const start = lines.findIndex((l) => l.startsWith('# 拉一个引用：每个地址最多 3 次'));
  assert.ok(start >= 0, '没找到拉镜像那段（脚本结构变了就要同步改这个用例）');
  let end = -1;
  for (let i = start; i < lines.length; i++) {
    if (/Failed to download SnowLuma image/.test(lines[i])) {
      end = lines.findIndex((l, j) => j > i && l === 'fi');
      break;
    }
  }
  assert.ok(end > start, '没找到拉镜像那段的结尾');
  return lines.slice(start, end + 1).join('\n');
}

/** 抽出 deploy-all.sh 里"镜像站列表"整段（用户给的在前面 + 内置兜底追加去重 + 逐个校验）。 */
function mirrorListBlock() {
  const lines = fs.readFileSync(scriptPath, 'utf8').split('\n');
  const start = lines.findIndex((l) => l.startsWith('# 镜像站列表'));
  assert.ok(start >= 0, '没找到镜像站列表那段（脚本结构变了就要同步改这个用例）');
  const marker = lines.findIndex((l, i) => i > start && l.includes('Invalid image mirror host'));
  assert.ok(marker > start, '没找到镜像站校验那行');
  const end = lines.findIndex((l, i) => i > marker && l.trim() === 'done');
  assert.ok(end > marker, '没找到镜像站校验循环的结尾');
  return lines.slice(start, end + 1).join('\n');
}

function runBlock({ image, mirrors = [], argMirror = '', succeedFor, hasLocalImage = false }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-pull-'));
  const envFile = path.join(dir, '.env');
  fs.writeFileSync(envFile, `SNOWLUMA_IMAGE=${image}\nSNOWLUMA_CONTAINER=qq-agent-snowluma\n`, { mode: 0o600 });
  const harness = `
set -u
ENV_FILE=${JSON.stringify(envFile)}
IMAGE=${JSON.stringify(image)}
QQ_AGENT_IMAGE_MIRROR=${JSON.stringify(mirrors.join(','))}
IMAGE_MIRROR_ARG=${JSON.stringify(argMirror)}
STUB_DIR=${JSON.stringify(dir)}
HAS_LOCAL_IMAGE=${hasLocalImage ? 1 : 0}
die() { printf 'DIE: %s\\n' "$*" >&2; exit 3; }
step() { printf 'STEP: %s\\n' "$*"; }
info() { printf 'INFO: %s\\n' "$*"; }
sleep() { :; }
# 桩：默认本地没有镜像；只有 succeedFor 里的引用才拉得动
docker_call() {
  local sub="$1" ref="$2"
  if [[ "$sub" == image ]]; then
    [[ "$HAS_LOCAL_IMAGE" == 1 && "$2" == inspect ]] && return 0
    return 1
  fi
  if [[ "$sub" == pull ]]; then
    for want in ${succeedFor.map((s) => JSON.stringify(s)).join(' ')}; do
      [[ "$ref" == "$want" ]] && { printf 'PULLED %s\\n' "$ref"; return 0; }
    done
    printf 'Error response from daemon: dial tcp 203.0.113.7:443: i/o timeout\\n' >&2
    return 1
  fi
  return 0
}
${mirrorListBlock()}
printf 'MIRRORS=%s\\n' "\${IMAGE_MIRRORS[*]}"
${pullBlock()}
printf 'FINAL_IMAGE=%s\\n' "$IMAGE"
`;
  const res = spawnSync('bash', ['-c', harness], { encoding: 'utf8' });
  const envAfter = fs.readFileSync(envFile, 'utf8');
  fs.rmSync(dir, { recursive: true, force: true });
  return { status: res.status, out: `${res.stdout}${res.stderr}`, envAfter };
}

test('直连失败时按顺序试镜像站，成功后把 .env 里的引用一起改掉', { skip: !hasBash() && '需要 bash' }, () => {
  const image = 'motricseven7/snowluma:v1.14.15';
  const good = `docker.m.daocloud.io/${image}`;
  const r = runBlock({
    image,
    mirrors: ['unreachable.example', 'docker.m.daocloud.io'],
    succeedFor: [good]
  });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /Retrying through image mirror unreachable\.example/);
  assert.match(r.out, /Retrying through image mirror docker\.m\.daocloud\.io/);
  assert.match(r.out, new RegExp(`PULLED docker\\.m\\.daocloud\\.io/${image.replace(/[.:/]/g, '\\$&')}`));
  assert.match(r.out, new RegExp(`FINAL_IMAGE=docker\\.m\\.daocloud\\.io/${image.replace(/[.:/]/g, '\\$&')}`));
  assert.ok(r.envAfter.includes(`SNOWLUMA_IMAGE=docker.m.daocloud.io/${image}`), 'compose 走 --env-file，引用要同步');
  assert.ok(r.envAfter.includes('SNOWLUMA_CONTAINER=qq-agent-snowluma'), '其它行不能被改掉');
});

test('直连成功就不碰镜像站', { skip: !hasBash() && '需要 bash' }, () => {
  const image = 'motricseven7/snowluma:v1.14.15';
  const r = runBlock({ image, mirrors: ['docker.m.daocloud.io'], succeedFor: [image] });
  assert.equal(r.status, 0, r.out);
  assert.doesNotMatch(r.out, /Retrying through image mirror/);
  assert.ok(r.envAfter.includes(`SNOWLUMA_IMAGE=${image}`));
});

test('本地已有镜像时跳过拉取（离线 docker load 场景）', { skip: !hasBash() && '需要 bash' }, () => {
  const image = 'motricseven7/snowluma:v1.14.15';
  const r = runBlock({ image, mirrors: ['docker.m.daocloud.io'], succeedFor: [], hasLocalImage: true });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /Using locally loaded image/);
  assert.doesNotMatch(r.out, /PULLED /, '本地已有镜像就不要再访问 registry');
  assert.ok(r.envAfter.includes(`SNOWLUMA_IMAGE=${image}`));
});

test('全都拉不到时打指引再退出（含三种办法、内置站与"镜像站是第三方"）', { skip: !hasBash() && '需要 bash' }, () => {
  const image = 'motricseven7/snowluma:v1.14.15';
  const r = runBlock({ image, mirrors: ['docker.m.daocloud.io'], succeedFor: [] });
  assert.equal(r.status, 3, `应当以 die 退出：${r.out}`);
  for (const needle of [
    'QQ_AGENT_IMAGE_MIRROR=<mirror>',
    'registry-mirrors',
    'docker save',
    '镜像站由第三方提供',
    '内置的公共加速站已经自动试过一轮',
    'docker.1panel.live'
  ]) {
    assert.ok(r.out.includes(needle), `指引里应包含：${needle}`);
  }
  assert.match(r.out, /DIE: Failed to download SnowLuma image/);
});

test('一个镜像站都没给时，内置兜底列表照常生效（国内开箱即用）', { skip: !hasBash() && '需要 bash' }, () => {
  const image = 'motricseven7/snowluma:v1.14.15';
  const r = runBlock({ image, succeedFor: [`docker.1panel.live/${image}`] });
  assert.equal(r.status, 0, r.out);
  // 整行锚定：只匹配前缀的话，末尾多出一个重复项（去重坏掉）也照样通过（变异验证发现的漏洞）
  assert.match(r.out, /^MIRRORS=docker\.1panel\.live docker\.m\.daocloud\.io$/m, '内置列表要按固定顺序补上');
  assert.match(r.out, /Retrying through image mirror docker\.1panel\.live/);
  assert.ok(r.envAfter.includes(`SNOWLUMA_IMAGE=docker.1panel.live/${image}`), '走内置站也要把 .env 引用一起改掉');
});

test('用户给的排在前面，重复的内置站不会试第二遍', { skip: !hasBash() && '需要 bash' }, () => {
  const image = 'motricseven7/snowluma:v1.14.15';
  const r = runBlock({
    image,
    mirrors: ['mine.example', 'docker.m.daocloud.io'],
    argMirror: 'arg.example',
    succeedFor: []
  });
  assert.match(r.out, /^MIRRORS=mine\.example docker\.m\.daocloud\.io arg\.example docker\.1panel\.live$/m);
});

test('换站：.env 里存的旧镜像前缀先剥掉再试新站（2026-10-12 审查）', { skip: !hasBash() && '需要 bash' }, () => {
  // 默认走内置兜底之后，"IMAGE 带旧镜像前缀"是国内新装的常态；不剥前缀的话换站重跑会把
  // 旧前缀原样拼给每个镜像站 —— 旧站一挂就永远换不到新站（hint 首推的换站办法也会失效）。
  const base = 'motricseven7/snowluma:v1.14.15';
  const r = runBlock({
    image: `docker.1panel.live/${base}`,   // 上次走内置站写进 .env 的形态
    mirrors: ['docker.m.daocloud.io'],
    succeedFor: [`docker.m.daocloud.io/${base}`]
  });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /^MIRRORS=docker\.m\.daocloud\.io docker\.1panel\.live$/m, '去重后新站在前、旧内置站仍在列表里');
  assert.match(r.out, /Retrying through image mirror docker\.m\.daocloud\.io/);
  assert.match(r.out, /PULLED docker\.m\.daocloud\.io\/motricseven7\/snowluma:v1\.14\.15/);
  assert.match(r.out, /^FINAL_IMAGE=docker\.m\.daocloud\.io\/motricseven7\/snowluma:v1\.14\.15$/m);
  assert.ok(r.envAfter.includes(`SNOWLUMA_IMAGE=docker.m.daocloud.io/${base}`), '换站成功后 .env 要换成新前缀');
  assert.ok(!r.envAfter.includes('docker.1panel.live'), '旧前缀不能留在 .env 里');
  assert.doesNotMatch(r.out, /PULLED docker\.1panel\.live\/motricseven7/, '旧前缀（直连那步已试过）不该再原样重试一遍');
});

test('非法镜像站地址照样拒绝', { skip: !hasBash() && '需要 bash' }, () => {
  const r = runBlock({ image: 'motricseven7/snowluma:v1.14.15', mirrors: ['bad_host!'], succeedFor: [] });
  assert.equal(r.status, 3, r.out);
  assert.match(r.out, /DIE: Invalid image mirror host: bad_host!/);
});
