// 人格设定图：每个人格一张"这就是我"的人物设定图。
//
//   · 人格页（侧栏「人格」）每张人格卡上传 / 更换 / 移除；卡片头像就显示这张图。
//     多人格没开时只有一套人设（设置 → 人设），它的设定图记在 `default` 名下（人格页顶部单独一块）。
//   · 生图：模型调 generate_image 画**它自己**（self:true，或对方原话里有"你自己 / 自拍 / 你长什么样…"，
//     或画面描述里出现了它的名字）时，宿主把**当前会话正在运行的那个人格**的设定图一起交给生图模型
//     （传图方式复用 image-refs 的 imageRefs.mode / bodyField），提示词末尾补上设定图说明里的外貌要点。
//     切人格后跟着换，不会拿 A 的脸去画 B。
//
// 存储：data/persona-refs/<人格 id>.<ext> + meta.json（{ [id]: { ext, hint, at } }）。不进 config.json：
// 图是二进制，且人格设定图与多人格配置的保存（整张 skins 表单）互不牵连。移除人格不删图（与"已有存档保留"同口径）。
import fs from 'node:fs';
import path from 'node:path';
import { skinScope } from '../skins/context.js';
import { str } from './shared.js';

const MAX_BYTES = 4 * 1024 * 1024;
const MIME_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const EXT_MIME = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };
export const PERSONA_DEFAULT_KEY = 'default';
const KEY_RE = /^[a-z][a-z0-9_-]{0,39}$/;

// 对方原话里出现这些，就当是在要它画自己（模型忘了传 self 时的兜底；只看对方原话，不看画面描述里的"你"）
export const SELF_WORDS = ['你自己', '自拍', '你长什么样', '你长啥样', '你的样子', '你的照片', '画画你', '画一下你', '画个你', '你本人', '你的自画像', '自画像', '我们的合照', '我俩的合照', '和你的合照', '跟你的合照'];

function sniffMime(buf) {
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return '';
}

export const validPersonaKey = (key) => KEY_RE.test(String(key || ''));

/** 当前在跑的人格的 key：多人格开着 = 本轮的人格 id（skins.scope 里），否则 default。 */
export function activePersonaKey(cfg) {
  if (cfg?.skins?.enabled !== true) return PERSONA_DEFAULT_KEY;
  const id = skinScope()?.skinId || cfg.activeSkinId || cfg.skins?.default || '';
  return validPersonaKey(id) ? id : PERSONA_DEFAULT_KEY;
}

/** 这次生图是不是在画它自己。 */
export function wantsSelf({ self, userText = '', prompt = '', botName = '' } = {}) {
  if (self === true) return true;
  if (self === false) return false;
  const said = String(userText || '');
  if (SELF_WORDS.some((w) => said.includes(w))) return true;
  const name = String(botName || '').trim();
  return name.length >= 2 && String(prompt || '').includes(name);
}

let singleton = null;
export function getPersonaRefs() { return singleton; }

export class PersonaRefs {
  constructor({ dataDir = 'data' } = {}) {
    this.dir = path.join(dataDir, 'persona-refs');
    this.metaFile = path.join(this.dir, 'meta.json');
    singleton = this;
  }

