// 人设页的增强接口（2026-11 人格界面完善）：
//   POST /api/persona/preview            试聊：用"草稿里的"角色卡回一句（不发到 QQ、不写会话、不进记忆）
//   POST /api/persona/generate           AI 起草：给一句设定，按内置卡的分节格式写一张新卡（只返回文本）
//   PUT  /api/persona-templates/custom_N 覆盖保存一张已有的自定义卡（以前只能新建/删除）
//
// 试聊刻意**不复用**正式聊天的系统提示：那份提示词绑着工具、表情库与会话状态，在控制台里
// 模拟不出来；这里只验证"这张卡说话像不像它"，用一份精简的群聊外壳 + 卡正文 + 附加规则。
import { getConfig, updateConfig } from '../core/config.js';
import { chatCompletion } from '../llm/llm.js';
import { normalizeBehaviorProfile } from '../personas.js';

const ROLE_TEXT_MAX = 20000;
const RULES_MAX = 4000;

function clean(value, max) {
  return String(value ?? '').trim().slice(0, max);
}

export function personaPreviewMessages({ roleText, customRules = '', behaviorProfile = 'legacy', botName = '', history = [] }) {
  const shell = [
    `你在 QQ 群里聊天，名字是「${clean(botName, 40) || '机器人'}」。下面是你的【角色设定】，严格按它的口吻、节奏和分寸说话。`,
    '这是管理员在控制台里试聊（不会发到群里），对方的消息就当成群友发给你的。',
    '输出规则：像真人发 QQ 消息——短句、口语、不用 Markdown；想分成几条发就每条单独一行（最多 4 行）。',
    '不要解释你在扮演角色，不要输出旁白或括号里的动作。',
    behaviorProfile === 'grounded'
      ? '交流策略：自然可靠——不装傻、不敷衍，有问必答但简洁。'
      : '交流策略：原版群友——可以随口应付、偶尔装傻，不必有求必应。'
  ].join('\n');
  const msgs = [
    { role: 'system', content: `${shell}\n\n【角色设定】\n${clean(roleText, ROLE_TEXT_MAX)}`
      + (clean(customRules, RULES_MAX) ? `\n\n【管理员附加规则（优先于角色设定）】\n${clean(customRules, RULES_MAX)}` : '') }
  ];
  for (const turn of (Array.isArray(history) ? history : []).slice(-12)) {
    const role = turn?.role === 'assistant' ? 'assistant' : 'user';
    const content = clean(turn?.content, 1000);
    if (content) msgs.push({ role, content });
  }
  return msgs;
}

const GENERATE_SYSTEM = [
  '你是 QQ 群聊机器人的"角色卡"作者。按下面的固定格式写一张中文角色卡（Markdown），给机器人当系统提示用。',
  '格式（小节标题一字不差，用 "## 一、" 这种编号）：',
  '# 角色卡：<名字>（<一句话类型>）',
  '## 一、你是谁 —— 2~4 句身份与性格；明确"你是 AI 不瞒着"；对管理员（提示词里带 [管理员] 标记的人）的态度一句。最后一行用 "> 最高原则：" 写一句。',
  '## 二、说话方式 —— 6~8 条编号规则：句长、口癖、是否分条（send_message 传数组分条）、不用 Markdown、不写括号内心戏。',
  '## 三、你的标志（群里一眼认出你的特征） —— 4~6 条 "- **特征**：说明"。',
  '## 四、AI 味黑名单：出现即失败 —— 5~8 条 "- " 开头的禁用说法/行为（含客服腔、总结升华、Markdown）。',
  '## 五、群聊分寸 —— 4~6 条：被 @ 必回、正事收语气、不刷屏、被问是不是 AI 怎么答。',
  '## 六、你的偏好与日常 —— 3~5 条。',
  '## 七、示例（示例里的空格表示分成两条消息发） —— 3 组，每组格式严格是：',
  '群友：<一句>',
  '你可以：<回复>',
  '你不要：<反面回复>',
  '要求：写具体、可执行，别写空话；不要擦边、不要病娇、不要"主人/老婆"之类称呼；全文 1500~3000 字；只输出卡片正文，不要任何解释。'
].join('\n');

