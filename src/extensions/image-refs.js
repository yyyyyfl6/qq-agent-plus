// 生图参考图（提示词触发）：给图片生成配几张"参考图"，每张带触发关键词。
// 聊天里命中关键词（如"画一下你自己""你长什么样"）时，generate_image 会把这张图一起交给生图模型，
// 让它按图里的形象画 —— 机器人画自己就不会每次长得都不一样。
//
// 传图方式（imageRefs.mode）：
//   · auto  （默认）：模型名像 OpenAI 的图像编辑模型（gpt-image / dall-e-2）走 /images/edits，其余走 body
//   · body  ：仍打 /images/generations，在 JSON 里多带一个字段（默认 image，值是 data:URL）——
//            豆包 Seedream 4.x、通义万相、不少聚合网关都认这个形状
//   · edits ：OpenAI 形状的 POST /images/edits（multipart，image 字段是文件）
// 免 Key 的 pollinations 不支持参考图，命中时照常按纯文字画，并在工具结果里说明。
//
// 文件放 data/image-refs/<id>.<ext>；配置里只存元数据。关掉后文件保留。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getConfig, updateConfig } from '../core/config.js';
import { isPlainObject, str } from './shared.js';

const MAX_BYTES = 4 * 1024 * 1024;
const MAX_ITEMS = 12;
const MIME_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

let singleton = null;
/** 宿主初始化过的实例（工具执行期取用；单测里没初始化时为 null）。 */
export function getImageRefs() { return singleton; }

function sniffMime(buf) {
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return '';
}

function normalizeKeywords(value) {
  const list = Array.isArray(value) ? value : String(value ?? '').split(/[\n,，、]/);
  return [...new Set(list.map((k) => String(k ?? '').trim()).filter((k) => k && k.length <= 30))].slice(0, 20);
}

function normalizeItem(raw) {
  if (!isPlainObject(raw)) return null;
  const id = String(raw.id || '').replace(/[^a-z0-9]/gi, '').slice(0, 24);
  const ext = Object.values(MIME_EXT).includes(raw.ext) ? raw.ext : '';
  if (!id || !ext) return null;
  return {
    id,
    ext,
    label: str(raw.label, 30) || '参考图',
    keywords: normalizeKeywords(raw.keywords),
    hint: str(raw.hint, 200),
    enabled: raw.enabled !== false,
    at: Number(raw.at) || 0
  };
}

export function imageRefsConfig(cfg = getConfig()) {
  const raw = isPlainObject(cfg?.imageRefs) ? cfg.imageRefs : {};
  return {
    enabled: raw.enabled === true,
    mode: ['auto', 'body', 'edits'].includes(raw.mode) ? raw.mode : 'auto',
    bodyField: /^[a-z_][a-z0-9_]{0,30}$/i.test(String(raw.bodyField || '')) ? String(raw.bodyField) : 'image',
    matchPrompt: raw.matchPrompt !== false,     // 也匹配模型写的画面描述（不只看用户原话）
    items: (Array.isArray(raw.items) ? raw.items : []).map(normalizeItem).filter(Boolean).slice(0, MAX_ITEMS)
  };
}

function saveConfig(next) {
  const merged = imageRefsConfig({ imageRefs: next });
  updateConfig({ imageRefs: merged });
  return merged;
}

/** 实际用哪种传图方式。 */
export function resolveRefMode(mode, model) {
  if (mode === 'body' || mode === 'edits') return mode;
  return /gpt-image|dall-e-2/i.test(String(model || '')) ? 'edits' : 'body';
}

/** 在若干段文字里找第一张命中关键词的参考图（按配置顺序；label 精确点名优先）。 */
export function matchImageRef(items, { texts = [], reference = '' } = {}) {
  const live = (items || []).filter((it) => it.enabled);
  const ref = String(reference || '').trim();
  if (ref) {
    const hit = live.find((it) => it.label === ref || it.id === ref);
    if (hit) return hit;
  }
  const hay = texts.map((t) => String(t || '')).join('\n').toLowerCase();
  if (!hay.trim()) return null;
  return live.find((it) => it.keywords.some((k) => hay.includes(k.toLowerCase()))) || null;
}