  meta() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.metaFile, 'utf8'));
      const out = {};
      for (const [key, v] of Object.entries(raw && typeof raw === 'object' ? raw : {})) {
        if (validPersonaKey(key) && v && EXT_MIME[v.ext]) out[key] = { ext: v.ext, hint: str(v.hint, 300), at: Number(v.at) || 0 };
      }
      return out;
    } catch { return {}; }
  }

  #saveMeta(meta) {
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.metaFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(meta, null, 2));
    fs.renameSync(tmp, this.metaFile);
  }

  fileOf(key, ext) { return path.join(this.dir, `${key}.${ext}`); }

  get(key) { return this.meta()[key] || null; }

  /** 读图：{ buffer, mime, hint } 或 null（没有 / 文件丢了）。 */
  load(key) {
    const m = this.get(key);
    if (!m) return null;
    try {
      const buffer = fs.readFileSync(this.fileOf(key, m.ext));
      return { buffer, mime: sniffMime(buffer) || EXT_MIME[m.ext], hint: m.hint };
    } catch { return null; }
  }

  /** 上传 / 更换：image 是 data:URL 或纯 base64；不给 image 只改说明。 */
  set(key, { image, hint } = {}) {
    if (!validPersonaKey(key)) throw new Error('人格 id 不合法');
    const meta = this.meta();
    const cur = meta[key];
    if (image === undefined || image === null || image === '') {
      if (!cur) throw new Error('还没有设定图，先上传一张');
      meta[key] = { ...cur, hint: str(hint ?? cur.hint, 300), at: Date.now() };
      this.#saveMeta(meta);
      return meta[key];
    }
    const buffer = Buffer.from(String(image).replace(/^data:[^;]+;base64,/, ''), 'base64');
    if (!buffer.length) throw new Error('没有收到图片');
    if (buffer.length > MAX_BYTES) throw new Error('图片太大（上限 4 MB），先压缩一下');
    const mime = sniffMime(buffer);
    if (!mime) throw new Error('只支持 PNG / JPEG / WebP');
    const ext = MIME_EXT[mime];
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.fileOf(key, ext), buffer);
    if (cur && cur.ext !== ext) { try { fs.unlinkSync(this.fileOf(key, cur.ext)); } catch { /* 旧文件不在也行 */ } }
    meta[key] = { ext, hint: str(hint ?? cur?.hint ?? '', 300), at: Date.now() };
    this.#saveMeta(meta);
    return meta[key];
  }

  remove(key) {
    const meta = this.meta();
    const cur = meta[key];
    if (!cur) return false;
    delete meta[key];
    this.#saveMeta(meta);
    try { fs.unlinkSync(this.fileOf(key, cur.ext)); } catch { /* 已不在 */ }
    return true;
  }

  /**
   * generate_image 调用前：要画它自己、且当前人格有设定图 → { key, buffer, mime, hint }，否则 null。
   */
  resolveSelf(cfg, { self, userText = '', prompt = '' } = {}) {
    const key = activePersonaKey(cfg);
    if (!this.get(key)) return null;
    if (!wantsSelf({ self, userText, prompt, botName: cfg?.persona?.botName })) return null;
    const hit = this.load(key);
    return hit ? { key, ...hit } : null;
  }
}

export function registerPersonaRefsRoutes(router, deps = {}) {
  const json = deps.json;
  const readBody = deps.readBody;
  const getRuntime = deps.getRuntime;
  const need = (res) => {
    const rt = getRuntime();
    if (!rt) json(res, 503, { ok: false, error: '人格设定图模块未初始化' });
    return rt;
  };
  const view = (key, m) => ({ key, hint: m.hint, at: m.at, url: `/api/persona-refs/${key}/image?v=${m.at}` });
  router.add('GET', '/api/persona-refs', async (req, res) => {
    const rt = need(res); if (!rt) return;
    return json(res, 200, { ok: true, refs: Object.fromEntries(Object.entries(rt.meta()).map(([k, m]) => [k, view(k, m)])) });
  });
  router.add('GET', '/api/persona-refs/:key/image', async (req, res, params) => {
    const rt = need(res); if (!rt) return;
    const hit = validPersonaKey(params.key) ? rt.load(String(params.key)) : null;
    if (!hit) return json(res, 404, { ok: false, error: '这个人格还没有设定图' });
    res.writeHead(200, { 'content-type': hit.mime, 'cache-control': 'private, max-age=86400', 'x-content-type-options': 'nosniff' });
    res.end(hit.buffer);
  });
  router.add('POST', '/api/persona-refs/:key', async (req, res, params) => {
    const rt = need(res); if (!rt) return;
    try {
      const body = await readBody(req, 8 * 1024 * 1024);
      const m = rt.set(String(params.key), { image: body?.image, hint: body?.hint });
      return json(res, 200, { ok: true, ref: view(String(params.key), m) });
    } catch (error) { return json(res, 400, { ok: false, error: String(error?.message ?? error) }); }
  });
  router.add('DELETE', '/api/persona-refs/:key', async (req, res, params) => {
    const rt = need(res); if (!rt) return;
    return json(res, 200, { ok: validPersonaKey(params.key) ? rt.remove(String(params.key)) : false });
  });
}

export const PERSONA_REFS_LIMITS = Object.freeze({ maxBytes: MAX_BYTES });