export function registerPersonaRoutes(router, deps = {}) {
  // 显式取别名而不是解构参数：ops scan 的未定义调用扫描器不认识解构参数（见 console/router.js）
  const json = deps.json;
  const readBody = deps.readBody;
  const complete = deps.complete || chatCompletion;
  router.add('POST', '/api/persona/preview', async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    const roleText = clean(body.roleText, ROLE_TEXT_MAX);
    if (!roleText) return json(res, 400, { ok: false, error: '角色设定是空的' });
    const history = Array.isArray(body.history) ? body.history : [];
    if (!history.some((t) => t?.role !== 'assistant' && clean(t?.content, 1000))) {
      return json(res, 400, { ok: false, error: '先输入一句话' });
    }
    let behaviorProfile = 'legacy';
    try { behaviorProfile = normalizeBehaviorProfile(body.behaviorProfile || 'legacy'); } catch { /* 坏值按默认 */ }
    const started = Date.now();
    try {
      const r = await complete({
        messages: personaPreviewMessages({
          roleText,
          customRules: body.customRules,
          behaviorProfile,
          botName: body.botName || getConfig().persona?.botName,
          history
        }),
        temperature: Number(getConfig().api?.temperature ?? 0.8),
        purpose: 'chat'
      });
      const text = String(r?.message?.content || '').trim();
      const lines = text.split(/\n+/).map((s) => s.trim()).filter(Boolean).slice(0, 6);
      return json(res, 200, {
        ok: true,
        reply: lines,
        ms: Date.now() - started,
        usage: r?.usage ? { prompt: r.usage.prompt_tokens || 0, completion: r.usage.completion_tokens || 0 } : null
      });
    } catch (error) {
      return json(res, 502, { ok: false, error: String(error?.message ?? error).slice(0, 300) });
    }
  });

  router.add('POST', '/api/persona/generate', async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    const name = clean(body.name, 40);
    const idea = clean(body.idea, 1200);
    if (!name || !idea) return json(res, 400, { ok: false, error: '名字和一句话设定都要填' });
    const profile = body.behaviorProfile === 'grounded' ? '自然可靠（不装傻、说话有据）' : '原版群友（可以随口应付、偶尔装傻）';
    try {
      const r = await complete({
        messages: [
          { role: 'system', content: GENERATE_SYSTEM },
          { role: 'user', content: `名字：${name}\n设定：${idea}\n交流策略：${profile}\n${clean(body.extra, 600) ? `补充要求：${clean(body.extra, 600)}` : ''}` }
        ],
        temperature: 0.8,
        purpose: 'write'
      });
      let text = String(r?.message?.content || '').trim();
      text = text.replace(/^```(?:markdown|md)?\s*/i, '').replace(/```\s*$/, '').trim();
      if (!/^#\s/.test(text) || !/##\s*一、/.test(text)) {
        return json(res, 502, { ok: false, error: '模型没按格式写出来，换个说法再试一次', raw: text.slice(0, 2000) });
      }
      return json(res, 200, { ok: true, text: text.slice(0, ROLE_TEXT_MAX) });
    } catch (error) {
      return json(res, 502, { ok: false, error: String(error?.message ?? error).slice(0, 300) });
    }
  });

  router.add('PUT', /^\/api\/persona-templates\/custom_(\d+)$/, async (req, res, params) => {
    const idx = Number(params[1]);
    const list = [...(getConfig().customPersonas || [])];
    if (!Number.isInteger(idx) || idx < 0 || idx >= list.length) return json(res, 404, { ok: false, error: '没有这张自定义卡' });
    const body = await readBody(req).catch(() => ({}));
    const name = clean(body.name ?? list[idx].name, 50);
    const text = clean(body.text ?? list[idx].text, ROLE_TEXT_MAX);
    if (!name || !text) return json(res, 400, { ok: false, error: '人设名称和角色设定都不能为空' });
    let behaviorProfile;
    try {
      behaviorProfile = normalizeBehaviorProfile(body.behaviorProfile ?? list[idx].behaviorProfile ?? 'legacy');
    } catch (error) {
      return json(res, 400, { ok: false, error: error.message });
    }
    const entry = { name, text, behaviorProfile };
    const rules = clean(body.customRules ?? list[idx].customRules, RULES_MAX);
    if (rules) entry.customRules = rules;
    list[idx] = entry;
    updateConfig({ customPersonas: list });
    return json(res, 200, { ok: true, id: `custom_${idx}`, template: entry });
  });
}
