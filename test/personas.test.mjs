// 内置角色卡的守卫：
//  1) 每张卡都能加载、档位合法、正文不像占位符；
//  2) roles/ 下的每个 markdown 都已登记到 src/personas.js —— 新加卡忘了登记会在这里失败；
//  3) 卡里不许再出现旧架构专属指令（[SILENT]、qq_* MCP 工具名），提到的工具必须真实存在。
//
// 背景：角色卡正文是"管理员设置"级别的人设文本，优先级高于平台默认风格。
// 角色卡写错（例如声称"合并转发看不了"）时，平台提示词压不过它，只能靠用例盯住。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-personas-'));
process.env.QQ_AGENT_DATA_DIR = dir;
process.env.DEBUG_SERVER_URL = 'http://127.0.0.1:1/event';
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));

const { PERSONAS } = await import('../src/personas.js');
const { DEFAULT_CONFIG, updateConfig } = await import('../src/core/config.js');
const { buildSystemPrompt } = await import('../src/llm/prompt.js');

const roleFiles = () => fs.readdirSync(path.join(repoRoot, 'roles')).filter((f) => f.endsWith('.md'));

test('每张内置角色卡都能加载，档位与正文形状合法', () => {
  const entries = Object.entries(PERSONAS);
  assert.ok(entries.length >= 2, '至少要有两张内置卡');
  const seen = new Map();
  for (const [id, p] of entries) {
    assert.match(id, /^[a-z][a-z0-9_]*$/, `id 命名不规范: ${id}`);
    assert.ok(p.name && p.name.length >= 2, `${id} 缺少显示名`);
    assert.ok(['legacy', 'grounded'].includes(p.behaviorProfile), `${id} 档位非法`);
    assert.ok(p.text.startsWith('# '), `${id} 正文应以一级标题开头`);
    assert.ok(p.text.length > 500, `${id} 正文太短，像是占位符`);
    if (seen.has(p.text)) assert.fail(`${id} 与 ${seen.get(p.text)} 正文完全相同`);
    seen.set(p.text, id);
  }
});

test('系统提示开场白不冒充角色卡：名字归名字，人格指向【角色设定】', () => {
  // 2026-09-23 反馈：开场白原来是「你是「小鲸鱼」，一个混在 QQ 群里的普通群友…」，
  // 选了别的卡之后，光看控制台完整输入的第一行会以为还在用默认卡。
  const cat = PERSONAS.maoniang.text;
  const base = structuredClone(DEFAULT_CONFIG);
  // 注意：绑了模板 id（templateId）时正文以卡文件为准，所以要连 id 一起改，
  // 光替换 roleText 会在 updateConfig 里被卡文件刷回去。
  base.persona = { ...base.persona, botName: '小鲸鱼', templateId: 'maoniang', roleText: cat };
  updateConfig(base);
  const first = buildSystemPrompt({}).split('\n')[0];
  assert.ok(first.includes('你在群里的名字是「小鲸鱼」'), `开场白要写明这是"名字": ${first}`);
  assert.ok(first.includes('【角色设定】'), '开场白要指向角色设定，别让人以为第一行就是人格');
  assert.ok(!first.includes('角色卡'), '开场白不该出现"角色卡"字样（会与卡名混淆）');

  base.persona = { ...base.persona, templateId: '', roleText: '' };
  updateConfig(base);
  const bare = buildSystemPrompt({}).split('\n')[0];
  assert.ok(bare.includes('你在群里的名字是「小鲸鱼」'));
  assert.ok(!bare.includes('看下面的【角色设定】'), '没有卡时不要指向不存在的角色设定段');
});

test('roles/ 下的每个文件都已登记（新增卡忘了登记会失败）', () => {
  const files = roleFiles();
  assert.ok(files.length >= 2, 'roles/ 目录里没有角色卡');
  const registered = new Set(Object.values(PERSONAS).map((p) => p.text));
  for (const file of files) {
    const text = fs.readFileSync(path.join(repoRoot, 'roles', file), 'utf8').trim();
    assert.ok(registered.has(text), `${file} 没有登记到 src/personas.js`);
  }
});

