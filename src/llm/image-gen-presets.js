// 图片生成的「服务预设」（对标 TTS / ASR 的服务预设）：把"去哪儿拿免费的图模型"写进控制台，
// 用户选一家就自动填好服务地址与默认模型，不用自己去翻各家文档。
//
// 预设里必须带 shape（请求形状），因为两种形状差很多：
//   · openai       —— POST {base}/images/generations（主流网关与自建都收敛到这个形状）
//   · pollinations —— GET  {base}/prompt/<提示词>?width=&height=（免 Key 的公共服务）
//   · modelscope   —— POST 任务后轮询 GET {base}/tasks/{task_id}（原生异步接口）
// 2026-10-01 实测的坑：pollinations 还有个长得像 OpenAI 的 POST /openai/images/generations，
// 但它**不看 body** —— 两个完全不同的提示词返回逐字节相同的图。照那个接，机器人会"不管你要
// 什么、都画同一张"。所以只认 GET 那条。
//
// creds 为空数组 = 这家不需要 Key（鉴权守卫会放行，见 image-gen.js 的 resolveImageGenAuth）。
//
// 关于"免费"：只有 pollinations 那条是**免注册免 Key**（第三方公共服务，可能限流或随时不可用）；
// 其余几家都要注册拿 Key，是否免费以各家定价页为准 —— 这里只写"去哪拿、地址填什么"。

export const IMAGEGEN_SERVICES = [
  {
    id: 'pollinations',
    label: 'Pollinations（免注册免 Key，免费但带水印）',
    shape: 'pollinations',
    creds: [],
    baseUrl: 'https://image.pollinations.ai',
    hosts: ['image.pollinations.ai'],
    models: [{ id: 'flux' }],
    note: '免注册、免 Key，填好就能画（默认模型 flux）。按官方文档：匿名档是「15 秒 1 次」按 IP 限流，图片带水印；'
      + '登录 auth.pollinations.ai 可提升额度并去水印（需注册，未实测）。'
      + '额度用完会返回空的 HTTP 402（2026-10-01 实测：同一时刻本机出口正常、云服务器出口 402，是按 IP 算的）。'
      + '提示词会经过它的服务器 —— 当作"零配置试玩"，长期用建议换有免费额度的图模型。'
  },
  {
    id: 'zhipu',
    label: '智谱 CogView（cogview-3-flash 免费 / cogview-4 付费）',
    shape: 'openai',
    creds: ['key'],
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    hosts: ['open.bigmodel.cn'],
    keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    models: [
      { id: 'cogview-3-flash' },
      { id: 'cogview-4-250304' }
    ],
    note: '服务地址要填到 /api/paas/v4 这一层，Key 用智谱开放平台的 API Key。'
      + 'cogview-3-flash 免费，但 2026-10-02 实测：**中文文字写不出来**（提示词里的汉字会变成'
      + '乱码假字），做带字表情包不可用；出图右下角带「AI 生成」水印（国内厂商按标识办法统一加）。'
      + 'cogview-4-250304 画面与文字都好、¥0.06/张，但要账户有余额 —— 余额不足会直接报'
      + '「1113 余额不足或无可用资源包，请充值」。'
  },
  {
    id: 'siliconflow',
    label: '硅基流动（含默认 Z-Image-Turbo，中文文字准）',
    shape: 'openai',
    creds: ['key'],
    baseUrl: 'https://api.siliconflow.cn/v1',
    hosts: ['api.siliconflow.cn'],
    keyUrl: 'https://cloud.siliconflow.cn/account/ak',
    // 顺序即默认：切到这家会把「模型」预填成第一个
    models: [
      { id: 'Tongyi-MAI/Z-Image-Turbo' },
      { id: 'Qwen/Qwen-Image' },
      { id: 'Kwai-Kolors/Kolors' }
    ],
    note: '模型名必填（本预设默认 Tongyi-MAI/Z-Image-Turbo）。2026-10-02 真机实测同一提示词：'
      + 'Z-Image-Turbo ¥0.10/张、约 5 秒、**中文文字写得对**、无水印（推荐）；'
      + 'Qwen/Qwen-Image ¥0.30/张、约 13 秒、中文同样准确、画面更精细；'
      + 'Kwai-Kolors/Kolors 免费，但**中文会写错**（实测"事已在吧"），适合不带字的图。'
      + '地址填到 /v1 这一层，Key 用硅基流动的 API Key（与语音转写可以是同一把）。'
  },
  {
    id: 'moss',
    label: 'Moss Image（moss-image-base / sft）',
    shape: 'openai',
    creds: ['key'],
    baseUrl: 'https://api.mosi.cn/v1',
    hosts: ['api.mosi.cn'],
    keyUrl: 'https://platform.mosi.cn',
    models: [
      { id: 'moss-image-base-1.0' },
      { id: 'moss-image-sft-1.0' }
    ],
    note: '服务地址填到 /v1，不要带 /images/generations（适配器会自己拼）。'
      + '官方文档：response_format 只支持 url（不支持 b64_json），n 只能 1，'
      + '请求示例超时给到 900 秒；生成慢时把 imageGen.timeoutMs 调大。'
      + '去水印在「自定义请求参数」填 {"output_watermark": {"enabled": false}}（官方是嵌套对象）。'
  },
  {
    id: 'modelscope',
    label: '魔搭 ModelScope API-Inference（有每日免费额度，需 Token）',
    shape: 'modelscope',
    creds: ['key'],
    baseUrl: 'https://api-inference.modelscope.cn/v1',
    hosts: ['api-inference.modelscope.cn'],
    keyUrl: 'https://modelscope.cn/my/myaccesstoken',
    models: [],
    note: '按公开口径 API-Inference 有每日免费额度（以官网为准）；Token 在「访问令牌」页拿，'
      + '模型名填魔搭上支持推理的图模型 id（必填）。'
  },
  {
    id: 'custom',
    label: '自定义 / 自建（OpenAI 兼容）',
    shape: 'openai',
    creds: ['key'],
    baseUrl: '',
    hosts: [],
    models: [],
    note: '任何 OpenAI 兼容的 POST {服务地址}/images/generations 服务；模型名必填。'
  }
];

/** 按 id 取预设。 */
export function imageGenServiceById(id) {
  const key = String(id || '').trim();
  return IMAGEGEN_SERVICES.find((s) => s.id === key) || null;
}

/** 按服务地址认家（只按主机名比；解析失败返回 null）。 */
export function imageGenServiceOfBaseUrl(url) {
  let host = '';
  try { host = new URL(String(url || '').trim()).host.toLowerCase(); } catch { return null; }
  if (!host) return null;
  return IMAGEGEN_SERVICES.find((s) => (s.hosts || []).includes(host)) || null;
}

/** 这家预设是否需要 Key（creds 为空 = 不需要）。 */
export function imageGenServiceNeedsKey(service) {
  return Boolean(service && Array.isArray(service.creds) && service.creds.length);
}
