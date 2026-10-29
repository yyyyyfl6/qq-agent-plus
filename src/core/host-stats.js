// 主机资源（只读）：给控制台「总览」页用的 CPU / 内存 / 磁盘 / 运行时长。
//
// 为什么要它：控制台其它页讲的全是"机器人做了什么"，没有一处告诉你"这台机器还好吗"——
// 磁盘满了、内存被吃光这类事故，以前只能 ssh 上去看。这里只做只读采样，不写任何东西。
import fs from 'node:fs';
import os from 'node:os';

/** 人类可读的字节数（1024 进制，保留一位小数；0 与小于 1KB 单独处理）。 */
export function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = n;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i += 1; }
  return `${i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

/** 已用百分比（0~100，保留一位小数；分母为 0 时返回 0）。 */
export function usedPercent(used, total) {
  const t = Number(total);
  const u = Number(used);
  if (!Number.isFinite(t) || !Number.isFinite(u) || t <= 0) return 0;
  return Math.round(Math.max(0, Math.min(1, u / t)) * 1000) / 10;
}

/**
 * 采一次主机资源。任何一项取不到就置 null（前端显示"不可用"），
 * **绝不因为一个指标失败而让整个接口 500** —— 总览页宁可少一格，也不能整页打不开。
 */
export function hostStats({ dir = process.cwd(), now = Date.now() } = {}) {
  const out = { at: now, hostname: '', platform: '', cpuCount: 0, cpuModel: '', loadavg: null, uptimeSec: 0, mem: null, disk: null };
  try { out.hostname = os.hostname(); } catch { /* 忽略 */ }
  try {
    out.platform = `${os.platform()} · ${os.arch()}`;
    out.cpuCount = os.cpus()?.length || 0;
    out.cpuModel = String(os.cpus()?.[0]?.model || '').trim();
    out.uptimeSec = Math.round(os.uptime());
  } catch { /* 忽略 */ }
  try {
    const la = os.loadavg();
    // Windows 上 loadavg 恒为 0：如实标出来，别让页面显示一个假的 0.00
    out.loadavg = Array.isArray(la) && la.some((v) => Number(v) > 0) ? la.map((v) => Math.round(v * 100) / 100) : null;
  } catch { out.loadavg = null; }
  try {
    const total = os.totalmem();
    const free = os.freemem();
    out.mem = { total, free, used: total - free, usedPercent: usedPercent(total - free, total) };
  } catch { out.mem = null; }
  try {
    const st = fs.statfsSync ? fs.statfsSync(dir) : null;
    if (st) {
      const total = Number(st.blocks) * Number(st.bsize);
      const free = Number(st.bfree) * Number(st.bsize);
      out.disk = { mount: dir, total, free, used: total - free, usedPercent: usedPercent(total - free, total) };
    }
  } catch { out.disk = null; }
  // 进程自身的 RSS / 堆：排查"是不是机器人自己吃内存"时最有用的一格
  try {
    const m = process.memoryUsage();
    out.process = { pid: process.pid, rss: m.rss, heapUsed: m.heapUsed, heapTotal: m.heapTotal, nodeVersion: process.version };
  } catch { out.process = null; }
  return out;
}
