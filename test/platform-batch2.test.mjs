// 协议端能力第二批（2026-10-07，SnowLuma 1.14.22）的回归用例：
// 合并转发卡片 / 群文件 / 群相册 / 陌生人信息 / 英译中，以及平台能力开关的工具门控。
import assert from 'node:assert/strict';
import { it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-platform-batch2-'));
process.env.QQ_AGENT_DATA_DIR = dir;
// Windows 上退出时句柄可能还没释放（rm 会 EPERM）——清理失败不该让整个文件判失败。
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 留着也无害 */ } });
fs.writeFileSync(path.join(dir, 'face-names.json'), JSON.stringify({ bySid: { 14: '微笑' } }));

const { ChatStore } = await import('../src/core/store.js');
const { SendQueue } = await import('../src/onebot/sender.js');
const { OneBotClient } = await import('../src/onebot/onebot.js');
const { buildToolDefs, platformGateAllowed, platformQuotaLimit, platformToolAllowed } = await import('../src/tools/tools-core.js');
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

const groupCtx = (call) => ({
  kind: 'group', chatId: '433', chatKey: 'group:433',
  store: { findByMid: () => null, recent: () => [] },
  onebot: { call },
  session: { id: 's', sent: [] },
  emit: () => {}
});

it('工具表：第二批工具都在；平台开关默认值正确', () => {
  const names = new Set(buildToolDefs().map((d) => d.name));
  for (const expected of ['list_group_files', 'group_file_url', 'send_group_file',
    'list_group_album', 'like_album_photo', 'comment_album_photo', 'upload_to_group_album',
    'get_user_info', 'translate_text']) {
    assert.ok(names.has(expected), `缺工具 ${expected}`);
  }
  assert.equal(DEFAULT_CONFIG.platform.albumUpload, false, '相册上传默认关');
  assert.equal(DEFAULT_CONFIG.platform.avatarWrites, false, '换头像默认关（账号级外观）');
  assert.equal(DEFAULT_CONFIG.platform.nicknameWrites, false, '改昵称/个性说明默认关（账号级外观）');
  assert.equal(DEFAULT_CONFIG.platform.readReceipts, false, '已读标记默认关');
  assert.equal(DEFAULT_CONFIG.platform.forwardCards, true, '日报卡片默认开');
  assert.equal(DEFAULT_CONFIG.platform.qqVoiceCharacter, '', 'QQ 语音音色默认不固定');
  assert.equal(DEFAULT_CONFIG.send.typingIndicator, true, '正在输入默认开');
  // 读写分离拆细（2026-10-07）：写侧默认延续拆分前的取向（原来跟着"读开关"一起开）
  for (const key of ['reactionsWrite', 'remarkWrites', 'groupWrites', 'groupFileSend', 'albumWrites']) {
    assert.equal(DEFAULT_CONFIG.platform[key], true, `${key} 默认应延续拆细前的取向（开）`);
  }
  for (const key of ['reactions', 'albumRead', 'groupFiles', 'groupTools', 'ocr', 'profileWrites', 'qqVoice']) {
    assert.equal(DEFAULT_CONFIG.platform[key], true, `${key} 默认应延续拆细前的取向（开）`);
  }
  assert.deepEqual(DEFAULT_CONFIG.platform.perGroup, {}, '按群覆盖默认空');
  assert.deepEqual(DEFAULT_CONFIG.platform.quotas,
    { reactionsPerHour: 10, albumWritesPerHour: 5, profilePerDay: 1, remarksPerDay: 1, avatarsPerWeek: 1 },
    '写入闸门的默认上限（2026-10-07 收紧：按"真人会怎么做"定；albumWrites 是审计后补的漏网）');
});

