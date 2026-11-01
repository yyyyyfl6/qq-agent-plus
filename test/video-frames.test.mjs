// 视频看画面：视频消息的画面要能被视觉模型看到（抽 4 帧拼 2×2 帧条）。
// 背景（用户 2026-09-26 反馈）：发了个视频，机器人回"视频只能听声" —— 因为当时只采了音轨，
// 画面根本没进过模型的眼睛。这里覆盖：媒体采集（引两条：音轨 + 画面）、抽帧条、
// 以及 get_message_images 工具在视频消息上真的返回一张 JPEG。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-video-frames-'));
process.env.QQ_AGENT_DATA_DIR = root;
process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 句柄占用就算了 */ } });

const { DEFAULT_CONFIG, updateConfig } = await import('../src/core/config.js');
const cfg = structuredClone(DEFAULT_CONFIG);
cfg.security = { ...cfg.security, allowPrivateImageHosts: true };   // 测试服务在 127.0.0.1
updateConfig(cfg);

const { extractMediaFromSegments } = await import('../src/onebot/onebot.js');
const { convertVideoToFrameStrip, resolveFfmpeg } = await import('../src/tools/image-downsample.js');
const { buildToolDefs } = await import('../src/tools/tools.js');

const hasFfmpeg = await resolveFfmpeg() !== null;

/** 用 ffmpeg 造一段 3 秒测试视频（有画面变化，抽帧能看出区别）。 */
function makeTestVideo() {
  const file = path.join(root, 'clip.mp4');
  const res = spawnSync('ffmpeg', [
    '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=15',
    '-t', '3', '-c:v', 'mpeg4', '-y', file
  ], { encoding: 'utf8' });
  if (res.status !== 0) return null;
  return fs.readFileSync(file);
}

test('媒体采集：视频段既留音轨也留画面（群文件里的视频同理）', () => {
  const segments = [
    { type: 'video', data: { file: 'a.mp4', url: 'https://example.com/a.mp4' } },
    { type: 'file', data: { name: 'b.mp4', url: 'https://example.com/b.mp4' } },
    { type: 'file', data: { name: 'c.m4a', url: 'https://example.com/c.m4a' } },
    { type: 'record', data: { file: 'd.amr', url: 'https://example.com/d.amr' } }
  ];
  const media = extractMediaFromSegments(segments);
  const kinds = (match) => media.filter((m) => String(m.file || '').startsWith(match)).map((m) => m.kind).sort();
  assert.deepEqual(kinds('a.mp4'), ['audio', 'video'], '视频段要同时给音轨与画面');
  assert.deepEqual(kinds('b.mp4'), ['audio', 'video'], '群文件里的视频也要给画面');
  assert.deepEqual(kinds('c.m4a'), ['audio'], '纯音频文件不需要画面');
  assert.deepEqual(kinds('d.amr'), ['audio'], 'QQ 语音只给音轨');
});

test('视频抽帧条：3 秒视频抽成一张 JPEG 四宫格', { skip: hasFfmpeg ? false : '本环境没有 ffmpeg' }, async () => {
  const video = makeTestVideo();
  assert.ok(video?.length, '测试视频要造出来');
  const strip = await convertVideoToFrameStrip(video);
  assert.ok(strip?.length > 2000, `帧条应是一张像样的 JPEG，实际 ${strip?.length ?? 0} 字节`);
  assert.equal(strip[0], 0xff, 'JPEG SOI');
  assert.equal(strip[1], 0xd8, 'JPEG SOI');
});

test('抽帧遇到垃圾输入返回 null（由调用方报"抽帧失败"，不当成空图静默通过）', { skip: hasFfmpeg ? false : '本环境没有 ffmpeg' }, async () => {
  const strip = await convertVideoToFrameStrip(Buffer.from('not-a-video-at-all'.repeat(20)));
  assert.equal(strip, null);
});

