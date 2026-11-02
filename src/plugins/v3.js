// 插件接口 apiVersion 3 的宿主侧组装点：控制台（app.js）只和这里打交道，改动集中在新文件里，
// 上游文件只留几行接线（便于跟上游合并）。
//
//   agent           给 PluginRegistry 的 getAgent：wake（走编排器同一条 proactive 唤醒）+ persona（会话当前人格）
//   registerRoutes  控制台路由：/api/plugins/page（取插件页面 HTML）、/api/plugins/page-rpc（页面里的按钮）
//   handleHttp      /plugin-hooks/<id>/…（设备入站，不走控制台令牌，见 inbound.js）
//   start / stop    按插件设置开 / 关独立入站端口
//
// 能力本身（副 API / 背景 / 唤醒 / 人格）在 agent-caps.js；默认拒的口径（总开关、enabledIds、撤回、
// manifest 声明）由 PluginRegistry.v3Host 统一判断。
import fs from 'node:fs';
import { getConfig } from '../core/config.js';
import { resolvePersona } from '../personas.js';
import { createInboundHandler, INBOUND_PREFIX } from './inbound.js';

const ID_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;
const METHOD_RE = /^[a-z][A-Za-z0-9_.]{0,40}$/;
const MAX_PAGE_BYTES = 512 * 1024;

export function createPluginV3({ getRegistry, getOrchestrator, getSkins, log = () => {} } = {}) {
  const registryOf = getRegistry;
  const orchestratorOf = getOrchestrator;
  const skinsOf = getSkins;

  const agent = {
    wake: (chatKey, options) => orchestratorOf().wake(chatKey, options),
    // 与主对话同一套解析：多人格分仓 + 按群人设
    persona: (chatKey) => {
      const skins = skinsOf();
      const read = () => {
        const persona = resolvePersona(getConfig(), chatKey);
        const skin = skins?.enabled ? skins.current(chatKey) : null;
        return { skinId: skin?.id || '', label: skin?.label || '', botName: persona.botName || '', roleText: persona.roleText || '' };
      };
      return skins ? skins.scope(chatKey, read) : read();
    }
  };

  /** 入站：{ status, body }。未启用 / 没声明 → 404（不泄露装了什么）；插件超时 / 崩溃 → 502。 */
  async function inbound(id, request) {
    const hit = await registryOf().v3Host(id, 'inbound');
    if (!hit) return { status: 404, body: { ok: false, message: 'not found' } };
    if (!hit.ready) return { status: 503, body: { ok: false, message: '插件未在运行' } };
    try {
      const result = await hit.ready.inbound(request);
      const status = Number(result?.status);
      const out = {
        status: Number.isInteger(status) && status >= 200 && status <= 599 ? status : 200,
        body: result?.body === undefined ? { ok: true } : result.body
      };
      // 文本类响应（页面等）：类型与体积在 inbound.js 出口处再校验
      if (typeof result?.contentType === 'string' && result.contentType) out.contentType = result.contentType.slice(0, 60);
      return out;
    } catch (error) {
      log(`插件 ${id} 处理入站请求失败：${error?.message ?? error}`);
      return { status: error?.code === 'E_BUSY' ? 503 : 502, body: { ok: false, message: '插件处理失败' } };
    }
  }

  /** 插件页面 HTML（宿主读插件目录里的文件，≤512KB）。没声明 / 没启用 → null。 */
  async function pageSource(id) {
    const hit = await registryOf().v3Host(id, 'page', { start: false });
    const page = hit?.host?.manifest?.page;
    if (!page?.entry) return null;
    try {
      if (fs.statSync(page.entry).size > MAX_PAGE_BYTES) return { title: page.title, error: '插件页面超过 512KB' };
      return { title: page.title, html: fs.readFileSync(page.entry, 'utf8') };
    } catch (error) {
      return { title: page.title, error: `读不到插件页面：${error?.code || error?.message || error}` };
    }
  }

  async function pageCall(id, method, params) {
    const hit = await registryOf().v3Host(id, 'page');
    if (!hit) throw Object.assign(new Error('插件没有启用或没有页面'), { code: 'E_NOT_FOUND' });
    if (!hit.ready) throw Object.assign(new Error(`插件未在运行（${hit.error || '按需启动失败'}）`), { code: 'E_DOWN' });
    return hit.ready.pageCall(method, params);
  }

  // manifest 里声明的额外请求头（inbound.headers），只有已启用且声明了 inbound 的插件才有
  const headersFor = (id) => {
    const host = registryOf()?.hosts?.get?.(String(id || ''));
    return host?.manifest?.capabilities?.includes('inbound') ? (host.manifest.inbound?.headers || []) : [];
  };
  const inboundHandler = createInboundHandler({ getRegistry: () => ({ inbound, headersFor }), getConfig, log });
  let servers = [];

  return {
    agent,
    inbound,
    pageSource,
    pageCall,
    handleHttp: (req, res) => (String(req.url || '').startsWith(INBOUND_PREFIX) ? inboundHandler.handle(req, res) : false),
    registerRoutes(router, helpers) {
      // 显式取别名而不是解构参数：ops scan 的未定义调用扫描器不认识解构参数（见 console/router.js）
      const json = helpers.json;
      const readBody = helpers.readBody;
      // 页面放进沙箱 iframe（allow-scripts、opaque origin、CSP 断网），按钮只能经 page-rpc 调**它自己**的插件
      router.add('GET', '/api/plugins/page', async (req, res, params, url) => {
        const id = String(url.searchParams.get('id') || '').trim();
        if (!ID_RE.test(id)) return json(res, 400, { ok: false, error: '插件 id 不合法' });
        const page = await pageSource(id);
        if (!page) return json(res, 404, { ok: false, error: '这个插件没有页面，或还没启用' });
        if (page.error) return json(res, 500, { ok: false, error: page.error });
        return json(res, 200, { ok: true, title: page.title, html: page.html });
      });
      router.add('POST', '/api/plugins/page-rpc', async (req, res) => {
        const body = await readBody(req).catch(() => ({}));
        const id = String(body.id || '').trim();
        const method = String(body.method || '');
        if (!ID_RE.test(id)) return json(res, 400, { ok: false, error: '插件 id 不合法' });
        if (!METHOD_RE.test(method)) return json(res, 400, { ok: false, error: 'method 不合法' });
        try {
          const result = await pageCall(id, method, body.params && typeof body.params === 'object' ? body.params : {});
          return json(res, 200, { ok: true, result: result ?? null });
        } catch (error) {
          return json(res, error?.code === 'E_NOT_FOUND' ? 404 : 400, { ok: false, error: String(error?.message ?? error).slice(0, 400) });
        }
      });
    },
    start() { servers = inboundHandler.listen(); },
    async stop() {
      const list = servers;
      servers = [];
      await Promise.all(list.map((s) => s.close().catch(() => {})));
    }
  };
}
