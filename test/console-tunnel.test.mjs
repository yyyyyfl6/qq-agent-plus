import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.join(repo, 'console-tunnel.sh');
const source = fs.readFileSync(file, 'utf8');
const hasBash = spawnSync('bash', ['--version'], { encoding: 'utf8' }).status === 0;
const skip = hasBash ? false : '需要 bash';

test('console-tunnel.sh：不依赖本地项目，能读令牌/凭据并建三条隧道', { skip }, () => {
  assert.match(source, /ssh -N/);
  assert.match(source, /-L "\$\{CONSOLE_PORT\}:127\.0\.0\.1:\$\{CONSOLE_PORT\}"/);
  assert.match(source, /-L "\$\{WEBUI_PORT\}:127\.0\.0\.1:\$\{WEBUI_PORT\}"/);
  assert.match(source, /-L "\$\{VNC_PORT\}:127\.0\.0\.1:\$\{VNC_PORT\}"/);
  assert.match(source, /console-access\.txt/);
  assert.match(source, /deployment-access\.txt/);
  assert.match(source, /TEST_OK/);
  assert.match(source, /forget/);
});

test('console-tunnel.bat：密钥失败时退回密码登录，不再硬卡 BatchMode', { skip }, () => {
  const bat = fs.readFileSync(path.join(repo, 'console-tunnel.bat'), 'utf8');
  assert.match(bat, /if errorlevel 1 \(/);
  assert.match(bat, /set "SSH_READ=-o"ConnectTimeout=10""/,
    '失败后退回不带 BatchMode 的 SSH，让密码提示能出来');
  assert.match(bat, /ssh %SSH_READ% %SRV% "%REMOTE_CMD%"/);
  assert.match(bat, /ssh %SSH_READ% %SRV% "%CRED_CMD%"/);
  assert.match(bat, /if not "%~2"=="" set "SRV=%~2"/, 'test 后可以直接带服务器地址');
});

test('console-tunnel.sh：test 后可以直接带服务器地址，不再交互式询问', () => {
  assert.match(source, /test\)\s*\n\s*MODE=test\s*\n\s*\[\[ -n "\$\{2:-\}" \]\] && SRV="\$2"/);
});

test('release 工作流：把两个连接脚本挂到 Release 资产', { skip }, () => {
  const release = fs.readFileSync(path.join(repo, '.github/workflows/release.yml'), 'utf8');
  assert.match(release, /gh release upload/);
  assert.match(release, /console-tunnel\.bat console-tunnel\.sh/);
  assert.match(release, /--prerelease/, 'RC tag 必须标成 prerelease');
});

test('console-tunnel.sh：语法正确，--help 可独立运行', { skip }, () => {
  const syntax = spawnSync('bash', ['-n', file], { encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);
  const help = spawnSync('bash', [file, '--help'], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(help.status, 0, help.stdout + help.stderr);
  assert.match(help.stdout, /console-tunnel/);
});