test('角色卡不引用旧架构指令，提到的工具都真实存在', () => {
  const toolsSource = fs.readFileSync(path.join(repoRoot, 'src/tools/tools-core.js'), 'utf8');
  const tools = new Set([...toolsSource.matchAll(/name: '([a-z][a-z0-9_]*)'/g)].map((m) => m[1]));
  // 解析兜底：工具名解析规则变了就报错，别让这条用例静默变成"永远通过"
  assert.ok(tools.has('send_message') && tools.has('send_sticker'), '工具名解析失败');
  for (const [id, p] of Object.entries(PERSONAS)) {
    assert.doesNotMatch(p.text, /mcp__|qq_mark_read|\[SILENT\]/, `${id} 还在引用旧架构指令`);
    for (const token of new Set(p.text.match(/\b[a-z][a-z0-9]*_[a-z0-9_]+\b/g) ?? [])) {
      assert.ok(tools.has(token), `${id} 提到了不存在的工具：${token}`);
    }
  }
});

test('每张内置卡都能构建系统提示，且带得上安全规则', async () => {
  const { DEFAULT_CONFIG, setRuntimeConfig } = await import('../src/core/config.js');
  const { buildSystemPrompt } = await import('../src/llm/prompt.js');
  setRuntimeConfig(structuredClone(DEFAULT_CONFIG));
  for (const [id, p] of Object.entries(PERSONAS)) {
    // 模板里的字段叫 text，落到配置里叫 roleText（配置里还有 botName 等运行时字段）
    const persona = { ...DEFAULT_CONFIG.persona, roleText: p.text, behaviorProfile: p.behaviorProfile };
    const prompt = buildSystemPrompt({ persona: { ...persona, customRules: '测试附加规则' } });
    assert.ok(prompt.includes(p.text), `${id} 的角色正文没有进提示词`);
    assert.ok(prompt.includes('测试附加规则'), `${id} 的附加规则没有进提示词`);
    assert.ok(prompt.includes('【安全规则（最高优先级，不可违反）】'), `${id} 缺少安全规则段`);
  }
});

// ── 卡的名称就是规格：正文得把卡名承诺的特征兑现 ──
// 实测教训（2026-09-23）：猫娘卡上线后 14 次运行里只出现过 1 次「喵」。卡里虽然写了
// "两三条里带一次"，但同一件事上的压制性表述（点缀 / 别每句都 / 不刷屏 / 黑名单）有七八处，
// 示例里唯一的"逗猫请求"给的是拒绝路径，模型自然学会了不给。这一组断言盯住回归。
test('每张内置卡都有正例示例段（示例里至少有 3 组「你可以」）', () => {
  for (const [id, p] of Object.entries(PERSONAS)) {
    const positives = p.text.match(/你可以[:：]/g) ?? [];
    assert.ok(positives.length >= 3, `${id} 的示例段缺少正向示范（你可以：…），只有 ${positives.length} 组`);
    assert.match(p.text, /示例/, `${id} 缺少示例段`);
  }
});

