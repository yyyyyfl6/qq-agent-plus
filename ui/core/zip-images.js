// 表情包批量导入的 ZIP 解包（纯浏览器内建 API，无 DOM 依赖，可在 node 单测里直接跑）。
// 限制与错误都按「给用户看的一句话」设计：加密位、条目数、单图/总量上限、压缩方法白名单，
// 越界字段抛 RangeError 由调用方当读取失败展示；路径只取 basename，不解包到磁盘。
const MAX_ZIP_BYTES = 64 * 1024 * 1024;
const MAX_ENTRIES = 500;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const MAX_FILES = 100;
const IMAGE_NAME_RE = /\.(png|jpe?g|gif|webp)$/i;

async function unzipStickerImages(file) {
  if (file.size > MAX_ZIP_BYTES) throw new Error('ZIP 压缩包不能超过 64 MiB');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const view = new DataView(bytes.buffer);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw new Error('不是有效的 ZIP 文件');
  const count = view.getUint16(end + 10, true);
  let offset = view.getUint32(end + 16, true);
  if (count > MAX_ENTRIES || offset >= bytes.length) throw new Error('ZIP 目录无效或条目过多');
  const output = []; let total = 0;
  for (let i = 0; i < count; i += 1) {
    if (view.getUint32(offset, true) !== 0x02014b50) throw new Error('ZIP 目录结构损坏');
    const flags = view.getUint16(offset + 8, true); const method = view.getUint16(offset + 10, true);
    const compressed = view.getUint32(offset + 20, true); const expanded = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true); const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true); const local = view.getUint32(offset + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    offset += 46 + nameLength + extraLength + commentLength;
    if (!IMAGE_NAME_RE.test(name) || name.endsWith('/')) continue;
    if (flags & 1) throw new Error('不支持加密 ZIP，请先解密压缩包');
    if (compressed > MAX_IMAGE_BYTES || expanded > MAX_IMAGE_BYTES || view.getUint32(local, true) !== 0x04034b50) throw new Error(`图片条目异常：${name}`);
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const payload = bytes.slice(start, start + compressed);
    let imageBytes;
    if (method === 0) imageBytes = payload;
    else if (method === 8) {
      if (typeof DecompressionStream === 'undefined') {
        throw new Error('当前浏览器不支持解压 ZIP，请更新浏览器，或把图片逐张选中导入');
      }
      const reader = new Blob([payload]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
      const chunks = []; let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > MAX_IMAGE_BYTES) { await reader.cancel(); throw new Error(`图片解压后超过 8 MiB：${name}`); }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      imageBytes = new Uint8Array(size); let cursor = 0;
      for (const chunk of chunks) { imageBytes.set(chunk, cursor); cursor += chunk.length; }
    }
    else continue;
    if (imageBytes.length !== expanded) throw new Error(`解压大小不符：${name}`);
    total += imageBytes.length;
    if (total > MAX_TOTAL_BYTES) throw new Error('ZIP 解压后的图片总量超过 128 MiB');
    const extension = name.split('.').pop().toLowerCase();
    output.push(new File([imageBytes], name.split(/[\\/]/).pop(), { type: extension === 'jpg' ? 'image/jpeg' : `image/${extension}` }));
    if (output.length > MAX_FILES) throw new Error('每批最多处理 100 张图片');
  }
  if (!output.length) throw new Error('压缩包内没有支持的图片');
  return output;
}

export { unzipStickerImages };
