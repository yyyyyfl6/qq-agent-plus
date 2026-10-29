#!/usr/bin/env node
// 部署目标与 .deployment.json 记录的一致性校验（改进方案 C7/#3）。
// 由 deploy.sh 在部署真正开始前调用：**拒绝即"部署未开始"** —— 此时 ERR trap 尚未挂载，
// 服务未停、未 rsync、.deploy-in-progress 未落，不需要也不会走回滚。不要把这个调用
// 挪到 trap 之后。
//
// 规则（详见仓库改进方案 §3 #3 规则表）：
//   记录缺失且目录非空   → 拒绝（不是本工具管理的安装，就地更新会把来历不明的代码变成"受管"）；
//                          但安装器自己建的条目（数据目录、.runtime）不算"来历不明"，
//                          就地安装（INSTALL_DIR == 源码树）也没有覆盖风险 —— 两者都放行（2026-09-30 审查 P0）
//   data 不一致          → 拒绝；逃生开关需 --allow-path-change 与 QQ_AGENT_ALLOW_PATH_CHANGE=1 双条件
//   service 不一致       → 拒绝
//   repository/branch    → 调用方给了期望值才比对；记录缺字段跳过（0.6.x 前老安装）
//   host/port            → 只提示漂移不拒绝（真相源是 config.json，deploy.sh 的沿用逻辑
//                          已保证不覆盖现值；拒绝会误伤"控制台改监听地址后自动更新"）
import fs from 'node:fs';
import path from 'node:path';

function parseArgs(argv) {
  const args = {
    installDir: '', dataDir: '', service: '', repository: '', branch: '',
    host: undefined, port: undefined, allowPathChange: false, sourceRoot: '',
  };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const take = () => { i += 1; return argv[i]; };
    switch (key) {
      case '--install-dir': args.installDir = take(); break;
      case '--data-dir': args.dataDir = take(); break;
      case '--service': args.service = take(); break;
      case '--repository': args.repository = take(); break;
      case '--branch': args.branch = take(); break;
      case '--host': args.host = take(); break;
      case '--port': args.port = take(); break;
      case '--source-root': args.sourceRoot = take(); break;
      case '--allow-path-change': args.allowPathChange = true; break;
      default: throw new Error(`未知参数：${key}`);
    }
  }
  if (!args.installDir || !args.dataDir || !args.service) {
    throw new Error('缺少必填参数：--install-dir / --data-dir / --service');
  }
  return args;
}

// deploy.sh 在调用本校验之前会 `mkdir -p "$INSTALL_DIR" "$DATA_DIR"`（默认 --data-dir 就是
// INSTALL_DIR/data），无系统 Node 时还会把运行时下到 INSTALL_DIR/.runtime。这些是安装器自己的
// 产物，判定"目录里有没有来历不明的代码"时必须忽略，否则全新安装会被自己的产物挡在门外
// （2026-09-30 审查 P0：mkdri 在校验之前，且真空目录才是唯一能通过的形态）。
function installerOwnedEntries(installDir, dataDir) {
  const owned = new Set(['.runtime']);
  const absInstall = path.resolve(installDir);
  const absData = dataDir ? path.resolve(dataDir) : '';
  if (!absData) return owned;
  const rel = path.relative(absInstall, absData);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return owned;
  const segs = rel.split(path.sep).filter(Boolean);
  // 数据目录是 INSTALL_DIR 的直接子目录（常见：INSTALL_DIR/data）→ 忽略该条目本身。
  if (segs.length === 1) { owned.add(segs[0]); return owned; }
  // 嵌套（如 INSTALL_DIR/var/data）：只有当这条路径上的每一层**除了安装器自己的产物之外**
  // 只有下一个分段时才忽略，否则第一段里可能混着别的东西，不能整体忽略。
  // ⚠️ 下降时要先滤掉 owned —— `.runtime` 就躺在 INSTALL_DIR 里，不滤会让
  // "嵌套 --data-dir + 无系统 Node（下了 .runtime）"这种组合误判成"非空且有外来文件"
  // （2026-09-30 复审实测复现；单层 data/ 走上面那条 early return，所以没暴露）。
  let cur = absInstall;
  for (const seg of segs) {
    let entries;
    try { entries = fs.readdirSync(cur).filter((e) => !owned.has(e)); } catch { return owned; }
    if (entries.length !== 1 || entries[0] !== seg) return owned;
    cur = path.join(cur, seg);
  }
  owned.add(segs[0]);
  return owned;
}