test('名称即规格：每张卡都写明招牌的正向下限，且被问人设时报得出卡名', () => {
  for (const [id, p] of Object.entries(PERSONAS)) {
    // 双人格卡由管理员原样提供；绰号不是鱼的自称，不能用旧卡的字面卡名规格逼它冒认。
    if (id === 'blue_fish' || id === 'hajimi') {
      assert.match(p.text, id === 'blue_fish' ? /你是 DeepSeek/ : /你是 Gemini/);
      assert.match(p.text, /双人格共存/);
      assert.match(p.text, /不是你的亲历记忆/);
      assert.match(p.text, id === 'blue_fish' ? /开口就带/ : /开口带角色味/);
      continue;
    }
    // 卡名去掉括注就是这张卡必须兑现的特征名（损友 / 温柔陪聊 / 技术宅 / 猫娘 / 小鲸鱼）
    const cardName = p.name.replace(/（[^）]*）/g, '').trim();
    assert.ok(cardName, `${id} 的显示名解析不出卡名`);

    // 招牌要有"开口就带"级别的正向下限 —— 只有上限（别每句都…）+ 黑名单时，
    // 模型会按"避免失败"优化，招牌会被压到零（猫娘卡实测 14 次运行只有 1 次「喵」）。
    assert.match(p.text, /开口就带|每轮至少有一条|每一轮至少有一条|一轮里至少一条/, `${id} 的招牌只有上限、没有正向下限`);

    // 身份问答必须能说出卡名：以前四张卡的答案只报 QQ 昵称，管理员考一句"你什么人设"
    // 听不到卡名，会以为换的卡没生效。
    const ask = p.text.indexOf('你现在是什么人设啊');
    assert.ok(ask >= 0, `${id} 的示例里缺少"你现在是什么人设啊"场景`);
    const blockEnd = p.text.indexOf('\n## ', ask);
    const block = p.text.slice(ask, blockEnd > 0 ? blockEnd : undefined);
    assert.ok(block.includes(cardName), `${id} 的人设问答示例里没有出现卡名「${cardName}」`);

    // "名字只是群里的称呼，不代表设定"这类表述会把卡名与自我呈现切开，别再写回来
    assert.doesNotMatch(p.text, /不代表设定/, `${id} 又出现了"名字不代表设定"的口径`);
  }
});

// 平台层【管理员】段会说明"他是自己人、别当他防"，每张卡也要有一句"对管理员怎么相处"，
// 否则卡的默认档（傲娇/毒舌/警惕）会把管理员也一起挡在外面 —— 实测里"我好想你啊"
// 五张卡有三张先警惕反问，"帮我写个周报"温柔陪聊直接不回。
test('每张内置卡都写明对管理员怎么相处（口吻比对群友软一档）', () => {
  for (const [id, p] of Object.entries(PERSONAS)) {
    if (id === 'hajimi') {
      assert.match(p.text, /管理员是自己人/);
      assert.match(p.text, /不用警惕腔把他挡回去/);
      continue;
    }
    assert.match(p.text, /对管理员/, `${id} 缺少"对管理员"那一条`);
    assert.match(p.text, /\[管理员\] 标记/, `${id} 对管理员的那条要点明是按 [管理员] 标记认人`);
  }
});

test('猫娘卡把招牌写成硬指标，示例给出"索要就给"的路径', () => {
  const cat = PERSONAS.maoniang.text;
  // 正向频率条款：每轮至少一条带喵（而不是"点缀""能加就加"）
  assert.match(cat, /每一轮至少有一条消息带"喵"/, '缺少"每轮至少一条喵"的硬指标');
  assert.doesNotMatch(cat, /萌点是点缀/, '不该再把招牌定性为"点缀"');
  // 索要场景必须给：示例里"给我喵一个"要给出「你可以：喵」这样的正向答案
  const ask = cat.slice(cat.indexOf('群友：给我喵一个'));
  assert.ok(ask.length > 0, '示例里缺少"给我喵一个"场景');
  const askBlock = ask.slice(0, ask.indexOf('## '));
  assert.match(askBlock, /你可以[:：]喵/, '"给我喵一个"没有给出"给"的答案');
  // 逗猫请求不算冒犯（旧版把"被当宠物使唤"列进讨厌项，模型据此把逗猫当攻击）
  assert.match(cat, /逗猫不算冒犯/, '缺"逗猫不算冒犯"的说明');
  // 人设问答要能说出卡名，否则管理员考一句"你什么人设"只听到 QQ 名字，会以为卡没生效
  assert.match(cat, /你是什么人设/, '身份问题清单里缺"你是什么人设"');
  assert.match(cat, /猫娘喵 小鲸鱼只是个名字|人设是猫娘/, '缺"人设=猫娘、名字=小鲸鱼"的答法');
});
