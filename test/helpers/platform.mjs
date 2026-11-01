// 平台能力判定（Windows 基线治理，2026-10）。
//
// 目标：Windows 上跑 `npm test` 时，只跳过**真的依赖 POSIX/Linux 能力**的用例，
// 并且每条 skip 都带可读原因；跨平台可修的断言一律修掉，不拿 skip 掩盖回归。
//
// 用法（node:test 的 options 支持 string = 带原因跳过）：
//   test('...', { skip: skipUnlessLinux('需要 systemd 用户服务') }, (t) => { ... });
import { spawnSync } from 'node:child_process';

export const isWindows = process.platform === 'win32';
export const isLinux = process.platform === 'linux';
export const isPosix = process.platform !== 'win32';

/** 命令存在且能正常退出（只用于决定 skip，不用于断言被测行为）。 */
export function commandAvailable(command, args = ['--version']) {
  try {
    const result = spawnSync(command, args, { stdio: 'ignore', timeout: 5000 });
    return result.status === 0;
  } catch {
    return false;
  }
}

/** true = 需要 POSIX 权限位/信号/符号链接语义。 */
export function posixOnly(reason = '依赖 POSIX 权限位或信号语义，Windows 上不可比') {
  return isPosix ? false : reason;
}

export function skipOnWindows(reason = '该用例依赖 POSIX/Linux 行为') {
  return isWindows ? reason : false;
}

export function skipUnlessLinux(reason = '该用例依赖 Linux（bash/systemd/docker）') {
  return isLinux ? false : reason;
}

export function skipUnlessBash(reason = '缺少 bash，无法运行该用例') {
  return commandAvailable('bash', ['-c', 'true']) ? false : reason;
}

export function skipUnlessDocker(reason = '缺少可用的 docker，无法运行该用例') {
  return commandAvailable('docker', ['info']) ? false : reason;
}