export class ImageRefs {
  constructor({ dataDir = 'data' } = {}) {
    this.dir = path.join(dataDir, 'image-refs');
    singleton = this;
  }

  config() { return imageRefsConfig(); }

  fileOf(item) { return path.join(this.dir, `${item.id}.${item.ext}`); }

  load(item) {
    const buffer = fs.readFileSync(this.fileOf(item));
    return { buffer, mime: sniffMime(buffer) || 'image/png' };
  }

  /** 新增：image 是 data:URL 或纯 base64。 */
  add({ label = '', keywords = [], hint = '', image = '' } = {}) {
    const c = imageRefsConfig();
    if (c.items.length >= MAX_ITEMS) throw new Error(`参考图最多 ${MAX_ITEMS} 张`);
    const b64 = String(image || '').replace(/^data:[^;]+;base64,/, '');
    const buffer = Buffer.from(b64, 'base64');
    if (!buffer.length) throw new Error('没有收到图片');
    if (buffer.length > MAX_BYTES) throw new Error('图片太大（上限 4 MB），先压缩一下');
    const mime = sniffMime(buffer);
    if (!mime) throw new Error('只支持 PNG / JPEG / WebP');
    const item = normalizeItem({ id: crypto.randomBytes(6).toString('hex'), ext: MIME_EXT[mime], label, keywords, hint, at: Date.now() });
    if (!item.keywords.length) throw new Error('至少填一个触发关键词');
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.fileOf(item), buffer);
    saveConfig({ ...c, items: [...c.items, item] });
    return item;
  }

  update(id, patch = {}) {
    const c = imageRefsConfig();
    const idx = c.items.findIndex((it) => it.id === id);
    if (idx < 0) throw new Error('参考图不存在');
    const cur = c.items[idx];
    const next = normalizeItem({
      ...cur,
      ...(patch.label !== undefined ? { label: patch.label } : {}),
      ...(patch.keywords !== undefined ? { keywords: patch.keywords } : {}),
      ...(patch.hint !== undefined ? { hint: patch.hint } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled !== false } : {})
    });
    if (!next.keywords.length) throw new Error('至少保留一个触发关键词');
    const items = [...c.items];
    items[idx] = next;
    saveConfig({ ...c, items });
    return next;
  }

  remove(id) {
    const c = imageRefsConfig();
    const item = c.items.find((it) => it.id === id);
    if (!item) return false;
    saveConfig({ ...c, items: c.items.filter((it) => it.id !== id) });
    try { fs.unlinkSync(this.fileOf(item)); } catch { /* 文件已不在也算删了 */ }
    return true;
  }

  saveSettings(patch = {}) {
    const c = imageRefsConfig();
    return saveConfig({
      ...c,
      ...(patch.enabled !== undefined ? { enabled: patch.enabled === true } : {}),
      ...(patch.mode !== undefined ? { mode: patch.mode } : {}),
      ...(patch.bodyField !== undefined ? { bodyField: patch.bodyField } : {}),
      ...(patch.matchPrompt !== undefined ? { matchPrompt: patch.matchPrompt !== false } : {})
    });
  }

  /**
   * generate_image 调用前：看这次要不要带参考图。返回 null 或 { item, buffer, mime, mode, field }。
   * texts：用户本轮原话（必看）+ 模型写的 prompt（matchPrompt 开时）。
   */
  resolve({ userText = '', prompt = '', reference = '', model = '' } = {}) {
    const c = imageRefsConfig();
    if (!c.enabled || !c.items.length) return null;
    const item = matchImageRef(c.items, { texts: c.matchPrompt ? [userText, prompt] : [userText], reference });
    if (!item) return null;
    try {
      const { buffer, mime } = this.load(item);
      return { item, buffer, mime, mode: resolveRefMode(c.mode, model), field: c.bodyField };
    } catch {
      return null;   // 文件丢了：按纯文字画，不让整次生成失败
    }
  }
}

