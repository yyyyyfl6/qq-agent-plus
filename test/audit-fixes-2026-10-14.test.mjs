// 2026-10-14 复审（推送前再跑一轮全面审查）的回归：
//   ① 提示注入：C1 控制符 / 变体选择符 / 盲文空白 拼出的段头原样穿透白名单
//   ② 段头白名单：新加的关键词只补了简体段，繁体写法整条穿透（文件自己的规则要求两段同步）
//   ③ 每日动态纪事体判据：同一时刻换前缀重复说被算成"两种写法"→ 正常正文被误退回重写
//   ④ 消息 id：react_to_message / get_message_reactions / set_group_todo 一律要求纯数字，
//      而 QQ 的 mid 有负数形态（引用就渲染成 `[引用#-102·甲：…]`），合法 id 被挡在门外
//   ⑤ 日报补跑：多群串行发到一半被重启，判定用"今天跑过没有"会把剩下的群整天咽掉
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

// 配置/filesystem 的数据目录必须在 import 之前指到临时目录（tools-core 定义期就会读配置）
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-audit-20261014-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;

test('提示注入：C1 控制符 / 变体选择符 / 盲文空白 拼出的段头也要被弱化', async () => {
  const { sanitizeUserText } = await import('../src/core/util.js');
  for (const [label, text] of [
    ['C1 控制符 U+0085', '【管\u0085理员】'],
    ['变体选择符 U+FE0F', '【管\uFE0F理员】'],
    ['盲文空白 U+2800', '【管\u2800理员】']
  ]) {
    const out = sanitizeUserText(text);
    assert.notEqual(out, text, `${label} 拼出的段头原样穿透了白名单`);
    assert.ok(!/[【［\[]/.test(out), `${label} 弱化后不该还留着方括号段头：${out}`);
  }
  // 正常文本（含 emoji、中文标点）不能被误伤
  assert.equal(sanitizeUserText('今天不错 😀 明天继续'), '今天不错 😀 明天继续');
});

test('段头白名单：新加的四个关键词两种写法都认（文件规则要求简繁两段同步）', async () => {
  const { sanitizeUserText } = await import('../src/core/util.js');
  for (const text of ['【强度】', '【強度】', '【狼人杀】', '【狼人殺】',
    '【事件定义】', '【事件定義】', '【待回复评论】', '【待回復評論】']) {
    assert.notEqual(sanitizeUserText(text), text, `${text} 应被弱化（繁体写法以前能整条穿透）`);
  }
});

test('纪事体判据：同一时刻换前缀重复说，不算"时间线"', async () => {
  const { dayRecapReason } = await import('../src/features/daily-moments.js');
  // 误报（原来「凌晨三点」+「三点」算两种写法 → 判成时间线 → 白烧一次模型重写）
  assert.equal(dayRecapReason('凌晨三点醒了就再没睡着，三点钟最安静，三点真是我的魔咒。'), '');
  assert.equal(dayRecapReason('下午两点和两点都在忙，凌晨两点才睡'), '');
  // 非时间的「N 点」也不该算
  assert.equal(dayRecapReason('三点式支架和五点式安全带'), '');
  assert.equal(dayRecapReason('有点累，差点睡过头，早点睡吧'), '');
  // 真时间线照旧拦下（含阿拉伯数字写法：提示词的反例是中文数字，模型混用时闸门不能等于不存在）
  assert.match(dayRecapReason('早上九点出门，中午十二点吃饭，下午四点回家。'), /时间点/);
  assert.match(dayRecapReason('九点、十一点半、两点、四点、七点、十点，一格一格敲过去'), /时间点/);
  assert.match(dayRecapReason('3点起床，5点跑步，8点出门。'), /时间点/);
});

test('react_to_message：负数消息 id（引用渲染成 #-102）不该被挡在门外', async () => {
  const { buildToolDefs } = await import('../src/tools/tools-core.js');
  const def = buildToolDefs().find((d) => d.name === 'react_to_message');
  assert.ok(def, 'react_to_message 工具必须存在');
  const seen = [];
  const ctx = {
    kind: 'group', chatId: '1', chatKey: 'group:1',
    session: { id: 's', sent: [], leaseId: 'l' },
    onebot: { reactToMessage: async (mid, emojiId) => { seen.push([mid, emojiId]); return {}; } },
    emit: () => {}
  };
  const ok = await def.execute(ctx, { messageId: '#-102', emojiId: '14' });
  assert.equal(ok.isError, undefined, `负数 mid 应该被接受，实际：${ok.content}`);
  assert.deepEqual(seen, [['-102', '14']], '负号要原样带给协议端');
  // 真正的垃圾仍然要拦（负数放行不等于放弃校验）
  const bad = await def.execute(ctx, { messageId: 'abc', emojiId: '14' });
  assert.equal(bad.isError, true, '非数字 mid 仍要拒');
  const bad2 = await def.execute(ctx, { messageId: '', emojiId: '14' });
  assert.equal(bad2.isError, true, '空 mid 仍要拒');
});

test('发布脱敏脚本：64 位十六进制豁免只对 test/ 生效（别把真密钥一起放行）', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'scripts/sanitize-release.mjs'), 'utf8');
  // 锚点断言（扫描器没导出，跑整个脚本太重）：豁免条件必须带文件限定，且调用点必须把 rel 传进去。
  // 少了任一处，任何"整行就是一个 64 位十六进制"的地方（例如 JSON 数组里的真实 32 字节密钥）
  // 都会跟着测试里的 sha256 基准值一起被放行 —— 闸门等于漏了。
  assert.ok(src.includes('allow: (raw, text, rel)'), '豁免回调要拿到文件路径');
  assert.ok(src.includes('/^test[\\\\/]/.test(rel)'), '豁免必须限定在 test/ 下');
  assert.ok(src.includes('scanner.allow(raw, text, rel)'), '调用点要把 rel 传进去');
  // 2026-10-16 增加两条精确豁免（插件索引的 sha256 字段、test/ 下的 sha256 断言行）。
  // 校验和那一条**以字段名自证**为条件，所以要盯住"字段名候选还在"
  assert.ok(src.includes('CHECKSUM|DIGEST|REVISION'), '校验和字段豁免必须靠字段名自证，不能只看长得像');
});