it('platformToolAllowed：默认全开（账号级外观三项除外），显式关生效，读写互不牵连', () => {
  assert.equal(platformToolAllowed('react_to_message', {}), true);
  assert.equal(platformToolAllowed('send_qq_voice', {}), true);
  assert.equal(platformToolAllowed('upload_to_group_album', {}), false, '默认关：未显式开就不放行');
  assert.equal(platformToolAllowed('upload_to_group_album', { albumUpload: true }), true);
  assert.equal(platformToolAllowed('set_my_avatar', {}), false, '换头像也是默认关');
  assert.equal(platformToolAllowed('set_my_avatar', { avatarWrites: true }), true);
  assert.equal(platformToolAllowed('set_my_profile', {}), false, '改昵称/个性说明同样默认关');
  assert.equal(platformToolAllowed('set_my_profile', { nicknameWrites: true }), true);
  // 读 / 写分开：关一边不牵连另一边（这正是这次拆细的意义）
  assert.equal(platformToolAllowed('react_to_message', { reactions: false }), true, '关"看表情"不该连"贴表情"一起关');
  assert.equal(platformToolAllowed('get_message_reactions', { reactions: false }), false);
  assert.equal(platformToolAllowed('get_message_reactions', { reactionsWrite: false }), true);
  assert.equal(platformToolAllowed('list_group_files', { groupFileSend: false }), true);
  assert.equal(platformToolAllowed('send_group_file', { groupFileSend: false }), false);
  assert.equal(platformToolAllowed('send_group_file', { groupFiles: false }), true, '关"看目录"不该连"发文件"一起关');
  assert.equal(platformToolAllowed('list_group_album', { albumWrites: false }), true);
  assert.equal(platformToolAllowed('like_album_photo', { albumWrites: false }), false);
  assert.equal(platformToolAllowed('like_album_photo', { albumRead: false }), true, '关"看相册"不该连"点赞"一起关');
  assert.equal(platformToolAllowed('get_group_profile', { groupWrites: false }), true);
  assert.equal(platformToolAllowed('group_sign', { groupWrites: false }), false);
  assert.equal(platformToolAllowed('group_sign', { groupTools: false }), true, '关"看群资料"不该连"签到"一起关');
  assert.equal(platformToolAllowed('set_my_signature', { remarkWrites: false }), true);
  assert.equal(platformToolAllowed('set_remark', { remarkWrites: false }), false);
  assert.equal(platformToolAllowed('set_remark', { profileWrites: false }), true);
  assert.equal(platformToolAllowed('read_image_text', { ocr: false }), false);
  assert.equal(platformToolAllowed('send_message', { reactions: false }), true, '无关工具不受平台开关影响');
});

it('按群覆盖：本群显式布尔值优先于全局，别的群不受影响', () => {
  const platform = {
    reactionsWrite: true,
    albumWrites: true,
    avatarWrites: false,
    perGroup: {
      '433': { reactionsWrite: false, avatarWrites: true },
      '999': { albumWrites: false, readReceipts: true }   // readReceipts 不是门控键 → 不许生效
    }
  };
  // group:433：本群关了贴表情、开了换头像
  assert.equal(platformToolAllowed('react_to_message', platform, 'group:433'), false);
  assert.equal(platformToolAllowed('set_my_avatar', platform, 'group:433'), true);
  // 别的群照旧走全局
  assert.equal(platformToolAllowed('react_to_message', platform, 'group:100'), true);
  assert.equal(platformToolAllowed('set_my_avatar', platform, 'group:100'), false);
  // 裸群号与控制台同口径（事件与配置里都是裸号）
  assert.equal(platformToolAllowed('react_to_message', platform, '433'), false);
  // 私聊不带按群覆盖（chatKey 里没有群号）
  assert.equal(platformToolAllowed('react_to_message', platform, 'private:5'), true);
  // 覆盖里没写的键回落全局
  assert.equal(platformToolAllowed('like_album_photo', platform, 'group:433'), true);
  assert.equal(platformToolAllowed('like_album_photo', platform, 'group:999'), false);
  // get_message_reactions 只归 reactions（本群没覆盖它）→ 仍按全局
  assert.equal(platformToolAllowed('get_message_reactions', platform, 'group:433'), true);
  // "默认关"的键也能被本群显式打开（avatarWrites 没有全局值）
  assert.equal(platformGateAllowed('avatarWrites', { perGroup: { '8': { avatarWrites: true } } }, 'group:8'), true);
});

it('配额上限读配置：改小立刻生效，非法值回落默认', () => {
  assert.equal(platformQuotaLimit({}, 'reactionsPerHour'), 10, '缺配置 = 内置默认（2026-10-07 收紧后）');
  assert.equal(platformQuotaLimit({ platform: { quotas: { reactionsPerHour: 7 } } }, 'reactionsPerHour'), 7);
  assert.equal(platformQuotaLimit({ platform: { quotas: { reactionsPerHour: 0 } } }, 'reactionsPerHour'), 10, '0 = 默认（刹车不是不限量开关）');
  assert.equal(platformQuotaLimit({ platform: { quotas: { reactionsPerHour: -5 } } }, 'reactionsPerHour'), 10);
  assert.equal(platformQuotaLimit({ platform: { quotas: { reactionsPerHour: 'abc' } } }, 'reactionsPerHour'), 10);
  assert.equal(platformQuotaLimit({}, 'albumWritesPerHour'), 5, '审计后补的相册互动闸门：缺配置 = 默认 5');
  // 0<n<1 必须夹到 1：floor 成 0 的话，quota.js 的 normMax(0)=Infinity = 这道刹车被静默解除
  assert.equal(platformQuotaLimit({ platform: { quotas: { reactionsPerHour: 0.5 } } }, 'reactionsPerHour'), 1,
    '0.5 要夹成 1（不是 0 —— 0 在闸门内部等于"不限量"）');
  assert.equal(platformQuotaLimit({ platform: { quotas: { avatarsPerWeek: 999 } } }, 'avatarsPerWeek'), 200, '硬顶 200');
  assert.equal(platformQuotaLimit({ platform: { quotas: { avatarsPerWeek: 2.7 } } }, 'avatarsPerWeek'), 2, '取整向下');
});

