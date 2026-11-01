import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { inspectLegacyLivingMemory, migrateLegacyLivingMemory } from '../src/living-memory/migration.js';

const usage = `用法：node scripts/migrate-living-memory.mjs --from <旧SQLite> --to <目标SQLite> [选项]

将旧版外置长期记忆（SQLite 卡片/来源回合）导入内置长期记忆库；不会复制 Qdrant 向量，
可选重新调用当前 Embedding 配置生成本地 Float32 向量。

选项：
  --dry-run              只检查旧库和打印待迁移统计，不写入
  --confirm              实际写入所必需
  --reembed              导入后回填内置向量
  --force-vectors        连同已就绪的本地向量一并重建
  --limit <数量>         最多回填的活跃记忆数（默认 100000）
  --batch-size <数量>    每个 Embedding 请求的卡片数（默认 8）
  --timeout-ms <毫秒>    单次 Embedding 请求超时（默认读取环境变量）
  --help                 显示本帮助`;

function integer(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : fallback;
}

function parseArgs(argv) {
  const options = { dryRun: false, confirm: false, reembed: false, forceVectors: false, limit: 100000, batchSize: 8, timeoutMs: 0 };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === '--help') return { help: true };
    if (item === '--dry-run') { options.dryRun = true; continue; }
    if (item === '--confirm') { options.confirm = true; continue; }
    if (item === '--reembed') { options.reembed = true; continue; }
    if (item === '--force-vectors') { options.forceVectors = true; continue; }
    const value = argv[index + 1];
    if (['--from', '--to', '--limit', '--batch-size', '--timeout-ms'].includes(item) && value) {
      index += 1;
      if (item === '--from') options.sourceFile = value;
      if (item === '--to') options.targetFile = value;
      if (item === '--limit') options.limit = integer(value, options.limit);
      if (item === '--batch-size') options.batchSize = integer(value, options.batchSize);
      if (item === '--timeout-ms') options.timeoutMs = integer(value, options.timeoutMs);
      continue;
    }
    throw new Error(`未知或不完整的参数：${item}`);
  }
  return options;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(usage);
    return;
  }
  if (!options.sourceFile || !options.targetFile) throw new Error('必须提供 --from 与 --to');
  if (options.dryRun) {
    console.log(JSON.stringify({ ok: true, dryRun: true, targetFile: path.resolve(options.targetFile), source: inspectLegacyLivingMemory(options) }));
    return;
  }
  if (!options.confirm) throw new Error('迁移会写入目标数据库；请先加 --dry-run 预演，再加 --confirm 执行');
  const report = await migrateLegacyLivingMemory({
    ...options,
    reindexLimit: options.limit,
    reindexBatchSize: options.batchSize,
    reindexTimeoutMs: options.timeoutMs,
    onProgress: (progress) => console.log(JSON.stringify({ phase: 'reindex', ...progress }))
  });
  console.log(JSON.stringify({ ok: true, ...report }));
}

const isMain = Boolean(process.argv[1]) && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: String(error?.message || error) }));
  process.exitCode = 1;
});