export function registerImageRefsRoutes(router, deps = {}) {
  const json = deps.json;
  const readBody = deps.readBody;
  const getRuntime = deps.getRuntime;
  const need = (res) => {
    const rt = getRuntime();
    if (!rt) json(res, 503, { ok: false, error: '参考图模块未初始化' });
    return rt;
  };
  const view = (it) => ({ ...it, url: `/api/ext/image-refs/${it.id}/image` });
  router.add('GET', '/api/ext/image-refs', async (req, res) => {
    const rt = need(res); if (!rt) return;
    const c = rt.config();
    const g = getConfig().imageGen || {};
    return json(res, 200, { ok: true, config: { ...c, items: c.items.map(view) }, effectiveMode: resolveRefMode(c.mode, g.model), imageGen: { enabled: g.enabled === true, model: String(g.model || ''), baseUrl: String(g.baseUrl || '') } });
  });
  router.add('POST', '/api/ext/image-refs/settings', async (req, res) => {
    const rt = need(res); if (!rt) return;
    const body = await readBody(req).catch(() => ({}));
    return json(res, 200, { ok: true, config: rt.saveSettings(body || {}) });
  });
  router.add('POST', '/api/ext/image-refs', async (req, res) => {
    const rt = need(res); if (!rt) return;
    try {
      const body = await readBody(req, 8 * 1024 * 1024);
      return json(res, 200, { ok: true, item: view(rt.add(body || {})) });
    } catch (error) { return json(res, 400, { ok: false, error: String(error?.message ?? error) }); }
  });
  router.add('POST', '/api/ext/image-refs/:id', async (req, res, params) => {
    const rt = need(res); if (!rt) return;
    try {
      const body = await readBody(req).catch(() => ({}));
      return json(res, 200, { ok: true, item: view(rt.update(String(params.id), body || {})) });
    } catch (error) { return json(res, 400, { ok: false, error: String(error?.message ?? error) }); }
  });
  router.add('DELETE', '/api/ext/image-refs/:id', async (req, res, params) => {
    const rt = need(res); if (!rt) return;
    return json(res, 200, { ok: rt.remove(String(params.id)) });
  });
  router.add('GET', '/api/ext/image-refs/:id/image', async (req, res, params) => {
    const rt = need(res); if (!rt) return;
    const item = rt.config().items.find((it) => it.id === String(params.id));
    if (!item) return json(res, 404, { ok: false, error: '参考图不存在' });
    try {
      const { buffer, mime } = rt.load(item);
      res.writeHead(200, { 'content-type': mime, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      res.end(buffer);
    } catch { return json(res, 404, { ok: false, error: '文件不见了' }); }
  });
  // 用一张参考图试画（要显式 confirm：按张计费）
  router.add('POST', '/api/ext/image-refs/:id/test', async (req, res, params) => {
    const rt = need(res); if (!rt) return;
    const body = await readBody(req).catch(() => ({}));
    if (body?.confirm !== true) return json(res, 409, { ok: false, error: '试画按张计费，需要显式确认' });
    const item = rt.config().items.find((it) => it.id === String(params.id));
    if (!item) return json(res, 404, { ok: false, error: '参考图不存在' });
    try {
      const cfg = getConfig();
      const { buffer, mime } = rt.load(item);
      const result = await deps.generateImage({
        cfg,
        apiCfg: cfg.api,
        apiKey: deps.resolveApiKey(cfg),
        prompt: str(body?.prompt, 300) || '参考图里的角色在海边散步，插画风格',
        reference: { buffer, mime, mode: resolveRefMode(rt.config().mode, cfg.imageGen?.model), field: rt.config().bodyField, hint: item.hint }
      });
      const outMime = sniffMime(result.buffer) || 'image/png';
      return json(res, 200, { ok: true, bytes: result.buffer.length, image: `data:${outMime};base64,${result.buffer.toString('base64')}`, note: result.referenceNote || '' });
    } catch (error) { return json(res, 400, { ok: false, error: String(error?.message ?? error) }); }
  });
}

export const IMAGE_REFS_LIMITS = Object.freeze({ maxBytes: MAX_BYTES, maxItems: MAX_ITEMS });
