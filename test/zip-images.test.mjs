// 表情包批量导入的 ZIP 解包（ui/core/zip-images.js）边界用例。
// ZIP 字节都在测试里手工拼：不引第三方依赖，也覆盖手写解析器真正会踩的坏结构。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deflateRawSync } from 'node:zlib';

const { unzipStickerImages } = await import('../ui/core/zip-images.js');

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

function u16(value) { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, value, true); return b; }
function u32(value) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, value, true); return b; }
function bytes(string) { return new TextEncoder().encode(string); }
function concat(...parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

/** 拼一个最小的 ZIP：entries = [{ name, data, method(0|8), encrypted?, localExtra?, badLocalSig? }] */
function buildZip(entries, { countOverride = null, offsetOverride = null } = {}) {
  const locals = [];
  const centrals = [];
  for (const entry of entries) {
    const nameBytes = bytes(entry.name);
    const stored = entry.method === 8 ? deflateRawSync(entry.data) : entry.data;
    const localOffset = locals.reduce((sum, item) => sum + item.length, 0);
    const localExtra = entry.localExtra ?? new Uint8Array(0);
    locals.push(concat(
      u32(entry.badLocalSig ?? 0x04034b50),
      u16(20), u16(entry.encrypted ? 1 : 0), u16(entry.method ?? 0),
      u16(0), u16(0), u32(0),
      u32(stored.length), u32(entry.data.length),
      u16(nameBytes.length), u16(localExtra.length),
      nameBytes, localExtra, stored
    ));
    centrals.push(concat(
      u32(0x02014b50),
      u16(20), u16(20), u16(entry.encrypted ? 1 : 0), u16(entry.method ?? 0),
      u16(0), u16(0), u32(0),
      u32(stored.length), u32(entry.data.length),
      u16(nameBytes.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(localOffset),
      nameBytes
    ));
  }
  const centralStart = locals.reduce((sum, item) => sum + item.length, 0);
  const central = concat(...centrals);
  return concat(
    ...locals, central,
    u32(0x06054b50), u16(0), u16(0),
    u16(countOverride ?? entries.length), u16(countOverride ?? entries.length),
    u32(central.length), u32(offsetOverride ?? centralStart), u16(0)
  );
}

function zipFile(buffer) {
  return { size: buffer.length, arrayBuffer: async () => buffer.slice().buffer };
}

test('存储型与 deflate 型条目都能解出，目录结构被还原成 basename', async () => {
  const zip = buildZip([
    { name: 'photos/cat.png', data: PNG_BYTES, method: 0 },
    { name: 'dog.JPG', data: PNG_BYTES, method: 8 }
  ]);
  const files = await unzipStickerImages(zipFile(zip));
  assert.equal(files.length, 2);
  assert.equal(files[0].name, 'cat.png');
  assert.equal(files[0].type, 'image/png');
  assert.deepEqual(new Uint8Array(await files[0].arrayBuffer()), PNG_BYTES);
  assert.equal(files[1].name, 'dog.JPG');
  assert.equal(files[1].type, 'image/jpeg');
  assert.deepEqual(new Uint8Array(await files[1].arrayBuffer()), PNG_BYTES);
});

test('非图片条目与目录被跳过；全是非图片时报「没有支持的图片」', async () => {
  const zip = buildZip([
    { name: 'readme.txt', data: bytes('hello'), method: 0 },
    { name: 'folder/', data: new Uint8Array(0), method: 0 },
    { name: 'icon.png', data: PNG_BYTES, method: 0 }
  ]);
  assert.equal((await unzipStickerImages(zipFile(zip))).length, 1);
  await assert.rejects(
    unzipStickerImages(zipFile(buildZip([{ name: 'readme.txt', data: bytes('x'), method: 0 }]))),
    /没有支持的图片/
  );
});

test('加密位、坏 local 头、未知压缩方法各有明确报错', async () => {
  await assert.rejects(
    unzipStickerImages(zipFile(buildZip([{ name: 'a.png', data: PNG_BYTES, method: 0, encrypted: true }]))),
    /加密 ZIP/
  );
  await assert.rejects(
    unzipStickerImages(zipFile(buildZip([{ name: 'a.png', data: PNG_BYTES, method: 0, badLocalSig: 0xdeadbeef }]))),
    /图片条目异常/
  );
  // 未知方法（如 bzip2=12）：跳过而不是崩溃；只剩它时报「没有支持的图片」
  await assert.rejects(
    unzipStickerImages(zipFile(buildZip([{ name: 'a.png', data: PNG_BYTES, method: 12 }]))),
    /没有支持的图片/
  );
});

test('非 ZIP、坏目录签名、条目数超限、目录偏移越界都被拦下', async () => {
  await assert.rejects(unzipStickerImages(zipFile(bytes('not a zip at all'))), /不是有效的 ZIP/);
  const good = buildZip([{ name: 'a.png', data: PNG_BYTES, method: 0 }]);
  const brokenCentral = good.slice();
  new DataView(brokenCentral.buffer).setUint32(good.length - 22 + 16, good.length + 999, true);
  await assert.rejects(unzipStickerImages(zipFile(brokenCentral)), /目录无效或条目过多|目录结构损坏/);
  await assert.rejects(
    unzipStickerImages(zipFile(buildZip([{ name: 'a.png', data: PNG_BYTES, method: 0 }], { countOverride: 501 }))),
    /目录无效或条目过多/
  );
});

test('声明大小与实际不符（截断的 payload）报「解压大小不符」', async () => {
  const truncated = buildZip([{ name: 'a.png', data: PNG_BYTES, method: 0 }]);
  // 把 local（+22）与 central（+24）的 uncompressed size 都改大，模拟 payload 被截断的坏包
  const view = new DataView(truncated.buffer);
  const centralAt = 30 + 5 + PNG_BYTES.length; // local 头 30 + "a.png" + payload
  view.setUint32(22, PNG_BYTES.length + 100, true);
  view.setUint32(centralAt + 24, PNG_BYTES.length + 100, true);
  await assert.rejects(unzipStickerImages(zipFile(truncated)), /解压大小不符/);
});

test('超过 100 张的批次报错，而不是无限导入', async () => {
  const entries = Array.from({ length: 101 }, (_, i) => ({ name: `img${i}.png`, data: PNG_BYTES, method: 0 }));
  await assert.rejects(unzipStickerImages(zipFile(buildZip(entries))), /每批最多处理 100 张/);
  const hundred = entries.slice(0, 100);
  assert.equal((await unzipStickerImages(zipFile(buildZip(hundred)))).length, 100);
});