test('get_message_images 在视频消息上返回帧条 JPEG（不是"没有可查看的图片"）', { skip: hasFfmpeg ? false : '本环境没有 ffmpeg' }, async () => {
  const video = makeTestVideo();
  assert.ok(video?.length, '测试视频要造出来');
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'video/mp4' });
    res.end(video);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/clip.mp4`;

  const tool = buildToolDefs().find((t) => t.name === 'get_message_images');
  assert.ok(tool, '工具要存在');
  const entry = { mid: 'm1', text: '[视频]', media: [] };
  const ctx = {
    chatKey: 'group:1',
    signal: AbortSignal.timeout(60000),
    store: { findByMid: () => entry, updateByMid: () => {} },
    stickers: { find: async () => null },
    onebot: { getMsg: async () => ({ message: [{ type: 'video', data: { file: 'clip.mp4', url } }] }) }
  };
  try {
    const result = await tool.execute(ctx, { messageId: 'm1' });
    const blob = JSON.stringify(result);
    assert.match(blob, /data:image\/jpeg;base64,/, '要返回 JPEG 帧条');
    assert.match(blob, /视频/, '要告诉模型这是视频抽的帧（并提示可以再听音轨）');
    assert.equal(blob.includes('没有可查看的图片'), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});


test('抽帧被中止时原样抛出（不误报"需要 ffmpeg/ffprobe"）', { skip: hasFfmpeg ? false : '本环境没有 ffmpeg' }, async () => {
  const video = makeTestVideo();
  assert.ok(video?.length, '测试视频要造出来');
  const controller = new AbortController();
  controller.abort(new Error('已中止'));
  await assert.rejects(
    () => convertVideoToFrameStrip(video, controller.signal),
    /已中止|abort/i
  );
});

// 「消息类型」页的视频画面开关（issue #34，2026-10-15）：关掉后视频既不下载也不抽帧
// （省一次网络往返 + 一次视觉调用），但图片/表情照常，并且要如实说明"这条视频没看"——
// 否则模型会以为这条消息里只有那几张图。用 base64:// 送图、用计数服务端钉住"没碰视频"，
// 所以这条用例不依赖 ffmpeg。
test('关掉视频画面：视频不下载不抽帧，图片照常，并说明为什么看不到', async () => {
  const { updateConfig } = await import('../src/core/config.js');
  const tinyPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
  let videoHits = 0;
  const server = http.createServer((req, res) => {
    videoHits += 1;
    res.writeHead(200, { 'content-type': 'video/mp4' });
    res.end(Buffer.alloc(64));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const videoUrl = `http://127.0.0.1:${server.address().port}/clip.mp4`;
  const tool = buildToolDefs().find((t) => t.name === 'get_message_images');
  assert.ok(tool, '工具要存在');
  updateConfig({ messageTypes: { videoFrames: false } });
  try {
    // ① 只有视频：不下载、不抽帧，如实说清是设置关的（别再让它换个 id 重试）
    const videoOnly = { mid: 'm1', text: '[视频]', media: [{ kind: 'video', url: videoUrl }] };
    const ctx1 = {
      chatKey: 'group:1', signal: AbortSignal.timeout(20000),
      store: { findByMid: () => videoOnly, updateByMid: () => {} },
      stickers: { find: async () => null }
    };
    const r1 = await tool.execute(ctx1, { messageId: 'm1' });
    assert.equal(r1.isError, undefined, '这是设置行为，不该报错');
    assert.match(String(r1.content), /视频画面查看在设置里关着/);

    // ② 图片 + 视频：图照常给（走 base64:// 不碰网络），视频跳过并计数
    const mixed = {
      mid: 'm2', text: '[图片][视频]',
      media: [{ kind: 'image', url: `base64://${tinyPng}` }, { kind: 'video', url: videoUrl }]
    };
    const ctx2 = { ...ctx1, store: { findByMid: () => mixed, updateByMid: () => {} } };
    const r2 = await tool.execute(ctx2, { messageId: 'm2' });
    const blob = JSON.stringify(r2);
    assert.match(blob, /data:image\/png;base64,/, '图片仍要能看');
    assert.match(blob, /1 条视频未看/, '要说明有视频没看，别让模型以为这条消息只有图');

    assert.equal(videoHits, 0, '关掉后一次都不该去下视频');
  } finally {
    updateConfig({ messageTypes: { videoFrames: true } });
    await new Promise((resolve) => server.close(resolve));
  }
});
