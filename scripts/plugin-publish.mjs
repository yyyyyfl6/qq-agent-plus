#!/usr/bin/env node
// 发布一个插件：打包 → 自测 → 落进索引仓库 → 更新索引条目 → 校验 → （可选）传资产/提交/推送。
//
// 为什么要有这一条：上架流程原来是四步手工（打包、复制包、改 index.json、挂 Release），
// 而"市场"要长期维护，作者与维护者的成本必须压到一条命令。
//
// 包挂在索引仓库的**滚动 Release**（tag 固定 `packages`）上：加插件、升版本都不再新建 Release。
// 索引仓库的 CI 会在 main 收到 `plugins/**` 变更后把缺的包补传上去；--push 也会先传一遍，
// 免得"索引已公开、资产还没到"的那段窗口里装的人 404。
//
// 默认**只准备、不动远端**（把包放进索引仓库工作副本、更新 index.json、跑校验、打印下一步要执行
// 的 git 命令）；加 --push 才真的传资产、提交、推送。默认不推是刻意的：推上去是对外可见的动作，
// 不该由一次手滑决定。
//
// --push 的顺序也是刻意的：**先上传资产，再推索引**。索引里的 downloadUrl 一旦公开就被使用者
// 的"一键安装"用上了，如果反过来（先推索引、资产传失败）所有装了它的人都会 404，只能再推一次修复；
// 先传资产则失败时什么都没有对外发生（本地提交还在，重跑即可）。
//
// 用法：
//   node scripts/plugin-publish.mjs examples/plugins/weather --index-repo ../qq-agent-plugins
//   node scripts/plugin-publish.mjs examples/plugins/weather --index-repo ../qq-agent-plugins --push
//   node scripts/plugin-publish.mjs examples/plugins/weather --changelog-url https://… --icon https://…
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { indexEntryFor, packPluginDir } from './../src/plugins/pack.js';
import { installPlugin } from './../src/plugins/install.js';
import { canonicalVersion } from './../src/plugins/version.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith('--'));
const flag = (name, fallback = '') => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : (args[i + 1] ?? fallback);
};
const has = (name) => args.includes(`--${name}`);
const run = (cmd, argv, options = {}) => spawnSync(cmd, argv, { encoding: 'utf8', ...options });

if (!dir) {
  console.error(`用法：node scripts/plugin-publish.mjs <插件目录> --index-repo <索引仓库工作副本> [--tag packages] [--push]

  可选：--base-url 仓库地址 --homepage 链接 --changelog-url 链接 --icon 图标地址
        --category 分类 --tags a,b --min-version 0.8.5 --readme 文件（默认读插件目录的 README.md）
        --clear-revoked（新版本要重新上架，而该条目当前在撤回名单里时必须显式给）
  默认只准备（不动远端）；--push 才会传资产 + 提交 + 推索引（CI 也会补传缺的包）。`);
  process.exit(2);
}

const sourceDir = path.resolve(dir);
const indexRepo = path.resolve(flag('index-repo', path.join(repoRoot, '..', '..', 'qq-agent-plugins')));
// 守卫三问。原来只查了"有没有 plugins/index.json" —— 而**宿主仓库自己也有一份**
// （`plugins/index.json` 是"指路牌"，指向真正的索引仓库），于是 `--index-repo .` 能通过守卫：
// 包会被写进机器人主仓库，--push 还会给主仓库提交 + 推 tag。
if (!fs.existsSync(path.join(indexRepo, 'plugins', 'index.json'))) {
  console.error(`✗ 索引仓库工作副本不对（${indexRepo} 里没有 plugins/index.json）。先 clone：gh repo clone sakurawwwxh/qq-agent-plugins`);
  process.exit(2);
}
if (!fs.existsSync(path.join(indexRepo, 'scripts', 'verify-index.mjs'))) {
  // 后面那道硬闸门要跑它；缺了的话 --push 会在**建好 Release 之后**才失败，留一个孤立的 Release
  console.error(`✗ ${indexRepo} 里没有 scripts/verify-index.mjs —— 这不是索引仓库的工作副本。`);
  process.exit(2);
}
if (!fs.existsSync(path.join(indexRepo, '.git'))) {
  console.error(`✗ ${indexRepo} 不是一个 git 仓库（没有 .git）—— 索引仓库必须是自己 clone 下来的工作副本。`);
  process.exit(2);
}
const insideHost = path.relative(indexRepo, repoRoot);
if (insideHost === '' || (!insideHost.startsWith('..') && !path.isAbsolute(insideHost))) {
  console.error(`✗ --index-repo 指向宿主仓库自己或它的上层（${indexRepo}）：那里的 plugins/index.json 只是"指路牌"，不是索引。`);
  process.exit(2);
}

