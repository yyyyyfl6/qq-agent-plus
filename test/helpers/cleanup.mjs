// Windows 测试清理：句柄未释放时 fs.rmSync 会 EPERM。
//
// Linux 允许删除仍被打开的文件，Windows 不允许：SQLite/WAL 或子进程短暂持有句柄，
// after 钩子就会抛 EPERM，把一条本来通过的用例判成失败。这里只对**清理**做有界重试，
// 不让清理问题掩盖真实断言；最终仍失败时打一条警告，留给 test-suite 的统一清理兜底。
import fs from 'node:fs';

export function rmDirBestEffort(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 25, retryDelay: 200 });
    return true;
  } catch (error) {
    console.warn(`[test-cleanup] 无法删除 ${target}：${error?.code || error?.message || error}`);
    return false;
  }
}