it('list_group_files：映射文件与文件夹；私聊拒绝', async () => {
  const calls = [];
  const ctx = groupCtx(async (action, params) => {
    calls.push([action, params]);
    return {
      files: [{ file_name: '名单.txt', file_size: 2048, file_id: 'f1', uploader_name: '群主' }],
      folders: [{ folder_name: '照片' }]
    };
  });
  const res = parse(await tool('list_group_files').execute(ctx, {}));
  assert.deepEqual(calls[0], ['get_group_root_files', { group_id: 433 }]);
  assert.deepEqual(res.files[0], { name: '名单.txt', sizeKB: 2, fileId: 'f1', uploader: '群主' });
  assert.deepEqual(res.folders, ['照片']);
  const priv = await tool('list_group_files').execute({ kind: 'private', chatId: '2', chatKey: 'private:2' }, {});
  assert.equal(priv.isError, true);
});

it('group_file_url：取下载直链；空 id 拒绝', async () => {
  const ctx = groupCtx(async () => ({ url: 'https://example.com/f1' }));
  const res = parse(await tool('group_file_url').execute(ctx, { fileId: 'f1' }));
  assert.equal(res.url, 'https://example.com/f1');
  const bad = await tool('group_file_url').execute(ctx, { fileId: '' });
  assert.equal(bad.isError, true);
});

it('send_group_file：text 变 base64 文件、url 原样转发、二选一校验（发送走队列）', async () => {
  const sentCalls = [];
  const ctx = {
    ...groupCtx(async () => ({})),
    // 发送这一步走发送队列（限频/禁言/outbox，2026-10-07 复审 P2）：这里验工具与队列的交接，
    // 队列→协议端的真实 wire 形状在 platform-simulated-group 里验。
    sender: {
      groupFile: async (chatKey, payload, options) => { sentCalls.push({ chatKey, payload, options }); return { file_id: 'up1' }; }
    }
  };
  const byText = parse(await tool('send_group_file').execute(ctx, { text: '第一行', name: '名单.txt' }));
  assert.equal(byText.sent, true);
  assert.equal(byText.fileId, 'up1');
  assert.equal(sentCalls.at(-1).chatKey, 'group:433');
  const textParams = sentCalls.at(-1).payload;
  assert.equal(textParams.name, '名单.txt');
  assert.ok(textParams.file.startsWith('base64://'), '文本要以 base64 文件发出去');
  assert.equal(Buffer.from(textParams.file.slice('base64://'.length), 'base64').toString('utf8'), '第一行');

  await tool('send_group_file').execute(ctx, { url: 'https://example.com/a.pdf', name: 'a.pdf' });
  assert.equal(sentCalls.at(-1).payload.file, 'https://example.com/a.pdf');

  assert.equal((await tool('send_group_file').execute(ctx, {})).isError, true);
  assert.equal((await tool('send_group_file').execute(ctx, { text: 'x', url: 'https://e/x' })).isError, true);

  // 2026-10-09 审查 P1：协议端把 file 字段当"URL / base64 / 协议端能读到的本地路径"三态都收，
  // 非 http 前缀会原样透传成"读本机文件发进群"。必须一律拒，且不许进发送队列。
  for (const bad of ['/app/data/config.json', 'file:///etc/passwd', 'base64://aGk=', 'ftp://e/x']) {
    assert.equal((await tool('send_group_file').execute(ctx, { url: bad })).isError, true,
      `${bad} 这类非 http(s) 地址必须被拒`);
  }
  assert.equal((await tool('send_group_file').execute(ctx, { url: 'http://127.0.0.1:3210/secret' })).isError, true,
    '内网字面量地址必须被拒（与 safe-fetch 同一口径）');
  assert.equal(sentCalls.at(-1).payload.file, 'https://example.com/a.pdf',
    '被拒的地址不能进发送队列');
});