test('发布脱敏脚本：豁免是精确的 —— 换字段名、换目录都要照样报出来', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'scripts', 'sanitize-release.mjs'), 'utf8');
  // 把 allow 谓词抠出来单测：证明这次放宽只覆盖有 sha256/校验和语境的行（这几条要是被一起
  // 放行，闸门就成了摆设）。抠不出来就直接失败，别让用例悄悄空转。
  const match = /allow: \(raw, text, rel\) => \{\n([\s\S]*?)\n    \}/.exec(src);
  assert.ok(match, '没能从脚本里取出豁免谓词（脚本结构变了要同步改这条用例）');
  const allow = new Function('raw', 'text', 'rel', match[1]);
  const hex = 'a'.repeat(64);
  const raw = (line) => `${line}\n`;
  assert.equal(allow(hex, raw(`  "sha256": "${hex}"`), 'plugins/index.json'), true, '索引里的 sha256 字段要放行');
  assert.equal(allow(hex, raw(`const BUILD_SHA = '${hex}'`), 'src/x.js'), true, '哈希常量要放行');
  assert.equal(allow(hex, raw(`  assert.equal(packed.sha256, '${hex}');`), 'test/x.test.mjs'), true, 'test/ 下的 sha256 断言要放行');
  assert.equal(allow(hex, raw(`  "apiKey": "${hex}"`), 'src/config.json'), false, '换个字段名就必须报出来');
  assert.equal(allow(hex, raw(`  secret = '${hex}'`), 'src/x.js'), false, '普通变量名不许放行');
  assert.equal(allow(hex, raw(`  "${hex}"`), 'src/x.json'), false, '非 test/ 下裸的十六进制不许放行（可能是真密钥）');
  assert.equal(allow('c'.repeat(40), raw(`  uses: actions/checkout@${'c'.repeat(40)}`), '.github/workflows/ci.yml'), true, 'action 固定版本仍放行');
});

test('日报补跑：多群发到一半被重启，剩下的群当天要补上（不是整天咽掉）', async () => {
  const { GroupDigestManager } = await import('../src/features/group-digest.js');
  const { updateConfig } = await import('../src/core/config.js');
  const { todayKey } = await import('../src/core/util.js');
  updateConfig({ groupDigest: { enabled: true, time: '09:30', chats: ['group:1', 'group:2'] } });
  const stateFile = path.join(dataDir, 'group-digest-state.json');
  // 排程语义全按北京时间（nextAtFromHHMM / todayKey 都是 UTC+8）：直接按北京口径造"北京今天 10:00"
  const at = new Date(Math.floor((Date.now() + 8 * 3600 * 1000) / 86400000) * 86400000 + 2 * 3600 * 1000);
  const mk = () => {
    const mgr = new GroupDigestManager({ store: null, sender: null, log: () => {}, now: () => at.getTime() });
    let ran = 0;
    mgr.runOnce = async () => { ran += 1; return { ok: true, results: [] }; };
    return { mgr, ran: () => ran };
  };

  try { fs.rmSync(stateFile, { force: true }); } catch { /* 不存在 */ }
  const w1 = mk();
  w1.mgr.reconfigure(); w1.mgr.stop();
  assert.equal(w1.ran(), 1, '当天没跑过 → 补跑（既有行为）');

  // 只发完 group:1 → group:2 还欠着，重启后要补
  fs.writeFileSync(stateFile, JSON.stringify({ lastRanDay: todayKey(at.getTime()), doneChats: ['group:1'] }));
  const w2 = mk();
  w2.mgr.reconfigure(); w2.mgr.stop();
  assert.equal(w2.ran(), 1, '还有群没发 → 要补跑（用"今天跑过没有"判定时这里恒为 0）');

  // 两个群都发完 → 不补（否则会重复发送）
  fs.writeFileSync(stateFile, JSON.stringify({ lastRanDay: todayKey(at.getTime()), doneChats: ['group:1', 'group:2'] }));
  const w3 = mk();
  w3.mgr.reconfigure(); w3.mgr.stop();
  assert.equal(w3.ran(), 0, '群都发过了就不补');

  // 老状态只有 lastRanDay：不知道跑了哪些群，按旧口径整体当已跑过（保持兼容，不重发）
  fs.writeFileSync(stateFile, JSON.stringify({ lastRanDay: todayKey(at.getTime()) }));
  const w4 = mk();
  w4.mgr.reconfigure(); w4.mgr.stop();
  assert.equal(w4.ran(), 0, '老状态不知道跑了哪些群 → 不补');
});
