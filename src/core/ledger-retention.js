// 台账保留期清理的进程内每日调度。
//
// 背景：identity / relationship / incident 三个 SQLite 台账的保留期 DELETE 原来只在各自
// 构造函数（＝进程启动）里跑一次。服务是常驻的（systemd 用户服务，实际连续运行 21 天以上），
// 只要不重启就等于永不清理，表会无界增长。
//
// 为什么不挂到 orchestrator 的 5 秒兜底回收里：那是每 5 秒一次的全表 DELETE，在 861+ 会话
// 的库上会把 IO 打满（2026-10-09 复审）。这里用「1 小时 tick + 内存里的今日闸门」——每天
// 真正执行的只有一次，tick 本身只做一次字符串比较，成本可以忽略。
//
// 闸门不落盘：进程重启时各自构造函数本来就会清一次，两者刚好互补；落盘反而多一份可能写坏的
// 状态，还得处理"服务被杀在两次写之间"的边界。内存态足够。
//
// 宿主：src/server.js（进程生命周期所在处）。不在本模块里起定时器 —— 复用调用方的循环，
// 避免又多出一套独立的定时器体系。
import { createLogger } from './logger.js';
import { todayKey } from './util.js';

// 1 小时 tick：最坏情况下跨日后晚 1 小时清理，对"保留 90 天"这种粒度完全够用。
const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;

/**
 * @param {object} opts
 *   targets: Array<{ name: string, run: () => void }>  每个台账一项；逐个 try/catch
 *   intervalMs: tick 间隔（测试可注入）
 *   nowFn: 可注入时钟（测试用）。
 *     名字必须叫 nowFn 而不是 now：`node src/ops.js scan --strict`（CI 门禁）会把
 *     "未声明就调用的函数"判红，而它认不出解构参数的默认值 —— 仓库里同类注入点
 *     一律用已知名字（nowFn / fetchImpl / statfs…，见 src/ops.js 的 KNOWN_IGNORE）。
 *     改叫 now() 会让扫描报 `core/ledger-retention.js → now(第39行)`，CI 直接红。
 *   log: 注入日志器，默认走仓库 logger
 * @returns {{ runDue: () => boolean, start: () => void, stop: () => void }}
 */
export function createDailyRetentionScheduler({
  targets = [],
  intervalMs = DEFAULT_INTERVAL_MS,
  nowFn = Date.now,
  log = createLogger('retention')
} = {}) {
  let timer = null;
  // 构造这一刻＝进程刚启动，各自的构造函数已经清过一轮 —— 初始化成"今天已清过"，
  // 于是当天不会再重复执行。
  let lastDay = todayKey(nowFn());

  /**
   * 到点就跑，一天最多一次。返回这次有没有真的执行（便于测试断言闸门生效）。
   * 绝不向上抛：server.js 的 uncaughtException 会直接 process.exit(1)，
   * 一句清理失败不该有能力把服务带走。
   */
  function runDue() {
    const day = todayKey(nowFn());
    if (day === lastDay) return false;
    lastDay = day;
    for (const target of targets) {
      try {
        target?.run?.();
      } catch (error) {
        // 单个台账清理失败不影响其余台账，也不影响进程；下一天再试。
        log.error(`[retention] ${target?.name || '台账'}保留期清理失败（不影响进程，下一天再试）：`,
          error?.message ?? error);
      }
    }
    return true;
  }

  function start() {
    if (timer) return;
    timer = setInterval(runDue, Math.max(60 * 1000, Number(intervalMs) || DEFAULT_INTERVAL_MS));
    // unref：清理日程不该阻止进程正常退出。
    timer.unref?.();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { runDue, start, stop };
}