it('list_group_album：列相册 / 列照片；点赞与评论参数形状', async () => {
  const calls = [];
  const ctx = groupCtx(async (action, params) => {
    calls.push([action, params]);
    if (action === 'get_group_album_list') return [{ id: 'alb1', name: '日常', picNum: 12, createTime: 1700000000 }];
    if (action === 'get_group_album_media_list') {
      return { media_list: [{ lloc: 'lo1', batch_id: 'b1', uploader_name: '甲', upload_time: 1700000001, desc: '合影' }] };
    }
    return {};
  });
  const albums = parse(await tool('list_group_album').execute(ctx, {}));
  assert.deepEqual(albums.albums[0], { id: 'alb1', name: '日常', pics: 12, createTime: 1700000000 });

  const photos = parse(await tool('list_group_album').execute(ctx, { albumId: 'alb1' }));
  assert.equal(photos.photos[0].lloc, 'lo1');
  assert.equal(photos.photos[0].batchId, 'b1');

  await tool('like_album_photo').execute(ctx, { albumId: 'alb1', batchId: 'b1' });
  assert.deepEqual(calls.at(-1), ['set_group_album_media_like', { group_id: 433, album_id: 'alb1', batch_id: 'b1' }]);
  await tool('comment_album_photo').execute(ctx, { albumId: 'alb1', lloc: 'lo1', content: '哈哈' });
  assert.deepEqual(calls.at(-1), ['do_group_album_comment', { group_id: 433, album_id: 'alb1', lloc: 'lo1', content: '哈哈' }]);
});

it('upload_to_group_album：用消息里的图 + 第一个相册；没有图时报错（上传走队列）', async () => {
  const calls = [];
  const uploaded = [];
  const ctx = {
    ...groupCtx(async (action, params) => {
      calls.push([action, params]);
      if (action === 'get_group_album_list') return [{ id: 'alb1', name: '日常' }];
      return {};
    }),
    sender: {
      albumPhoto: async (chatKey, payload, options) => { uploaded.push({ chatKey, payload, options }); return {}; }
    }
  };
  ctx.store.findByMid = () => ({ mid: '9', media: [{ kind: 'image', url: 'https://example.com/pic.png', file: 'pic.png' }] });
  const res = parse(await tool('upload_to_group_album').execute(ctx, { messageId: '9' }));
  assert.equal(res.uploaded, true);
  assert.deepEqual(uploaded.at(-1), {
    chatKey: 'group:433',
    payload: { file: 'https://example.com/pic.png', albumId: 'alb1', albumName: '日常' },
    options: { runId: undefined, signal: undefined }
  }, '上传要交给 sender.albumPhoto（限频/禁言/outbox）');

  ctx.store.findByMid = () => ({ mid: '10', media: [] });
  const noPic = await tool('upload_to_group_album').execute(ctx, { messageId: '10' });
  assert.ok(!noPic.isError, '没有图时给提示而不是报错');
  assert.match(noPic.content, /没有可上传的图片/);
});

it('get_user_info / translate_text：形状正确', async () => {
  const calls = [];
  const ctx = groupCtx(async (action, params) => {
    calls.push([action, params]);
    if (action === 'get_stranger_info') return { nickname: '甲', sex: 'male', age: 20 };
    if (action === 'translate_en2zh') return { words: ['你好'] };
    return {};
  });
  const info = parse(await tool('get_user_info').execute(ctx, { userId: '2002' }));
  assert.equal(info.nickname, '甲');
  assert.deepEqual(calls.at(-1), ['get_stranger_info', { user_id: 2002 }]);
  const tr = parse(await tool('translate_text').execute(ctx, { text: 'hello' }));
  assert.equal(tr.translation, '你好');
  assert.equal((await tool('get_user_info').execute(ctx, { userId: '不是数字' })).isError, true);
});

it('合并转发：sendForwardMsg 参数形状 + sender.sendForwardCard 走链并留档', async () => {
  const bot = new OneBotClient({ wsUrl: 'ws://127.0.0.1:1', httpUrl: 'http://127.0.0.1:1' });
  const calls = [];
  bot.call = async (action, params) => { calls.push([action, params]); return { message_id: 7 }; };
  const nodes = [{ type: 'node', data: { nickname: '群日报', content: [{ type: 'text', data: { text: '昨天聊了…' } }] } }];
  await bot.sendForwardMsg('group', 433, nodes);
  assert.deepEqual(calls.at(-1), ['send_forward_msg', { message_type: 'group', group_id: 433, messages: nodes }]);
  await bot.sendForwardMsg('private', 2, nodes);
  assert.deepEqual(calls.at(-1), ['send_forward_msg', { message_type: 'private', user_id: 2, messages: nodes }]);

  const store = new ChatStore(0, { dataDir: dir });
  const sender = new SendQueue({ store, onebot: { call: async () => ({ message_id: 7 }), sendForwardMsg: async () => ({ message_id: 7 }) } });
  const sent = await sender.sendForwardCard('group:1', nodes, {});
  assert.equal(sent.message_id, 7);
  const self = store.recent('group:1', { limit: 5 }).find((m) => m.self);
  assert.ok(self && self.text.includes('聊天记录卡片'), '卡片要进自己的存档（下次运行能看到）');
  store.close();   // 句柄不关，Windows 上退出清理会 EPERM（整个文件被判失败）
});