function dirHasFiles(p, ignore = new Set()) {
  try { return fs.readdirSync(p).filter((e) => !ignore.has(e)).length > 0; } catch { return false; }
}

// 记录里的路径可能是 install-dir 的规范形（realpath），传入的可能是带尾斜杠的写法：
// 只做"尾斜杠归一"的宽松比较，不做 realpath（目录可能还不存在）。
const normPath = (p) => String(p || '').replace(/\/+$/, '') || '/';

try {
  const args = parseArgs(process.argv.slice(2));
  const metaPath = path.join(args.installDir, '.deployment.json');
  let meta = null;
  try {
    meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  } catch {
    meta = null;
  }

  const ok = [];
  const skipped = [];
  const warnings = [];
  const problems = [];
  const reject = (msg) => problems.push(msg);

  // 数据目录就是安装目录：deploy.sh 的 rsync --delete 会把数据当源码树的一部分清掉。
  // 放在记录比对之前：这个组合本身就不合法，跟 .deployment.json 里记了什么无关。
  if (path.resolve(args.installDir) === path.resolve(args.dataDir)) {
    reject('数据目录不能与安装目录相同：更新时的 rsync --delete 会把 config.json / SQLite 等数据删掉'
      + '（可以放在安装目录内，如 INSTALL_DIR/data，或放在安装目录之外，但不能就是安装目录本身）');
  }

  if (!fs.existsSync(metaPath)) {
    const owned = installerOwnedEntries(args.installDir, args.dataDir);
    const foreign = dirHasFiles(args.installDir, owned);
    // 就地安装：INSTALL_DIR 就是源码树本身（deploy.sh 的默认用法"在仓库里直接跑"）。
    // 此时 rsync 的源与目标是同一目录，不存在"把来历不明的代码当受管安装覆盖"的风险，
    // 放行（否则这条被文档与 --install-dir 默认值共同承诺的路径会被自己挡住）。
    const inPlace = !!args.sourceRoot && normPath(args.sourceRoot) === normPath(args.installDir);
    if (!foreign) {
      ok.push('全新安装：目标目录为空（或只含安装器自建的数据目录/.runtime）且无部署记录');
    } else if (inPlace) {
      ok.push('就地安装：安装目录即源码树，rsync 源与目标同目录，无覆盖来历不明代码的风险');
    } else {
      reject(`安装目录非空但没有 .deployment.json：${args.installDir} 不是本工具管理的安装`
        + '（手工/其他工具部署），就地更新会把来历不明的代码当成受管安装覆盖；'
        + '确认无误请换 --install-dir，或清空该目录后全新安装。');
    }
  } else if (!meta || typeof meta !== 'object') {
    // 与旧口径一致：记录损坏不拦（历史上一直放行），交给后续流程报错；
    // 这里打印醒目警告，避免"悄悄放行"。
    warnings.push('.deployment.json 无法解析（损坏或为空）——按现状口径不拦截，交给后续流程报错');
  } else {
    if (typeof meta.root === 'string' && meta.root) {
      if (normPath(meta.root) === normPath(args.installDir)) ok.push('install-dir 与记录一致');
      else reject(`install-dir 与记录不一致：记录 ${meta.root} / 传入 ${args.installDir}`);
    } else skipped.push('install-dir（记录缺 root）');

    if (typeof meta.data === 'string' && meta.data) {
      if (normPath(meta.data) === normPath(args.dataDir)) ok.push('data 与记录一致');
      else if (args.allowPathChange && process.env.QQ_AGENT_ALLOW_PATH_CHANGE === '1') {
        warnings.push(`数据目录迁移 ${meta.data} → ${args.dataDir}（--allow-path-change 与 QQ_AGENT_ALLOW_PATH_CHANGE=1 双条件满足；旧目录的历史与 Key 不会自动跟过来）`);
      } else {
        reject(`数据目录与记录不一致：记录 ${meta.data} / 传入 ${args.dataDir} —— 这是更新时的常见误操作，`
          + '服务会换用一个空的数据库（历史、白名单、模型 Key 都留在记录目录）。'
          + `确需迁移请同时给 --allow-path-change 并设 QQ_AGENT_ALLOW_PATH_CHANGE=1，或带 --data-dir ${meta.data} 重跑`);
      }
    } else skipped.push('data（记录缺 data）');

    if (typeof meta.service === 'string' && meta.service) {
      if (meta.service === args.service) ok.push('service 与记录一致');
      else reject(`service 与记录不一致：记录 ${meta.service} / 传入 ${args.service}`);
    } else skipped.push('service（记录缺 service）');

    // 更新器驱动的部署（QQ_AGENT_SOURCE_REVISION 由 scripts/auto-update.mjs 设置）里，
    // 源码树是刚从"控制台配置的仓库/分支"的 Release 物化出来的 —— 控制台设置就是真相源，
    // 与记录不一致只可能是"操作员刚改过设置"。此时硬拒绝会让该实例此后每次更新
    // 都被拒、disableOnFailure 还会把自动更新自停（2026-10-07 复审 P2）。手动部署维持拒绝。
    const updaterDriven = Boolean(process.env.QQ_AGENT_SOURCE_REVISION);
    for (const [name, expected] of [['repository', args.repository], ['branch', args.branch]]) {
      if (!expected) continue; // 调用方没给期望值（手动部署）：无可比对，跳过
      const recorded = typeof meta[name] === 'string' ? meta[name] : '';
      if (!recorded) {
        skipped.push(`${name}（记录缺字段，升级部署不受影响；本次部署成功后记录会补全）`);
        continue;
      }
      if (recorded === expected) ok.push(`${name} 与记录一致`);
      else if (updaterDriven) {
        warnings.push(`${name} 与记录不一致：记录 ${recorded} / 本次 ${expected}`
          + '（本次由自动更新发起，按控制台设置部署，部署成功后记录会同步）');
      } else {
        reject(`${name} 与记录不一致：记录 ${recorded} / 传入 ${expected}（确认是不是在错误的源码树里跑 deploy.sh）`);
      }
    }

    if (args.host !== undefined && typeof meta.host === 'string' && meta.host && meta.host !== args.host) {
      warnings.push(`监听地址与记录漂移：记录 ${meta.host} / 本次 ${args.host}（真相源是 config.json，仅提示）`);
    }
    if (args.port !== undefined && meta.port !== undefined && meta.port !== null
      && String(meta.port) !== String(args.port)) {
      warnings.push(`端口与记录漂移：记录 ${meta.port} / 本次 ${args.port}（真相源是 config.json，仅提示）`);
    }
  }

  for (const m of ok) console.log(`  ✓ ${m}`);
  for (const s of skipped) console.log(`  - 跳过比对：${s}`);
  for (const w of warnings) console.error(`  ⚠ ${w}`);
  if (problems.length) {
    for (const p of problems) console.error(`  ✗ ${p}`);
    console.error('部署未开始：以上是传入参数与 .deployment.json 记录的差异。'
      + '本拒绝发生在任何改动之前（服务未停、代码未动），不存在需要回滚的东西。');
    process.exit(2);
  }
  console.log('部署目标校验通过');
} catch (error) {
  console.error(`verify-deployment-target 自身出错（按拒绝处理）：${error?.message ?? error}`);
  process.exit(2);
}
