// 控制台指标：只收集低基数计数（总请求数/状态码分桶/延迟分位），不按路由/群/用户打标签。
// 内存里滚动保留最近 1000 次请求的延迟，快照时排序算 p50/p95。
// 进程级 event-loop 利用率一起带出来：高负载时先看它，再看 HTTP p95。
import { performance } from 'node:perf_hooks';

export function createMetrics({ maxSamples = 1000 } = {}) {
  const startedAt = Date.now();
  const durations = [];
  const byStatus = {};
  let total = 0;

  function recordHttp(status, durationMs) {
    total += 1;
    const bucket = `${Math.floor((Number(status) || 0) / 100)}xx`;
    byStatus[bucket] = (byStatus[bucket] || 0) + 1;
    const ms = Number(durationMs);
    if (Number.isFinite(ms)) {
      durations.push(ms);
      if (durations.length > maxSamples) durations.shift();
    }
  }

  function snapshot() {
    const sorted = [...durations].sort((a, b) => a - b);
    const percentile = (ratio) => (sorted.length
      ? Math.round(sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio))] * 10) / 10
      : 0);
    // eventLoopUtilization 是进程启动以来的累计值（不是瞬时值），适合看"是不是长期被同步代码占满"。
    let elu = { utilization: 0, active: 0, idle: 0 };
    try {
      const value = performance.eventLoopUtilization();
      elu = {
        utilization: Math.round((Number(value.utilization) || 0) * 1000) / 1000,
        activeMs: Math.round(Number(value.active) || 0),
        idleMs: Math.round(Number(value.idle) || 0)
      };
    } catch { /* 老 Node 没有这个 API 时保持 0 */ }
    return {
      startedAt,
      requests: { total, byStatus: { ...byStatus } },
      latencyMs: { samples: sorted.length, p50: percentile(0.5), p95: percentile(0.95) },
      eventLoop: elu
    };
  }

  return { recordHttp, snapshot };
}
