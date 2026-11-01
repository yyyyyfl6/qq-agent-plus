// 发行版体检脚本的边界用例：不真的装系统，用假 os-release + 注入的包管理器/libc/systemd
// 模拟各个发行版。这样 Windows 本地也能覆盖“Alpine 拒绝、openSUSE 预期可用、无 systemd 拒绝”。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(repo, 'scripts/check-platform.sh');
const hasSh = spawnSync('sh', ['-c', 'exit 0']).status === 0;
const skip = hasSh ? false : '需要 sh';

function osRelease(t, id, like = '') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-platform-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'os-release');
  fs.writeFileSync(file, `ID=${id}\nID_LIKE="${like}"\nPRETTY_NAME="${id} test"\n`);
  return file;
}

function run(file, { pm = 'apt-get', systemd = '1', libc = 'glibc', strict = false } = {}) {
  return spawnSync('sh', [script, ...(strict ? ['--strict'] : [])], {
    encoding: 'utf8',
    env: {
      ...process.env,
      OS_RELEASE_FILE: file,
      PLATFORM_PACKAGE_MANAGER: pm,
      PLATFORM_HAS_SYSTEMD: systemd,
      PLATFORM_LIBC: libc
    },
    timeout: 10_000
  });
}

test('发行版体检：Ubuntu 已实测档', { skip }, (t) => {
  const r = run(osRelease(t, 'ubuntu', 'debian'));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /verdict: supported/);
  assert.match(r.stdout, /tier: tested/);
  assert.match(r.stdout, /package-manager: apt-get/);
});

test('发行版体检：openSUSE 属于预期可用（zypper）', { skip }, (t) => {
  const r = run(osRelease(t, 'opensuse-leap', 'suse'), { pm: 'zypper' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /verdict: supported/);
  assert.match(r.stdout, /tier: expected/);
});

test('发行版体检：Alpine/musl 明确拒绝', { skip }, (t) => {
  const r = run(osRelease(t, 'alpine'), { pm: 'apk', libc: 'musl', strict: true });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /verdict: unsupported/);
  assert.match(r.stdout, /musl/);
});

test('发行版体检：没有 systemd 明确拒绝（容器/WSL1）', { skip }, (t) => {
  const r = run(osRelease(t, 'ubuntu', 'debian'), { systemd: '0', strict: true });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /verdict: unsupported/);
  assert.match(r.stdout, /systemd/);
});

test('发行版体检：未知发行版给出 unknown，但不阻断（非 strict）', { skip }, (t) => {
  const r = run(osRelease(t, 'some-new-distro'), { pm: 'dnf' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /verdict: unknown/);
  assert.match(r.stdout, /未明确测试/);
});
