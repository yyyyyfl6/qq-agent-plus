// 协议端能力升级（2026-10-07，SnowLuma 1.14.22）的回归用例：
// 私聊输入状态 / 表情回应（发·收）/ 资料与备注 / 群资料·签到·待办 / QQ 语音 / OCR /
// 语音转写快路径 / 系统表情目录在线合并。
import assert from 'node:assert/strict';
import { it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-platform-upgrade-'));
process.env.QQ_AGENT_DATA_DIR = dir;
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
// 离线表情表：face-catalog 的离线来源（在线目录在测试里用桩件补）
fs.writeFileSync(path.join(dir, 'face-names.json'), JSON.stringify({ bySid: { 14: '微笑', 179: '抠鼻', 128077: '强' } }));

const { ChatStore } = await import('../src/core/store.js');
const { SendQueue } = await import('../src/onebot/sender.js');
const { OneBotClient } = await import('../src/onebot/onebot.js');
const { buildToolDefs, resetPlatformQuotasForTest } = await import('../src/tools/tools-core.js');
const { faceNameOf, faceIdByName, refreshFaceCatalog, resetFaceCatalogForTest } = await import('../src/onebot/face-catalog.js');
const { transcribeMessageAudio } = await import('../src/tools/audio-transcribe.js');
const { DEFAULT_CONFIG, setRuntimeConfig } = await import('../src/core/config.js');

const cfg = structuredClone(DEFAULT_CONFIG);
cfg.runtime.mode = 'active';
cfg.allow.groups = ['1'];
cfg.allow.private = ['2'];
setRuntimeConfig(cfg);

const tool = (name) => {
  const def = buildToolDefs().find((d) => d.name === name);
  assert.ok(def, `工具 ${name} 应存在`);
  return def;
};
const parse = (r) => JSON.parse(r.content);
// 额度用例验的是"闸门机制"，不验具体数字：把额度显式写进配置再跑（默认值以后还会调 ——
// 2026-10-07 就从 30/3/5/2 收紧成了 15/2/3/1，写死默认值的断言会跟着红）。
const withQuotas = (quotas) => {
  setRuntimeConfig({ ...cfg, platform: { ...cfg.platform, quotas: { ...cfg.platform.quotas, ...quotas } } });
};
const restoreConfig = () => setRuntimeConfig(cfg);

it('工具表：平台能力工具都在（防改名/误删）', () => {
  const names = new Set(buildToolDefs().map((d) => d.name));
  for (const expected of ['react_to_message', 'get_message_reactions', 'set_my_signature', 'set_my_status',
    'get_group_profile', 'group_sign', 'set_group_todo', 'read_image_text', 'send_qq_voice', 'set_remark']) {
    assert.ok(names.has(expected), `缺工具 ${expected}`);
  }
});

it('私聊发送前亮「正在输入」，群聊不亮；typingIndicator=false 时不亮', async () => {
  const store = new ChatStore(0, { dataDir: dir });
  const calls = [];
  const onebot = {
    selfId: '9',
    call: async () => ({}),
    sendText: async () => ({ message_id: 1 }),
    setInputStatus: async (kind, id, typing) => { calls.push([kind, id, typing]); return {}; }
  };
  const sender = new SendQueue({ store, onebot });
  await sender.sendTextBatch('private:2', ['你好']);
  assert.deepEqual(calls.at(-1), ['private', '2', true], '私聊要先亮输入状态');

  const before = calls.length;
  await sender.sendTextBatch('group:1', ['大家好']);
  assert.equal(calls.length, before, '群聊没有输入状态，不该调用');

  const off = structuredClone(cfg);
  off.send.typingIndicator = false;
  setRuntimeConfig(off);
  try {
    await sender.sendTextBatch('private:2', ['再试一次']);
    assert.equal(calls.length, before, '开关关掉后不再亮输入状态');
  } finally {
    setRuntimeConfig(cfg);
  }
});

it('OneBotClient：输入状态只对私聊、表情回应动作形状正确', async () => {
  const bot = new OneBotClient({ wsUrl: 'ws://127.0.0.1:1', httpUrl: 'http://127.0.0.1:1' });
  const calls = [];
  bot.call = async (action, params) => { calls.push([action, params]); return {}; };

  assert.equal(await bot.setInputStatus('group', 1, true), null, '群聊输入状态直接 no-op');
  assert.equal(calls.length, 0);
  await bot.setInputStatus('private', 2, true);
  assert.deepEqual(calls.at(-1), ['set_input_status', { user_id: 2, event_type: 1 }]);
  await bot.setInputStatus('private', 2, false);
  assert.deepEqual(calls.at(-1), ['set_input_status', { user_id: 2, event_type: 0 }]);
  await bot.reactToMessage(123, 14);
  assert.deepEqual(calls.at(-1), ['set_msg_emoji_like', { message_id: 123, emoji_id: '14', set: true }]);
});

it('react_to_message：参数归一化、非数字编号被拒、每小时封顶', async () => {
  resetPlatformQuotasForTest();
  const calls = [];
  const ctx = {
    kind: 'group', chatId: '1', chatKey: 'group:1',
    session: { id: 's', sent: [], leaseId: 'l' },
    // 工具经由 OneBotClient.reactToMessage 发出（wire 形状只留一处）：这里只验工具传了什么
    onebot: { call: async (action, params) => { calls.push([action, params]); return {}; },
      reactToMessage: async (...args) => { calls.push(['reactToMessage', args]); return {}; } },
    emit: () => {}
  };
  const def = tool('react_to_message');
  const res = parse(await def.execute(ctx, { messageId: '#123', emojiId: '14' }));
  assert.equal(res.reacted, true);
  assert.deepEqual(calls.at(-1), ['reactToMessage', ['123', '14', true, undefined]],
    '归一化后的 mid、编号、set 与 signal 要原样传给客户端方法');

  const bad = await def.execute(ctx, { messageId: '123', emojiId: '微笑' });
  assert.equal(bad.isError, true, '编号必须是数字');

  // 实测（SnowLuma 1.14.22）：QQ 私聊消息不支持表情回应 → 工具层直接说清楚
  const priv = await def.execute({ kind: 'private', chatId: '2', chatKey: 'private:2' }, { messageId: '123', emojiId: '14' });
  assert.equal(priv.isError, true);
  assert.match(priv.content, /群聊/, '私聊要给出可执行的说明');

  for (let i = 0; i < 40; i += 1) await def.execute(ctx, { messageId: '123', emojiId: '14' });
  const rejected = await def.execute(ctx, { messageId: '123', emojiId: '14' });
  assert.match(rejected.content, /够多了/, '每小时封顶');
  resetPlatformQuotasForTest();
});

it('get_message_reactions：表情取名 + 贴的人解析成群昵称', async () => {
  const ctx = {
    kind: 'group', chatId: '1', chatKey: 'group:1',
    store: { recent: () => [{ senderId: '2002', senderName: '乙' }] },
    onebot: {
      call: async () => ([
        { emoji_id: '14', count: 2, users: [{ user_id: 2002 }, { user_id: 3003 }] }
      ])
    }
  };
  const res = parse(await tool('get_message_reactions').execute(ctx, { messageId: '5' }));
  assert.equal(res.reactions[0].name, '微笑');
  assert.equal(res.reactions[0].users[0].name, '乙');
  assert.equal(res.reactions[0].users[1].name, '3003', '查不到名字就用号码');
});

it('资料类：签名/状态/备注按配置的上限封顶，参数形状正确', async (t) => {
  resetPlatformQuotasForTest();
  withQuotas({ profilePerDay: 3, remarksPerDay: 5 });   // 这条用例要连发三次资料 + 两次备注
  t.after(restoreConfig);
  const calls = [];
  const ctx = {
    kind: 'group', chatId: '433', chatKey: 'group:433',
    onebot: { call: async (action, params) => { calls.push([action, params]); return {}; } }
  };
  await tool('set_my_signature').execute(ctx, { signature: '摸鱼中' });
  assert.deepEqual(calls.at(-1), ['set_self_longnick', { long_nick: '摸鱼中' }]);
  await tool('set_my_status').execute(ctx, { wording: '睡觉中' });
  assert.deepEqual(calls.at(-1), ['set_diy_online_status', { face_id: 0, face_type: 1, wording: '睡觉中' }]);
  const third = await tool('set_my_signature').execute(ctx, { signature: '再来一句' });
  assert.equal(third.isError, undefined, '第三次仍在额度内');
  const fourth = await tool('set_my_signature').execute(ctx, { signature: '第四次' });
  assert.match(fourth.content, /用完了/, '签名/状态共享每日封顶');

  const remark = await tool('set_remark').execute(ctx, { remark: '龙王甲' });
  assert.equal(remark.isError, undefined);
  assert.deepEqual(calls.at(-1), ['set_group_remark', { group_id: 433, remark: '龙王甲' }]);
  await tool('set_remark').execute(ctx, { remark: '小博美', userId: '2002' });
  assert.deepEqual(calls.at(-1), ['set_friend_remark', { user_id: 2002, remark: '小博美' }]);
  resetPlatformQuotasForTest();
});

it('set_my_avatar：消息图 / 表情库图两种图源，按配置的上限封顶（窗口按周）', async (t) => {
  resetPlatformQuotasForTest();
  withQuotas({ avatarsPerWeek: 2 });   // 这条用例要连发两次，额度显式给 2
  t.after(restoreConfig);
  const avatars = [];
  const ctx = {
    kind: 'group', chatId: '433', chatKey: 'group:433',
    session: { id: 's', sent: [] },
    store: { findByMid: () => ({ mid: '9', media: [{ kind: 'image', url: 'https://example.com/pic.png' }] }) },
    // 本地托管的图走 base64（与 send_sticker 同一口径，不发外网探活）
    stickers: { findForSend: async () => ({ id: 'st1', url: 'base64://aGVsbG8=', localFile: 'f.png' }) },
    onebot: { setAvatar: async (file) => { avatars.push(file); return {}; } }
  };
  const res = parse(await tool('set_my_avatar').execute(ctx, { messageId: '#9' }));
  assert.equal(res.changed, true);
  assert.equal(avatars.at(-1), 'https://example.com/pic.png', '消息里的图直接用');

  await tool('set_my_avatar').execute(ctx, { stickerId: 'st1' });
  assert.equal(avatars.at(-1), 'base64://aGVsbG8=', '表情库的图（本地托管）按 base64 交出去');

  assert.equal((await tool('set_my_avatar').execute(ctx, {})).isError, true, '不给图源要报错');
  const third = await tool('set_my_avatar').execute(ctx, { messageId: '9' });
  assert.match(third.content, /用完了/, '换头像按窗口上限封顶');
  assert.match(third.content, /每周最多 2 次/, '报错里带的是配置里的上限，不是写死的数字');
  resetPlatformQuotasForTest();
});

// ── 2026-10-07 独立审计：四个"既不走队列也没有配额"的写动作补闸 ──

it('group_sign：每个群每天只真签一次（重复调用直接回"今天签过了"，不再打协议端）', async (t) => {
  resetPlatformQuotasForTest();
  t.after(() => resetPlatformQuotasForTest());
  const calls = [];
  const ctx = {
    kind: 'group', chatId: '433', chatKey: 'group:433',
    onebot: { call: async (action, params) => { calls.push([action, params]); return {}; } }
  };
  const first = JSON.parse((await tool('group_sign').execute(ctx, {})).content);
  assert.equal(first.signed, true, '第一次真签');
  assert.equal(calls.length, 1);
  const second = JSON.parse((await tool('group_sign').execute(ctx, {})).content);
  assert.equal(second.signed, false, '同一天第二次不再真签');
  assert.match(second.note, /已经签过/, '要明确告诉模型"今天签过了"，别让它以为失败');
  assert.equal(calls.length, 1, '第二次不该再打协议端');
  // 另一个群互不影响（去重按会话）
  await tool('group_sign').execute({ ...ctx, chatId: '999', chatKey: 'group:999' }, {});
  assert.equal(calls.length, 2, '换群照常能签');
});

it('set_group_todo：同一条消息只设一次；每群每天有上限（防一轮里连设不同消息）', async (t) => {
  resetPlatformQuotasForTest();
  t.after(() => resetPlatformQuotasForTest());
  const calls = [];
  const ctx = {
    kind: 'group', chatId: '433', chatKey: 'group:433',
    onebot: { call: async (action, params) => { calls.push([action, params]); return {}; } }
  };
  const one = JSON.parse((await tool('set_group_todo').execute(ctx, { messageId: '#11' })).content);
  assert.equal(one.todo, true);
  const again = JSON.parse((await tool('set_group_todo').execute(ctx, { messageId: '11' })).content);
  assert.equal(again.todo, false, '同一条消息（带不带 # 都算同一条）不再重复设');
  assert.equal(calls.length, 1, '重复的这次不该打协议端');
  await tool('set_group_todo').execute(ctx, { messageId: '12' });
  await tool('set_group_todo').execute(ctx, { messageId: '13' });
  const fourth = await tool('set_group_todo').execute(ctx, { messageId: '14' });
  assert.equal(fourth.isError, true, '每群每天第 4 条要被拦');
  assert.match(fourth.content, /已经设了 3 条/, '要说清上限');
  assert.equal(calls.length, 3, '被拦的那次不该打协议端');
  // 别的群有自己的额度
  await tool('set_group_todo').execute({ ...ctx, chatId: '999', chatKey: 'group:999' }, { messageId: '14' });
  assert.equal(calls.length, 4, '换群不受另一个群的额度影响');
});

it('相册点赞/评论：共用每小时闸门（事前消费、失败退还、按配置值封顶）', async (t) => {
  resetPlatformQuotasForTest();
  withQuotas({ albumWritesPerHour: 2 });
  t.after(() => { restoreConfig(); resetPlatformQuotasForTest(); });
  const calls = [];
  let failNext = false;
  const ctx = {
    kind: 'group', chatId: '433', chatKey: 'group:433',
    onebot: {
      call: async (action, params) => {
        if (failNext) { failNext = false; throw new Error('协议端炸了'); }
        calls.push([action, params]);
        return {};
      }
    }
  };
  const like = (n) => tool('like_album_photo').execute(ctx, { albumId: 'a1', batchId: `b${n}` });
  assert.equal(JSON.parse((await like(1)).content).liked, true);
  assert.equal(JSON.parse((await like(2)).content).liked, true, '第 2 次仍在上限内（点赞与评论共享这一份额度）');
  const third = await like(3);
  assert.equal(third.isError, true, '到配置的上限就该拦');
  assert.match(third.content, /上限 2 次/, '报错里要带配置的上限');
  resetPlatformQuotasForTest();
  // 失败不扣额度：先让协议端抛一次，额度应退回去，下次还能成功
  failNext = true;
  const failed = await like(4);
  assert.equal(failed.isError, true, '协议端失败要如实报错');
  const retry = await like(5);
  assert.equal(JSON.parse(retry.content).liked, true, '失败的那次要把额度退回来（否则模型白白损失一次）');
  // 评论与点赞共用同一个闸门：把额度用满后评论也进不去
  const c1 = await tool('comment_album_photo').execute(ctx, { albumId: 'a1', lloc: 'x', content: '好' });
  assert.equal(c1.isError, undefined, '额度还没满时评论能发（与点赞共享同一份）');
  const c2 = await tool('comment_album_photo').execute(ctx, { albumId: 'a1', lloc: 'y', content: '再来' });
  assert.equal(c2.isError, true, '额度被点赞 + 上一条评论用满后，评论也要被拦');
  resetPlatformQuotasForTest();
});

it('set_my_profile：至少给一项、性别有校验、改昵称后刷新登录信息、与资料共享每日额度', async (t) => {
  withQuotas({ profilePerDay: 3 });   // 这条用例要连发几次资料改动（默认已收紧到 1/天）
  t.after(restoreConfig);
  resetPlatformQuotasForTest();
  const profiled = [];
  let refreshes = 0;
  const ctx = {
    kind: 'group', chatId: '433', chatKey: 'group:433',
    onebot: {
      setProfile: async (payload) => { profiled.push(payload); return {}; },
      refreshSelfInfo: async () => { refreshes += 1; }
    }
  };
  const res = parse(await tool('set_my_profile').execute(ctx, { nickname: '犊子二号' }));
  assert.equal(res.nickname, '犊子二号');
  assert.deepEqual(profiled.at(-1), { nickname: '犊子二号', personalNote: undefined, sex: undefined });
  assert.equal(refreshes, 1, '改昵称后必须刷新登录信息（@我 判定、提示词里的名字都读它）');

  await tool('set_my_profile').execute(ctx, { nickname: '犊子', sex: '2', personalNote: '  摸鱼中  ' });
  assert.deepEqual(profiled.at(-1), { nickname: '犊子', personalNote: '摸鱼中', sex: 2 }, '只带传进来的字段，且要清洗');
  assert.equal(refreshes, 2);

  assert.equal((await tool('set_my_profile').execute(ctx, { sex: '9' })).isError, true, '性别只有 0/1/2');
  assert.equal((await tool('set_my_profile').execute(ctx, {})).isError, true, '至少要给一项');
  assert.equal(profiled.length, 2, '校验失败不该真的调协议端');

  await tool('set_my_profile').execute(ctx, { personalNote: '继续摸鱼' });
  const fourth = await tool('set_my_profile').execute(ctx, { nickname: '再改一次' });
  assert.match(fourth.content, /用完了/, '与签名/在线状态共享每日 3 次的额度');
  resetPlatformQuotasForTest();
});

it('get_group_profile：群聊聚合三类资料；私聊拒绝', async () => {
  const ctx = {
    kind: 'group', chatId: '433', chatKey: 'group:433',
    onebot: {
      call: async (action) => {
        if (action === 'get_group_detail_info') {
          return { group_name: '测试群', group_remark: '小群', group_desc: '闲聊为主', member_count: 10 };
        }
        if (action === '_get_group_notice') return [{ publish_time: 1, message: { text: '周三维护' } }];
        if (action === 'get_group_honor_info') return { talkative: { users: [{ nickname: '龙王甲' }] } };
        return {};
      }
    }
  };
  const res = parse(await tool('get_group_profile').execute(ctx, {}));
  assert.equal(res.detail.name, '测试群');
  assert.equal(res.notices[0].text, '周三维护');
  assert.ok(res.honors.talkative);

  const priv = await tool('get_group_profile').execute({ kind: 'private', chatId: '2', chatKey: 'private:2' }, {});
  assert.equal(priv.isError, true, '私聊没有群资料');
});

it('群签到 / 群待办：只进群、参数正确', async () => {
  const calls = [];
  const ctx = {
    kind: 'group', chatId: '433', chatKey: 'group:433',
    onebot: { call: async (action, params) => { calls.push([action, params]); return {}; } }
  };
  await tool('group_sign').execute(ctx, {});
  assert.deepEqual(calls.at(-1), ['set_group_sign', { group_id: 433 }]);
  await tool('set_group_todo').execute(ctx, { messageId: '#77' });
  assert.deepEqual(calls.at(-1), ['set_group_todo', { group_id: 433, message_id: 77 }]);

  const priv = await tool('group_sign').execute({ kind: 'private', chatId: '2', chatKey: 'private:2' }, {});
  assert.equal(priv.isError, true);
});

it('send_qq_voice：先取角色列表，再带 character 发送（发送走队列）；控制台固定音色后直接用', async () => {
  const calls = [];
  const voiceCalls = [];
  const ctx = {
    kind: 'group', chatId: '433', chatKey: 'group:433',
    session: { id: 's', sent: [], leaseId: 'l1' },
    onebot: {
      // 目录解析（分类展平/去重）在 OneBotClient.getAiCharacters 里，这里只验工具怎么用
      getAiCharacters: async (groupId) => {
        calls.push(['get_ai_characters', { group_id: Number(groupId) }]);
        return [{ characterId: 'c1', name: '小新', category: '热门' }];
      }
    },
    // 发送这一步走发送队列（限频/禁言/outbox，2026-10-07 复审 P2）：工具与队列的
    // 交接在这里验，队列→协议端的真实 wire 形状在 platform-simulated-group 里验。
    sender: { aiVoice: async (chatKey, payload, options) => { voiceCalls.push({ chatKey, payload, options }); return { message_id: 1 }; } },
    emit: () => {}
  };
  const list = parse(await tool('send_qq_voice').execute(ctx, { text: '大家好呀' }));
  assert.deepEqual(list.characters, [{ characterId: 'c1', name: '小新', category: '热门' }]);
  assert.deepEqual(calls.at(-1), ['get_ai_characters', { group_id: 433 }]);
  const sent = parse(await tool('send_qq_voice').execute(ctx, { text: '大家好呀', character: 'c1' }));
  assert.equal(sent.sent, true);
  assert.deepEqual(voiceCalls.at(-1), {
    chatKey: 'group:433',
    payload: { character: 'c1', text: '大家好呀' },
    options: { runId: 'l1', signal: undefined }
  }, '发送要交给 sender.aiVoice，并带上本轮租约');

  // 控制台「平台能力」页固定了音色 → 不再拉目录、也不用模型挑；模型硬传的 character 不算数
  const pinned = structuredClone(cfg);
  pinned.platform = { ...pinned.platform, qqVoiceCharacter: 'lucy-voice-houge' };
  setRuntimeConfig(pinned);
  try {
    const before = calls.length;
    const auto = parse(await tool('send_qq_voice').execute(ctx, { text: '俺老孙来也', character: 'c1' }));
    assert.equal(auto.sent, true);
    assert.equal(auto.character, 'lucy-voice-houge', '固定音色要以控制台为准');
    assert.equal(calls.length, before, '固定音色后不该再拉角色目录');
    assert.deepEqual(voiceCalls.at(-1).payload, { character: 'lucy-voice-houge', text: '俺老孙来也' });
  } finally {
    setRuntimeConfig(cfg);
  }

  const priv = await tool('send_qq_voice').execute({ kind: 'private', chatId: '2', chatKey: 'private:2' }, { text: '喂' });
  assert.equal(priv.isError, true, 'QQ 语音只有群聊');
});

it('read_image_text：用消息里的图片调 OCR 并合并文本', async () => {
  const calls = [];
  const ctx = {
    kind: 'group', chatId: '1', chatKey: 'group:1',
    store: {
      findByMid: () => ({ mid: '5', media: [{ kind: 'image', file: 'abc.png', url: 'https://example.com/a.png' }] })
    },
    onebot: { call: async (action, params) => { calls.push([action, params]); return { texts: [{ text: '第一行' }, { text: '第二行' }] }; } }
  };
  const res = parse(await tool('read_image_text').execute(ctx, { messageId: '5' }));
  assert.equal(res.text, '第一行\n第二行');
  assert.deepEqual(calls[0], ['ocr_image', { image: 'https://example.com/a.png' }], '优先用新鲜 URL');
});

it('语音转写：QQ 自带转写直接命中，不走外部识别', async () => {
  const calls = [];
  const ctx = {
    chatKey: 'group:1',
    onebot: { call: async (action, params) => { calls.push([action, params]); return { text: '晚上八点开会' }; } }
  };
  const entry = { mid: 5, media: [{ kind: 'audio', url: 'https://example.com/a.amr', name: 'a.amr' }] };
  const res = await transcribeMessageAudio(ctx, entry);
  assert.equal(res.ok, true);
  assert.equal(res.text, '晚上八点开会');
  assert.deepEqual(calls[0], ['fetch_ptt_text', { message_id: 5 }]);
});

it('语音转写：QQ 没有转写时落回老链路（未配置 ASR 时明确报未配置）', async () => {
  const ctx = { chatKey: 'group:1', onebot: { call: async () => ({ text: '' }) } };
  const entry = { mid: 6, media: [{ kind: 'audio', url: 'https://example.com/a.amr', name: 'a.amr' }] };
  const res = await transcribeMessageAudio(ctx, entry);
  assert.equal(res.ok, false);
  assert.match(res.error, /语音识别还没配好/, '快路径失败后必须继续走原来的报错口径');
});

it('表情目录：离线表可用；在线目录只补缺、每进程只拉一次', async () => {
  resetFaceCatalogForTest();
  assert.equal(faceNameOf(14), '微笑');
  assert.equal(faceIdByName('微笑'), '14');
  let pulls = 0;
  const client = {
    call: async () => {
      pulls += 1;
      return { packs: [{ emojis: [{ q_sid: '128514', q_des: '大哭' }, { q_sid: '14', q_des: '改过的名字' }] }] };
    }
  };
  assert.equal(await refreshFaceCatalog(client), true, '补到了新表情');
  assert.equal(faceNameOf(128514), '大哭');
  assert.equal(faceNameOf(14), '微笑', '已有编号的名字不被在线目录改写');
  await refreshFaceCatalog(client);
  assert.equal(pulls, 1, '每进程只拉一次');
  resetFaceCatalogForTest();
});

it('表情回应通知：贴别人的消息只记录；贴机器人的消息才唤醒', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-platform-notice-'));
  fs.writeFileSync(path.join(root, 'face-names.json'), JSON.stringify({ bySid: { 14: '微笑' } }));
  const prevDir = process.env.QQ_AGENT_DATA_DIR;
  process.env.QQ_AGENT_DATA_DIR = root;

  const { createApp } = await import('../src/console/app.js');
  const appCfg = structuredClone(DEFAULT_CONFIG);
  appCfg.runtime.mode = 'active';
  appCfg.allow.groups = ['1'];
  appCfg.sticker.enabled = false;
  appCfg.wakeDelayMs = 100;
  appCfg.wakeDelayMinMs = 100;
  appCfg.wakeDelayMaxMs = 100;
  setRuntimeConfig(appCfg);
  const app = createApp({ log: () => {} });
  app.onebot.selfInfo = { user_id: 888, nickname: 'bot' };
  app.onebot.getGroupMemberInfo = async () => ({ nickname: '小明' });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ choices: [{ message: { content: 'Done' } }], usage: {} });
  t.after(async () => {
    await app.stop();
    globalThis.fetch = originalFetch;
    process.env.QQ_AGENT_DATA_DIR = prevDir;
    fs.rmSync(root, { recursive: true, force: true });
  });

  const recentTexts = () => app.store.recent('group:1', { limit: 20 }).map((m) => m.text);

  // ① 贴的是别人的消息 → 只记录（不进 pending、不唤醒）
  const unreadBefore = app.store.unreadCount('group:1');
  await app.onebot.onEvent({
    post_type: 'notice', notice_type: 'group_msg_emoji_like', sub_type: 'add',
    group_id: 1, user_id: 42, message_id: 9001, likes: [{ emoji_id: '14', count: 1 }],
    time: Math.floor(Date.now() / 1000)
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(recentTexts().some((t) => t.includes('[贴表情]') && t.includes('微笑')), '要落一条 [贴表情] 记录');
  assert.equal(app.store.unreadCount('group:1'), unreadBefore, '贴别人的消息不该叫醒它');

  // ② 贴的是机器人自己发的消息 → pending（可以唤醒它回应）
  app.store.appendSelf('group:1', { text: '我说的', mid: 9002, ts: Date.now(), eventKind: 'message' });
  await app.onebot.onEvent({
    post_type: 'notice', notice_type: 'group_msg_emoji_like', sub_type: 'add',
    group_id: 1, user_id: 42, message_id: 9002, likes: [{ emoji_id: '14', count: 1 }],
    time: Math.floor(Date.now() / 1000)
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(recentTexts().some((t) => t.includes('贴的是你说的那条')), '贴自己的要标明');
  assert.ok(app.store.unreadCount('group:1') > unreadBefore, '贴自己的消息要进未读（唤醒一轮）');

  // ③ 自己贴的（operator = 机器人自己）不记录
  const countBefore = recentTexts().length;
  await app.onebot.onEvent({
    post_type: 'notice', notice_type: 'group_msg_emoji_like', sub_type: 'add',
    group_id: 1, user_id: 888, message_id: 9002, likes: [{ emoji_id: '14', count: 1 }],
    time: Math.floor(Date.now() / 1000)
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(recentTexts().length, countBefore, '自己贴的不该再记一条');

  // ④ 撤回表情（sub_type=remove）：落记录，但**不**当唤醒源 —— 撤回不是对发言的反馈
  // （2026-10-07 复审 P3：原来 remove 也会唤醒一轮）。
  const unreadBeforeRemove = app.store.unreadCount('group:1');
  await app.onebot.onEvent({
    post_type: 'notice', notice_type: 'group_msg_emoji_like', sub_type: 'remove',
    group_id: 1, user_id: 42, message_id: 9002, likes: [{ emoji_id: '14', count: 1 }],
    time: Math.floor(Date.now() / 1000)
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(recentTexts().some((t) => t.includes('撤回了表情回应')), '撤回要落记录（进下次运行的上下文）');
  assert.equal(app.store.unreadCount('group:1'), unreadBeforeRemove, '撤回不该叫醒它');
});