// ① 打包（自带"真装一遍"的自测；不过就直接停 —— 没验过的东西不该上架）
const packed = packPluginDir({ dir: sourceDir });
const selfTest = await (async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-publish-selftest-'));
  try {
    await installPlugin({ tarball: packed.buffer, id: packed.id, dataDir: sandbox, log: () => {} });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  } finally {
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* 句柄占用就算了 */ }
  }
})();
if (!selfTest.ok) {
  console.error(`✗ 自测没过，不予上架：${selfTest.error}`);
  process.exit(1);
}
console.log(`✓ 打包 + 自测通过：${packed.id} v${packed.version}（${(packed.bytes / 1024).toFixed(1)}KB，sha256 ${packed.sha256.slice(0, 16)}…）`);

// ② 把包落进索引仓库的 packages/（先不写：等撤回守卫过了再落盘，免得中止时留下孤儿文件）
const fileName = path.basename(packed.file || `${packed.id}-${packed.version}.tar.gz`);
const packagesDir = path.join(indexRepo, 'plugins', 'packages');
fs.mkdirSync(packagesDir, { recursive: true });
const target = path.join(packagesDir, fileName);

// ③ 生成/更新索引条目
const indexPath = path.join(indexRepo, 'plugins', 'index.json');
const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
if (!Array.isArray(index.plugins)) index.plugins = [];
const tagFromEntry = (item) => String(item?.downloadUrl || item?.tarball || item?.url || '')
  .match(/\/download\/([^/]+)\//)?.[1] || '';
const existing = index.plugins.find((item) => item.id === packed.id);
const existingTag = tagFromEntry(existing);
// 所有包共用索引仓库的一个滚动 Release（tag 固定 `packages`）。加插件、升版本都不再新建 Release，
// 也就没有了"这个条目挂在哪个批次 tag 上"的问题。`--tag` 只留给特殊/外部索引仓库。
const tag = flag('tag', 'packages');
if (existingTag && existingTag !== tag) {
  console.log(`· 注意：${packed.id} 原来挂在 ${existingTag}，这次改成 ${tag}（该条 downloadUrl 会跟着改）`);
}
// 下载地址的前缀（`https://github.com/<owner>/<repo>`）。优先 `--base-url`，否则**从索引仓库的
// git remote 推导** —— 别拿目录名猜：`--index-repo /tmp/index-scratch` 会推出
// `sakurawwwxh/index-scratch` 这种不存在的仓库，而 verify-index 只在"真下载核对"时才暴露。
// （2026-10-17 模拟外部作者发布时踩到；目录名与仓库名一致时旧写法碰巧是对的。）
const originOf = (dir) => {
  const read = (args) => {
    try { return String(execFileSync('git', args, { cwd: dir, encoding: 'utf8' })).trim(); } catch { return ''; }
  };
  const raw = read(['remote', 'get-url', 'origin']) || read(['config', '--get', 'remote.origin.url']);
  const hit = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/i.exec(raw);
  return hit ? `https://github.com/${hit[1]}/${hit[2]}` : '';
};
const baseUrl = flag('base-url', '') || originOf(indexRepo);
if (!baseUrl) {
  // 推不出来就别猜：`sakurawwwxh/<目录名>` 这种编出来的地址会写进索引，而 verify-index 只在
  // "真下载核对"时才暴露 —— 那时 Release 已经建好、条目已经写好，返工成本最高的时候。
  console.error(`✗ 推不出下载地址：--index-repo（${indexRepo}）的 git remote 不是 github.com 的地址。请加 --base-url https://github.com/<owner>/<repo>`);
  process.exit(2);
}
const readmeFile = flag('readme', path.join(sourceDir, 'README.md'));
const readme = fs.existsSync(readmeFile) ? fs.readFileSync(readmeFile, 'utf8').slice(0, 4000) : '';
const tags = flag('tags') ? flag('tags').split(',').map((t) => t.trim()).filter(Boolean) : [];
// 作者与最低宿主版本：**只在显式给出时写**，否则交给合并保留条目里原有的值。
// 原来两者都有无条件默认值（sakurawwwxh / 0.8.5），结果社区作者的条目一经维护者重发就被改成
// 维护者署名，原本 minVersion 0.9.0 的插件也会被悄悄放宽成 0.8.5（安装门控被降级）。
const authorFlag = flag('author', '');
const minVersionFlag = flag('min-version', '');
const sourceOwner = (() => {
  const hit = /github\.com\/([^/]+)\//.exec(originOf(sourceDir));
  return hit ? hit[1] : '';
})();
const entry = {
  ...indexEntryFor(packed, {
    baseUrl, tag, minVersion: minVersionFlag, tags,
    author: authorFlag || sourceOwner, homepage: flag('homepage', '')
  }),
  // 市场呈现用的字段（缺了就缺了，界面会优雅降级；这里把手上有的都填上）
  icon: flag('icon', ''),
  category: flag('category', ''),
  changelogUrl: flag('changelog-url', ''),
  readmeUrl: flag('readme-url', ''),
  readme,
  size: packed.bytes,
  updatedAt: new Date().toISOString().slice(0, 10)
};
// 没传的可选字段一律**不写**（下面合并时才会保留条目里原有的图标/分类/链接，不然每次发布都把它们清空）
for (const field of ['icon', 'category', 'changelogUrl', 'readmeUrl', 'readme', 'homepage']) {
  if (!entry[field]) delete entry[field];
}
// `tags` 也照这条办：打包器在没有 --tags 时会填默认 ['社区']，而它是"每次发布都会写进去"的字段 ——
// 直接合并就会把索引里原有的分类标签（官方/工具/生活…）冲成清一色的"社区"
//（2026-10-16 实际发生：重新发布 7 个插件后，目录的标签分面只剩"社区 7"）。
// 没传 --tags 就删掉，交给合并去保留旧值；作者真想改标签时自然会传。
if (!flag('tags', '')) delete entry.tags;
// ⚠️ `indexEntryFor()` 是**给作者生成模板**用的：缺字段时它会写 `<源码仓库或说明页的链接>` 这种占位符，
// 那是给作者照着改的。发布路径绝不能把它们当数据发出去 —— 2026-10-16 就是这么把 7 条 homepage
// 写成了占位符，直到索引体检的地址白名单把它们抓出来（控制台会拿它做可点链接）。
const placeholders = Object.entries(entry).filter(([, value]) => typeof value === 'string' && /^<[^>]*>$/.test(value.trim()));
const FIELD_HINTS = { homepage: '--homepage https://…', minVersion: '--min-version 0.8.5', author: '--author 你的名字' };
for (const [field, value] of placeholders) {
  delete entry[field];
  console.log(`· ${field} 没给值（打包器的模板占位符 ${value} 已丢弃）—— 想填就加 ${FIELD_HINTS[field] || '对应参数'}`);
}
const at = index.plugins.findIndex((item) => item.id === entry.id);
if (at === -1) {
  // 新条目的默认值（只对新增生效）：没给 min-version 就按插件机制首个可用版本 0.8.5；
  // 作者取到了就写，取不到就删掉字段（不编一个名字）
  if (!entry.minVersion) entry.minVersion = '0.8.5';
  if (!entry.author) delete entry.author;
  index.plugins.push(entry);
} else {
  const old = index.plugins[at];
  // 撤回/弃用是**维护动作**，绝不能被一次例行发布悄悄清掉（那等于"下架过的插件又变成可安装"）
  if (old.revoked && !has('clear-revoked')) {
    console.error(`✗ ${entry.id} 当前在撤回名单里（${old.revoked}），这次发布会把它发成可安装的版本。`);
    console.error('  确实要让新版本重新上架：加 --clear-revoked；只是发新版但保持下架：先别发。');
    process.exit(1);
  }
  const base = has('clear-revoked') ? { ...old, revoked: undefined, revokedReason: undefined } : old;
  // 清撤回时把**被撤的版本号**记进 revokedVersions：修好后的新版能装，但还装着旧版的机器继续被挡
  //（索引一个 id 只列一条，不记历史就等于"发新版那一刻旧版的撤回自动解除"）
  if (has('clear-revoked') && old.revoked) {
    const was = String(old.version || '').trim();
    // 同一个版本重新发布（只改了包内容/策略）时**不能**把当前版本记成"已撤回"：
    // 那会让刚解禁的这一版永远加载不起来，且脚本还会打印"可安装"（2026-10-17 审查 P3）
    if (was && canonicalVersion(was) !== canonicalVersion(entry.version)) {
      const keep = new Set([...(Array.isArray(base.revokedVersions) ? base.revokedVersions : []), was]);
      base.revokedVersions = [...keep];
      console.log(`· 旧版本 ${was} 会记进 revokedVersions（继续挡），新版本 ${entry.version} 可安装`);
    } else if (was) {
      console.log(`· 版本号没变（${entry.version}）：解除撤回后这一版直接可安装，不记进 revokedVersions`);
    }
  }
  // 索引里**既有**的占位符（早期版本发布时写进去的）也要清掉：合并会把旧值原样带过来，
  // 只清本次 entry 是漏的（2026-10-16 索引体检的地址白名单就是被这种东西触发的）
  for (const [field, value] of Object.entries(base)) {
    if (typeof value === 'string' && /^<[^>]*>$/.test(value.trim())) {
      if (field === 'revoked' || field === 'signature' || field === 'publisher') continue;   // 不碰信任字段
      delete base[field];
      console.log(`· 旧条目里的 ${field} 是模板占位符（${value}），已清掉`);
    }
  }
  // **合并而不是覆盖**：覆盖会抹掉 revoked/deprecated/mirrors/downloads/publisher/signature
  //（publisher/signature 是签名信任链，丢了等于静默降级成"未验证"）
  const preserved = ['revoked', 'revokedReason', 'deprecated', 'deprecatedReason', 'publisher', 'signature', 'mirrors', 'downloads']
    .filter((field) => base[field] !== undefined && entry[field] === undefined);
  index.plugins[at] = { ...base, ...entry };
  if (preserved.length) console.log(`· 保留了条目里原有的字段：${preserved.join(' / ')}`);
}
// 撤回守卫过了才落盘：中途退出时不留一个没人引用的包文件
fs.writeFileSync(target, packed.buffer);
console.log(`✓ 包已放进索引仓库：plugins/packages/${fileName}`);
index.updatedAt = entry.updatedAt;
fs.writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`);
console.log(`✓ 索引条目已${at === -1 ? '新增' : '更新'}：${entry.id} v${entry.version}（共 ${index.plugins.length} 条，tag ${tag}）`);

// 官方插件：同步宿主仓库的对齐锚（examples/plugins 下现打源码的 sha256 必须与它一致，
// 不更新的后果是主仓库的用例直接变红 —— 而那正是"改了源码忘了重打包"的护栏）
const examplesDir = path.join(repoRoot, 'examples', 'plugins');
const relToExamples = path.relative(examplesDir, sourceDir);
if (relToExamples && !relToExamples.startsWith('..') && !path.isAbsolute(relToExamples)) {
  const anchorPath = path.join(repoRoot, 'plugins', 'official-packages.json');
  try {
    const anchor = JSON.parse(fs.readFileSync(anchorPath, 'utf8'));
    if (!anchor.packages || typeof anchor.packages !== 'object') anchor.packages = {};
    anchor.packages[packed.id] = { version: packed.version, sha256: packed.sha256 };
    anchor.updatedAt = entry.updatedAt;
    fs.writeFileSync(anchorPath, `${JSON.stringify(anchor, null, 2)}\n`);
    console.log('✓ 已同步宿主仓库的对齐锚：plugins/official-packages.json（记得一起提交）');
  } catch (error) {
    console.warn(`· 对齐锚没同步成功（不影响发布，但主仓库用例可能会红）：${error?.message ?? error}`);
  }
}

// ④ 自检（索引仓库自带的那份：结构 + 仓库内产物 + sha256；--remote 才做真下载核对）
//    准备阶段只做离线核对：新包还没传到 Release，远端核对必然失败。
//    --push 在上传资产之后会让它带上真下载核对，作为**硬闸门**。
const verify = () => run(process.execPath, [path.join(indexRepo, 'scripts', 'verify-index.mjs')], { cwd: indexRepo });
const before = run(process.execPath, [path.join(indexRepo, 'scripts', 'verify-index.mjs'), '--no-remote'], { cwd: indexRepo });
const verifyOut = `${before.stdout ?? ''}${before.stderr ?? ''}`.trim().split('\n').slice(-4).join('\n');
if (before.status !== 0) {
  console.log(`⚠ 索引离线自检没通过（先修结构 / 产物 / sha256）\n${verifyOut}`);
} else {
  console.log(`✓ 索引离线自检通过\n${verifyOut}`);
}

// ⑤ 下一步（默认只打印；--push 才动手）
const branch = (run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: indexRepo }).stdout || 'main').trim() || 'main';
const addArgs = ['add', 'plugins/index.json', `plugins/packages/${fileName}`];
const steps = [
  `cd ${indexRepo}`,
  `git ${addArgs.join(' ')}`,
  `git commit -m "plugin: ${entry.id} v${entry.version}"`,
  `gh release upload ${tag} plugins/packages/${fileName}   # 已存在时省略；缺 Release 时：gh release create ${tag} --target main --latest=false`,
  `git push origin ${branch}`,
  'node scripts/verify-index.mjs   # 资产传完后做真下载核对'
];
if (branch !== 'main') {
  steps.push(`# 当前在 ${branch} 分支：推上去后到 GitHub 提 PR；不要在功能分支上推 main（推的是没变的 main，等于白推）`);
}
if (!has('push')) {
  console.log('\n下一步（默认不动远端；加 --push 让我代跑）：');
  for (const step of steps) console.log(`  ${step}`);
  process.exit(0);
}
// 同一天重跑（上次 Release 失败）时内容与已提交的完全一致：git add 什么都不会暂存，
// 再 commit 会以"没有变更"退出 1 —— 原来的 --push 就死在这里，文档里那句"重跑即可"是假的。
const staged = run('git', ['status', '--porcelain', '--', 'plugins/index.json', `plugins/packages/${fileName}`], { cwd: indexRepo });
if (String(staged.stdout || '').trim()) {
  for (const argv of [addArgs, ['commit', '-m', `plugin: ${entry.id} v${entry.version}`]]) {
    const result = run('git', argv, { cwd: indexRepo });
    if (result.status !== 0) {
      console.error(`✗ git ${argv.join(' ')} 失败：${(result.stderr || result.stdout || '').trim()}`);
      process.exit(1);
    }
  }
} else {
  console.log('· 索引与包没有变化（可能是上次已提交），跳过提交，继续传资产/推送');
}
// 资产先于索引对外可见（见文件头）：这一步失败 = 远端什么都没变，重跑就行。
// 所有包共用一个滚动 Release；**已存在的同名资产不覆盖**（覆盖会把下载计数清零，
// 索引里的 sha256 也会和远端对不上——换内容请升版本）。
const releaseExists = run('gh', ['release', 'view', tag], { cwd: indexRepo }).status === 0;
if (!releaseExists) {
  const created = run('gh', ['release', 'create', tag, '--target', 'main',
    '--title', '插件包（滚动）',
    '--notes', '插件包资产（滚动）。CI 会把 plugins/packages/ 里的包同步到这里；索引里的 downloadUrl 固定指向本 Release。不要手动删除。',
    '--latest=false'], { cwd: indexRepo });
  if (created.status !== 0) {
    console.error(`✗ 建滚动 Release 失败：${(created.stderr || created.stdout || '').trim()}`);
    console.error('  索引**没有推送**（本地已提交，修完直接重跑即可）。');
    process.exit(1);
  }
  console.log(`✓ 已建滚动 Release：${tag}`);
}
const assetList = run('gh', ['release', 'view', tag, '--json', 'assets', '--jq', '.assets[].name'], { cwd: indexRepo });
const assetExists = String(assetList.stdout || '').split('\n').map((s) => s.trim()).includes(fileName);
if (assetExists) {
  console.log(`· 资产 ${fileName} 已在 Release 里，跳过上传`);
} else {
  const release = run('gh', ['release', 'upload', tag, `plugins/packages/${fileName}`], { cwd: indexRepo });
  if (release.status !== 0) {
    console.error(`✗ 上传资产失败：${(release.stderr || release.stdout || '').trim()}`);
    console.error('  索引**没有推送**（远端什么都没变；本地已提交，修完直接重跑即可）。');
    process.exit(1);
  }
  console.log(`✓ 资产已上传：${tag}/${fileName}`);
}
const prePush = verify();
if (prePush.status !== 0) {
  console.error(`✗ 推送前的索引自检没通过，**没有推**：\n${`${prePush.stdout ?? ''}${prePush.stderr ?? ''}`.trim().split('\n').slice(-6).join('\n')}`);
  console.error('  修完后重跑即可（已上传的资产会跳过，不会重复上传）。');
  process.exit(1);
}
const push = run('git', ['push', 'origin', branch], { cwd: indexRepo });
if (push.status !== 0) {
  console.error(`✗ git push 失败：${(push.stderr || push.stdout || '').trim()}`);
  console.error(`  索引没推上去，资产已在（${tag}）—— 修完网络/权限后重跑 git push origin ${branch} 即可。`);
  process.exit(1);
}
console.log(`✓ 已提交 + 资产就绪 + 推送索引：${entry.id} v${entry.version}（tag ${tag}）`);
const finalVerify = verify();
if (finalVerify.status !== 0) {
  console.error('✗ 发布后复核没过 —— 索引已经公开了，按上面的报错立刻补一个修复提交（或 git revert HEAD && git push origin main）');
  process.exit(1);
}
console.log('✓ 发布后复核通过');
process.exit(0);
