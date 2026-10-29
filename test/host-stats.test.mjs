// 主机资源采样（总览页用）：只读、缺项不炸、格式化的边界。
import assert from 'node:assert/strict';
import { test } from 'node:test';

const { hostStats, formatBytes, usedPercent } = await import('../src/core/host-stats.js');

test('formatBytes：0 / 小于 1KB / 进位 / 保留一位', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(-5), '0 B');
  assert.equal(formatBytes('abc'), '0 B');
  assert.equal(formatBytes(999), '999 B');
  assert.equal(formatBytes(1024), '1.0 KB');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(1024 ** 3 * 2), '2.0 GB');
});

test('usedPercent：分母为 0 / 非法值 / 夹在 0~100', () => {
  assert.equal(usedPercent(1, 0), 0);
  assert.equal(usedPercent(1, 'x'), 0);
  assert.equal(usedPercent(1, 4), 25);
  assert.equal(usedPercent(3, 3), 100);
  assert.equal(usedPercent(9, 4), 100, '超过分母要夹住，不能显示 225%');
  assert.equal(usedPercent(-1, 4), 0);
});

test('hostStats：只读采样各字段形状正确，且缺项为 null 而不是抛错', () => {
  const s = hostStats({ dir: process.cwd() });
  assert.ok(s.at > 0);
  assert.equal(typeof s.hostname, 'string');
  assert.ok(s.cpuCount >= 0);
  assert.ok(s.uptimeSec >= 0);
  assert.ok(s.mem === null || (s.mem.total > 0 && s.mem.usedPercent >= 0 && s.mem.usedPercent <= 100));
  assert.ok(s.disk === null || (s.disk.total >= 0 && s.disk.usedPercent >= 0 && s.disk.usedPercent <= 100));
  assert.ok(s.disk === null || typeof s.disk.mount === 'string');
  // Windows 的 os.loadavg() 恒为 0 → 必须变成 null（不能给页面一个假的 0.00）
  assert.ok(s.loadavg === null || (Array.isArray(s.loadavg) && s.loadavg.length === 3));
  assert.ok(s.process && s.process.pid === process.pid && s.process.rss > 0);
});

test('hostStats：磁盘读不到（目录不存在）时不抛错，只是 disk=null', () => {
  const s = hostStats({ dir: 'Z:\definitely-not-here' });
  assert.ok(s.disk === null || s.disk.usedPercent >= 0, '跨平台：要么读到要么 null，不许抛');
  assert.ok(s.mem, '内存与磁盘互不牵连');
});
