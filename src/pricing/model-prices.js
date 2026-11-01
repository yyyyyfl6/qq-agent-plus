// 主流模型官方价格表（用于成本核算）。
//
// 单位统一为：**元 / 每百万 token**（人民币）。
// 美元价格按 1 USD ≈ 7.2 CNY 换算。
//
// 数据核对时间：2026-09-03（联网检索各厂商官方定价页与实时价格聚合站）
//
// 字段：
//   in      输入（未命中缓存）
//   out     输出
//   cached  输入且命中前缀缓存（多数厂商比 in 便宜很多；无缓存优惠的填 null）
//   peak    高峰时段价格（目前仅 DeepSeek 有；时段判定见 isPeakHour）
//   image   图片计费规则（maxTokensPerImage 等；仅视觉模型有）
//   note    备注（口径/促销/阶梯说明）
//
// ── 来源分级（见每条的 src 字段）──
//   'official' = 从厂商官方定价文档 / 价格页直接取到；人民币原价照录，未做汇率换算
//   'derived'  = 官方页面未能直连（Cloudflare 拦截 / 地区限制），
//                依据官方公告与可信转载折算，美元价按 1 USD ≈ 7.2 CNY 换算。
//                这类仅供粗略参考，实际请以厂商官网为准。
//
// ⚠️ 大模型价格变动极快，且促销价、峰谷价、长短上下文价差异很大。
//    走中转站时实际单价通常与官方不同 —— 此时请关闭「使用官方价格」并手填单价。
//
// 匹配方式见 resolveOfficialPrice()：精确 → 去 provider 前缀 → 前缀匹配。

export const OFFICIAL_PRICES = {
  // ══ DeepSeek ══
  // 来源：官方中文文档 https://api-docs.deepseek.com/zh-cn/quick_start/pricing
  //       + https://api-docs.deepseek.com/zh-cn/guides/vision
  //       + 2026-09-11 官方 API 全量实测（模型清单/文本/图片/工具/JSON/音频/图片token计量）
  // 官方直接以人民币标价，原样照录，未做汇率换算。
  //
  // ── 2026-09-11 实测结论（文档多处滞后，以下以实测为准）──
  // · 官方 /models 只返回两个：deepseek-flash、deepseek-v4-pro。
  //   旧名 deepseek-v4-flash / deepseek-v4-flash-vision-exp 仍可调用，但底座已下线，
  //   由 DeepSeek-V4.1-Flash 承接并按 Flash 价计费；deepseek-chat / deepseek-reasoner
  //   实测同样回落 Flash 档（响应体 model 字段均回显 deepseek-flash）。
  // · 图像理解仅 Flash 支持；v4-pro 实测带图返回"无法查看图片内容，请提供文字描述"。
  // · 无音频/视频输入：input_audio 内容块直接 400（unknown variant）。
  // · 上下文 1M；输出上限 384K；并发 flash 2500 / v4-pro 500。
  // · ⚠️ v4-pro 计划下线：北京时间 2026-09-14 12:00 后至 V4.1-Pro 上线前，
  //   deepseek-v4-pro 的请求全部路由到 V4.1-Flash，并按 Flash 价计费。
  //
  // ── 价格（元 / 百万 token；闲时 = 高峰的一半）──
  //   高峰时段：北京时间周一至周五 9:00-12:00、14:00-18:00，其余为闲时。
  //   下表 in/out/cached 取闲时价（日常多数时间的实际费率）。
  //
  // ── 图片计费口径（已按官方文档 + 实测校准，纠正旧表中的 384 封顶错误）──
  //   每张图自动缩放：<约 544×544 保持长宽比放大；更大则缩到约 1300×1300 等效总像素。
  //   单图 token 上限 **1024**（实测：420×160≈188、800×800≈432、2048²与4096²均≈1004）。
  //   多图各自独立计算，无额外合并成本。detail=low 时缩到 512×512，更快更省。
  //   格式 JPEG/PNG/GIF/WebP；单请求最多 600 张；图片只能出现在 user 消息中。
  'deepseek-flash': {
    in: 1, out: 4, cached: 0.02,
    peak: { in: 2, out: 8, cached: 0.04 },
    image: {
      mode: 'capped',
      maxTokensPerImage: 1024,
      note: '自动缩放到约 1300×1300 等效总像素后封顶 1024 token/张（实测 420×160≈188、800×800≈432、≥2048²≈1004）；detail=low 缩到 512×512 更省'
    },
    note: '闲时价；高峰翻倍；DeepSeek-V4.1-Flash；支持思考/非思考双模式、图片理解、工具调用、JSON 输出；1M 上下文 / 384K 输出',
    src: 'official'
  },
  // 旧模型名：底座已下线，请求由 V4.1-Flash 承接，按 Flash 价计费
  'deepseek-v4-flash': {
    in: 1, out: 4, cached: 0.02,
    peak: { in: 2, out: 8, cached: 0.04 },
    image: {
      mode: 'capped',
      maxTokensPerImage: 1024,
      note: '同 deepseek-flash：缩放后封顶 1024 token/张'
    },
    note: '旧模型名（底座已下线，由 V4.1-Flash 承接），按 Flash 价计费；图片/工具/JSON 均可用',
    src: 'official'
  },
  'deepseek-v4-flash-vision-exp': {
    in: 1, out: 4, cached: 0.02,
    peak: { in: 2, out: 8, cached: 0.04 },
    image: {
      mode: 'capped',
      maxTokensPerImage: 1024,
      note: '同 deepseek-flash：缩放后封顶 1024 token/张'
    },
    note: '旧视觉模型名（已下线，由 V4.1-Flash 承接），按 Flash 价计费',
    src: 'official'
  },
  // ⚠️ -0731 是日期快照，能力冻结在 07-31，不随主模型获得图片输入——勿加 image 计费
  'deepseek-v4-flash-0731': { in: 1, out: 4, cached: 0.02, peak: { in: 2, out: 8, cached: 0.04 }, note: '闲时价；高峰翻倍；日期快照版，无图片输入', src: 'official' },
  // 旧别名实测均回落 Flash 档：deepseek-chat 走非思考模式，deepseek-reasoner 走思考模式
  'deepseek-chat': {
    in: 1, out: 4, cached: 0.02,
    peak: { in: 2, out: 8, cached: 0.04 },
    image: { mode: 'capped', maxTokensPerImage: 1024, note: '同 deepseek-flash：缩放后封顶 1024 token/张' },
    note: '旧别名，实测回落 deepseek-flash（非思考模式），按 Flash 价计费；支持图片输入',
    src: 'official'
  },
  'deepseek-reasoner': {
    in: 1, out: 4, cached: 0.02,
    peak: { in: 2, out: 8, cached: 0.04 },
    image: { mode: 'capped', maxTokensPerImage: 1024, note: '同 deepseek-flash：缩放后封顶 1024 token/张' },
    note: '旧别名，实测回落 deepseek-flash（思考模式），按 Flash 价计费；支持图片输入',
    src: 'official'
  },
  'deepseek-v4-pro': {
    in: 4.5, out: 13.5, cached: 0.15,
    peak: { in: 9, out: 27, cached: 0.30 },
    note: '闲时价；高峰翻倍；纯文本（实测带图回"无法查看图片"）；⚠️ 2026-09-14 12:00 后路由到 V4.1-Flash 并按 Flash 价计费',
    src: 'official'
  },
  'deepseek-v4-pro-0813': {
    in: 4.5, out: 13.5, cached: 0.15,
    peak: { in: 9, out: 27, cached: 0.30 },
    note: '闲时价；高峰翻倍；纯文本；日期快照版',
    src: 'official'
  },
  'deepseek-v3.1-terminus': { in: 1, out: 4, cached: 0.02, peak: { in: 2, out: 8, cached: 0.04 }, note: '旧代，取下线价近似（原价 1.5/4.5）', src: 'derived' },
  'deepseek-r1-0528': { in: 4.5, out: 13.5, cached: 0.15, note: '旧代，按 v4-pro 现价近似', src: 'derived' },

  // ══ 智谱 Z.ai / GLM ══
  // 来源：智谱官方价格页 https://open.bigmodel.cn/pricing（2026-09-03 直取），人民币原价。
  // 缓存存储限时免费；带阶梯的取最低档（≤32K 输入）。
  'glm-5.3': { in: 8, out: 28, cached: 2, note: '1M 上下文；缓存存储限时免费', src: 'official' },
  // 促销价（用户实测确认 2026-09-05）：输入 0.4 / 输出 1.4 / 缓存 0.115
  // 原价 0.8/1.4/0.23 —— 输入与缓存五折，输出不打折。
  'glm-5.3-flash': { in: 0.4, out: 1.4, cached: 0.115, note: '促销价；原价 0.8/1.4/0.23（输入与缓存五折，输出不打折）', src: 'official' },
  'glm-5.2': { in: 8, out: 28, cached: 2, note: '1M 上下文', src: 'official' },
  'glm-5.1': { in: 6, out: 24, cached: 1.3, note: '≤32K 档；>32K 为 8/28/2', src: 'official' },
  'glm-5-turbo': { in: 5, out: 22, cached: 1.2, note: '≤32K 档；>32K 为 7/26/1.8', src: 'official' },
  'glm-5': { in: 4, out: 18, cached: 1, note: '≤32K 档；>32K 为 6/22/1.5', src: 'official' },
  'glm-5v-turbo': { in: 5, out: 22, cached: 1.2, image: { mode: 'unknown', note: '支持图片输入，换算规则待补' }, note: '多模态；>32K 为 7/26/1.8', src: 'official' },
  'glm-4.7': { in: 2, out: 8, cached: 0.4, note: '≤32K 且输出<0.2K；其余档更高', src: 'official' },
  'glm-4.7-flash': { in: 0, out: 0, cached: 0, note: '官方免费', src: 'official' },
  'glm-4.7-flashx': { in: 0.5, out: 3, cached: 0.1, note: '200K 上下文', src: 'official' },
  'glm-4.6': { in: 4, out: 16, cached: 0.8, note: '按 4.7 同档近似', src: 'official' },
  'glm-4.5': { in: 4, out: 16, cached: 0.8, note: '按 4.7 同档近似', src: 'official' },
  'glm-4.5-air': { in: 0.8, out: 2, cached: 0.16, note: '≤32K 且输出<0.2K', src: 'official' },
  'glm-4.6v': { in: 1, out: 3, cached: 0.2, image: { mode: 'unknown', note: '支持图片输入，换算规则待补' }, note: '≤32K；32-128K 为 2/6/0.4', src: 'official' },
  'glm-4.6v-flashx': { in: 0.15, out: 1.5, cached: 0.03, image: { mode: 'unknown', note: '支持图片输入，换算规则待补' }, note: '≤32K', src: 'official' },
  'glm-4.5v': { in: 2, out: 6, cached: 0.4, image: { mode: 'unknown', note: '支持图片输入，换算规则待补' }, note: '≤32K；32-64K 为 4/12/0.8', src: 'official' },
  'glm-4-plus': { in: 5, out: 5, cached: null, note: '旧代 GLM-4 系列', src: 'official' },
  'glm-4-long': { in: 1, out: 1, cached: null, note: '旧代，1M 上下文', src: 'official' },
  'glm-4-flash': { in: 0, out: 0, cached: 0, note: '官方免费', src: 'official' },

  // ══ 月之暗面 Kimi / Moonshot ══
  // 来源：月之暗面开放平台公示标准（多来源交叉验证：腾讯云开发者社区对照表、行业报道均一致）。
  // K3 定价偏高：缓存未命中 20 / 输出 100；但官方称编程场景缓存命中率>90%，命中价仅 2。
  'kimi-k3': { in: 20, out: 100, cached: 2, image: { mode: 'unknown', note: '支持图片输入，换算规则待补' }, note: '缓存命中率>90% 时实际成本低得多', src: 'derived' },
  'kimi-k2.7-code': { in: 20, out: 100, cached: 2, note: '编程版，按 K3 档近似', src: 'derived' },
  'kimi-k2.6': { in: 8, out: 32, cached: 1, image: { mode: 'unknown', note: '支持图片输入，换算规则待补' }, note: '旧代，按美元价折算', src: 'derived' },
  'kimi-k2': { in: 4.32, out: 14.4, cached: 0.5, note: '旧代', src: 'derived' },

  // ══ MiniMax ══
  // 来源：MiniMax 官方文档 https://platform.minimaxi.com/docs/guides/pricing-paygo（2026-09-03 直取），人民币原价。
  // M3 标注"永久五折"，下表为折后价；>512K 输入翻倍。优先服务（service_tier=priority）按标准价 1.5 倍计。
  'minimax-m3': { in: 2.1, out: 8.4, cached: 0.42, image: { mode: 'unknown', note: '支持图片输入，换算规则待补' }, note: '≤512K 五折价；>512K 为 4.2/16.8/0.84', src: 'official' },
  'minimax-m2.7': { in: 2.1, out: 8.4, cached: 0.42, note: '缓存写入 2.625', src: 'official' },
  'minimax-m2.7-highspeed': { in: 4.2, out: 16.8, cached: 0.42, note: '高速版，缓存写入 2.625', src: 'official' },
  'minimax-m2.5': { in: 2.1, out: 8.4, cached: 0.21, note: '缓存写入 2.625', src: 'official' },
  'minimax-m2.5-highspeed': { in: 4.2, out: 16.8, cached: 0.21, note: '高速版', src: 'official' },
  'minimax-m2.1': { in: 2.1, out: 8.4, cached: 0.21, note: '缓存写入 2.625', src: 'official' },
  'minimax-m2.1-highspeed': { in: 4.2, out: 16.8, cached: 0.21, note: '高速版', src: 'official' },
  'minimax-m2': { in: 2.1, out: 8.4, cached: 0.21, note: '缓存写入 2.625', src: 'official' },
  'minimax-m1': { in: 2.1, out: 8.4, cached: 0.21, note: '旧代，按现价近似', src: 'official' },

  // ══ 小米 MiMo ══
  // 来源：小米官方定价（对标高通 DeepSeek 同档）+ 带真实账单的公开对照表交叉验证。
  // 注意：缓存命中价极低（0.02~0.075），是编码场景省钱关键；UltraSpeed 为 Pro 版 3 倍价。
  'mimo-v2.5': { in: 1.0, out: 2.0, cached: 0.02, image: { mode: 'unknown', note: '支持图片输入，换算规则待补' }, note: '对标 DeepSeek V4-Flash 同档', src: 'derived' },
  'mimo-v2.5-pro': { in: 3.0, out: 6.0, cached: 0.025, image: { mode: 'unknown', note: '支持图片输入，换算规则待补' }, note: '对标 DeepSeek V4-Pro 同档', src: 'derived' },
  'mimo-v2.5-pro-ultraspeed': { in: 9.0, out: 18.0, cached: 0.075, note: '极速版，为 Pro 版 3 倍价', src: 'derived' },
  'mimo-v2.5-flash': { in: 0.72, out: 2.16, cached: null, note: '轻量档，按美元价折算（$0.10/$0.30）', src: 'derived' },

  // ══ 阿里通义千问 ══
  // ⚠️ 阿里云百炼的价格表在需登录的「模型广场」内，公开文档只有能力清单，
  //    故以下为美元公开报价按 7.2 折算，属 derived；人民币实际价以百炼控制台为准。
  //    当前推荐主力（官方能力清单 2026-09-03）：qwen3.8-max / qwen3.8-flash / qwen3.7-plus / qwen3.7-flash
  'qwen3.8-max': { in: 14.4, out: 43.2, cached: 3.6, image: { mode: 'pixel', divisor: 1024, base: 2, maxPixels: 16000000, note: 'h×w/1024+2，上限 1600 万像素/图' }, note: '1M 上下文；旗舰档', src: 'derived' },
  'qwen3.8-max-0902': { in: 14.4, out: 43.2, cached: 3.6, image: { mode: 'pixel', divisor: 1024, base: 2, maxPixels: 16000000, note: 'h×w/1024+2，上限 1600 万像素/图' }, note: '1M 上下文', src: 'derived' },
  'qwen3.8-flash': { in: 0.94, out: 3.1, cached: 0.115, image: { mode: 'pixel', divisor: 1024, base: 2, maxPixels: 16000000, note: 'h×w/1024+2，上限 1600 万像素/图' }, note: '1M 上下文；轻量主力（$0.13/$0.43）', src: 'derived' },
  'qwen3.7-max': { in: 9, out: 27, cached: null, image: { mode: 'unknown', note: '支持图片输入，换算规则待补' }, note: '按 $1.25/$3.75 折算', src: 'derived' },
  'qwen3.7-plus': { in: 2.3, out: 9, cached: 0.23, image: { mode: 'pixel', divisor: 1024, base: 2, maxPixels: 16000000, note: 'h×w/1024+2，上限 1600 万像素/图' }, note: '1M 上下文；均衡主力（$0.32/$1.25）', src: 'derived' },
  'qwen3.7-plus-2026-05-26': { in: 2.3, out: 9, cached: 0.23, image: { mode: 'unknown', note: '支持图片输入，换算规则待补' }, note: '快照版', src: 'derived' },
  'qwen3.7-flash': { in: 0.29, out: 1.15, cached: null, image: { mode: 'pixel', divisor: 1024, base: 2, maxPixels: 16000000, note: 'h×w/1024+2，上限 1600 万像素/图' }, note: '1M 上下文（$0.04/$0.16）', src: 'derived' },
  'qwen3.6-flash': { in: 1.37, out: 8.14, cached: 0.137, image: { mode: 'pixel', divisor: 1024, base: 2, maxPixels: 16000000, note: 'h×w/1024+2，上限 1600 万像素/图' }, note: '按 $0.19/$1.13 折算', src: 'derived' },
  'qwen3.5-plus': { in: 2.88, out: 12.96, cached: null, image: { mode: 'unknown', note: '支持图片输入，换算规则待补' }, note: '旧代', src: 'derived' },
  'qwen3.5-397b-a17b': { in: 4.32, out: 25.92, cached: null, note: '开源大尺寸', src: 'derived' },
  'qwen3-235b-a22b': { in: 1.44, out: 5.76, cached: null, note: '开源', src: 'derived' },
  'qwen3-235b-a22b-thinking-2507': { in: 2.16, out: 21.6, cached: null, note: '思考版', src: 'derived' },
  'qwen3-coder-plus': { in: 4, out: 20, cached: null, note: '编程版，≤32K 档', src: 'derived' },
  'qwen-plus': { in: 5.76, out: 14.4, cached: null, note: '旧代', src: 'derived' },
  'qwen-max': { in: 14.4, out: 43.2, cached: null, note: '映射到 3.8-Max 档', src: 'derived' },
  'qwen-flash': { in: 0.29, out: 1.15, cached: null, note: '映射到 3.7-Flash 档', src: 'derived' },
  'qwen-turbo': { in: 2.16, out: 4.32, cached: null, note: '旧代', src: 'derived' },
  'qwen-long': { in: 3.6, out: 14.4, cached: null, note: '10M 上下文', src: 'derived' },

  // ══ 腾讯混元 ══
  // 来源：腾讯云官方文档 https://cloud.tencent.com/document/product/1729/97731（2026-06-26 更新），人民币刊例价。
  'hunyuan-a13b': { in: 0.5, out: 2, cached: null, note: '腾讯云刊例价', src: 'official' },
  'hunyuan-role-latest': { in: 2.4, out: 9.6, cached: null, note: '腾讯云刊例价', src: 'official' },
  'hunyuan-translation': { in: 1.2, out: 3.6, cached: null, note: '翻译模型', src: 'official' },
  'hunyuan-translation-lite': { in: 1, out: 3, cached: null, note: '翻译轻量版', src: 'official' },
  'hunyuan-embedding': { in: 0.7, out: 0.7, cached: null, note: '向量模型', src: 'official' },
  // Hy 系列：腾讯云开发者社区对照表（广州地域在线推理按量价，2026 年）
  'hy4-preview': { in: 6, out: 18, cached: 0.3, note: '960K 输入 / 64K 输出', src: 'derived' },
  'hy3': { in: 1.15, out: 4.6, cached: 0.29, note: '262K 上下文，按美元价折算（$0.16/$0.64）', src: 'derived' },
  'hunyuan': { in: 0.5, out: 2, cached: null, note: '映射到 a13b 档（腾讯云官方刊例）', src: 'official' },

  // ══ 字节豆包 ══
  'doubao-pro': { in: 3.2, out: 7.2, cached: null, note: '旗舰档', src: 'derived' },
  'doubao-lite': { in: 0.54, out: 1.44, cached: null, note: '轻量档', src: 'derived' },

  // ══ 百度文心 ══
  'ernie-5.0': { in: 8.64, out: 25.92, cached: null, note: '旗舰档', src: 'derived' },
  'ernie-4.5': { in: 2.88, out: 8.64, cached: null, note: '旧代', src: 'derived' },

  // ══ OpenAI GPT-5.6 系列 ══
  // 促销价（至少持续到 2026-11-21）：短上下文 / 长上下文(>272K) 双档
  'gpt-5.6-sol': { in: 28.8, out: 144, cached: 2.88, image: { mode: 'unknown', note: '支持图片输入，换算规则待补' }, note: '促销价；长上下文 57.6/216', src: 'derived' },
  'gpt-5.6-terra': { in: 14.4, out: 86.4, cached: 1.44, image: { mode: 'unknown', note: '支持图片输入，换算规则待补' }, note: '促销价；长上下文 28.8/129.6', src: 'derived' },
  'gpt-5.6-luna': { in: 1.44, out: 8.64, cached: 0.14, image: { mode: 'unknown', note: '支持图片输入，换算规则待补' }, note: '促销价；长上下文 2.88/12.96', src: 'derived' },
  'gpt-5.6-cyber': { in: 90, out: 540, cached: 9, note: 'Daybreak 计划', src: 'derived' },
  'gpt-5.5': { in: 36, out: 216, cached: 3.6, image: { mode: 'unknown', note: '支持图片输入，换算规则待补' }, note: '旧代旗舰', src: 'derived' },
  'gpt-5.5-pro': { in: 216, out: 1296, cached: null, note: 'Pro 档', src: 'derived' },
  'gpt-5.4': { in: 18, out: 108, cached: 1.8, image: { mode: 'unknown', note: '支持图片输入，换算规则待补' }, note: '旧代', src: 'derived' },
  'gpt-5.4-mini': { in: 5.4, out: 32.4, cached: 0.54, note: '旧代', src: 'derived' },
  'gpt-5.4-nano': { in: 1.44, out: 9, cached: 0.14, note: '旧代', src: 'derived' },
  'gpt-5.2': { in: 12.6, out: 100.8, cached: null, note: '旧代', src: 'derived' },
  'gpt-5.1': { in: 9, out: 72, cached: null, note: '旧代', src: 'derived' },
  'gpt-5': { in: 9, out: 72, cached: null, note: '旧代', src: 'derived' },
  'gpt-5-mini': { in: 1.8, out: 14.4, cached: null, note: '旧代', src: 'derived' },
  'gpt-5-nano': { in: 0.36, out: 2.88, cached: null, note: '旧代', src: 'derived' },
  'gpt-4.1': { in: 14.4, out: 57.6, cached: 2.88, image: { mode: 'unknown', note: '支持图片输入，换算规则待补' }, note: '旧代', src: 'derived' },
  'gpt-4.1-mini': { in: 2.88, out: 11.52, cached: 0.58, note: '旧代', src: 'derived' },
  'gpt-4.1-nano': { in: 0.72, out: 2.88, cached: 0.14, note: '旧代', src: 'derived' },
  'gpt-4o': { in: 18, out: 72, cached: null, image: { mode: 'unknown', note: '支持图片输入，换算规则待补' }, note: '旧代', src: 'derived' },
  'gpt-4o-mini': { in: 1.08, out: 4.32, cached: null, image: { mode: 'unknown', note: '支持图片输入，换算规则待补' }, note: '旧代', src: 'derived' },
  'gpt-oss-120b': { in: 0.22, out: 1.22, cached: null, note: '开源权重', src: 'derived' },
  'gpt-oss-20b': { in: 0.14, out: 0.72, cached: null, note: '开源权重', src: 'derived' },

  // ══ Anthropic Claude ══
  'claude-fable-5.1': { in: 72, out: 360, cached: 1.8, image: { mode: 'unknown', note: '支持图片输入，换算规则待补' }, note: '缓存读已降 75%', src: 'derived' },
  'claude-mythos-5.1': { in: 72, out: 360, cached: 1.8, note: '受限供应', src: 'derived' },
  'claude-fable-5': { in: 72, out: 360, cached: 7.2, note: '旧版缓存贵 4 倍', src: 'derived' },
  'claude-mythos-5': { in: 72, out: 360, cached: 7.2, note: '受限供应', src: 'derived' },
  'claude-opus-5': { in: 36, out: 180, cached: 3.6, image: { mode: 'unknown', note: '支持图片输入，换算规则待补' }, note: '1M 上下文，无长上下文档附加费', src: 'derived' },
  'claude-opus-4.8': { in: 36, out: 180, cached: 3.6, note: '旧代旗舰', src: 'derived' },
  'claude-opus-4.7': { in: 36, out: 180, cached: 3.6, note: '旧代', src: 'derived' },
  'claude-opus-4.6': { in: 36, out: 180, cached: 3.6, note: '旧代', src: 'derived' },
  'claude-opus-4.5': { in: 36, out: 180, cached: 3.6, note: '旧代', src: 'derived' },
  'claude-opus-4.1': { in: 108, out: 540, cached: null, note: '已退役', src: 'derived' },
  'claude-sonnet-5': { in: 14.4, out: 72, cached: 1.44, image: { mode: 'unknown', note: '支持图片输入，换算规则待补' }, note: '促销价已转正', src: 'derived' },
  'claude-sonnet-4.6': { in: 21.6, out: 108, cached: 2.16, note: '旧代', src: 'derived' },
  'claude-haiku-4.5': { in: 7.2, out: 36, cached: 0.72, image: { mode: 'unknown', note: '支持图片输入，换算规则待补' }, note: '最便宜', src: 'derived' },
  'claude-haiku-4.5-batch': { in: 3.6, out: 18, cached: 0.36, note: 'Batch 五折', src: 'derived' },

  // ══ Google Gemini ══
  // 3.6/3.7/3.8 Flash 三档同价，属促销价，2027-01-01 起翻倍
  'gemini-3.8-flash': { in: 5.4, out: 27, cached: 0.54, image: { mode: 'unknown', note: '支持图片输入，换算规则待补' }, note: '促销价至 2026-12-31', src: 'derived' },
  'gemini-3.7-flash': { in: 5.4, out: 27, cached: 0.54, image: { mode: 'unknown', note: '支持图片输入，换算规则待补' }, note: '促销价至 2026-12-31', src: 'derived' },
  'gemini-3.6-flash': { in: 5.4, out: 27, cached: 0.54, image: { mode: 'unknown', note: '支持图片输入，换算规则待补' }, note: '促销价至 2026-12-31', src: 'derived' },
  'gemini-3.5-flash': { in: 10.8, out: 64.8, cached: 1.08, note: '原价档', src: 'derived' },
  'gemini-3.5-flash-lite': { in: 2.16, out: 18, cached: 0.22, note: '轻量档', src: 'derived' },
  'gemini-3.1-pro': { in: 14.4, out: 86.4, cached: 1.44, image: { mode: 'unknown', note: '支持图片输入，换算规则待补' }, note: '≤200K；>200K 翻倍', src: 'derived' },
  'gemini-3.1-flash-lite': { in: 1.8, out: 10.8, cached: 0.18, note: '预览', src: 'derived' },
  'gemini-3-flash': { in: 3.6, out: 21.6, cached: 0.36, note: '预览', src: 'derived' },
  'gemini-2.5-pro': { in: 9, out: 72, cached: 0.9, image: { mode: 'unknown', note: '支持图片输入，换算规则待补' }, note: '旧代', src: 'derived' },
  'gemini-2.5-flash': { in: 2.16, out: 18, cached: 0.22, image: { mode: 'unknown', note: '支持图片输入，换算规则待补' }, note: '旧代', src: 'derived' },
  'gemini-2.5-flash-lite': { in: 0.72, out: 2.88, cached: 0.07, note: '旧代', src: 'derived' },

  // ══ xAI Grok ══
  'grok-4.6': { in: 14.4, out: 43.2, cached: 3.6, image: { mode: 'unknown', note: '支持图片输入，换算规则待补' }, note: '≥200K 输入翻倍', src: 'derived' },
  'grok-4.5': { in: 21.6, out: 64.8, cached: null, image: { mode: 'unknown', note: '支持图片输入，换算规则待补' }, note: '旧代', src: 'derived' },
  'grok-4': { in: 21.6, out: 64.8, cached: null, note: '旧代', src: 'derived' },

  // ══ Meta ══
  'muse-spark-1.3': { in: 9, out: 30.6, cached: null, note: 'Contributor 档 0.72/1.44', src: 'derived' },
  'muse-spark-1.2': { in: 9, out: 30.6, cached: null, note: 'Contributor 档 0.72/1.44', src: 'derived' },
  'muse-spark-1.1': { in: 9, out: 30.6, cached: null, note: '旧代', src: 'derived' },
  'llama-4-maverick': { in: 1.44, out: 5.01, cached: null, note: '开源权重', src: 'derived' },
  'llama-3.3-70b': { in: 1.44, out: 1.44, cached: null, note: '开源权重', src: 'derived' },

  // ══ 其他海外 ══
  'mistral-large-3': { in: 3.6, out: 10.8, cached: null, note: '', src: 'derived' },
  'mistral-medium-3.5': { in: 10.8, out: 54, cached: null, note: '', src: 'derived' },
  'command-a': { in: 18, out: 72, cached: null, note: 'Cohere', src: 'derived' },
  'nemotron-3-ultra': { in: 4.32, out: 25.92, cached: null, note: 'NVIDIA', src: 'derived' },
  'nemotron-3.5-lightning': { in: 0, out: 0, cached: null, note: '免费额度', src: 'derived' },
  'solar-pro-4': { in: 0.22, out: 0.86, cached: 0.043, note: 'Upstage', src: 'derived' },
  'step-3.7-flash': { in: 1.15, out: 6.62, cached: null, note: '阶跃星辰', src: 'derived' },
  'longcat-2.0': { in: 2.16, out: 8.64, cached: null, note: '美团；促销 0.3/1.2', src: 'derived' },
  'ling-3.0-flash': { in: 0.15, out: 0.45, cached: 0.029, note: 'InclusionAI', src: 'derived' },
  'granite-4.0-h-micro': { in: 0.12, out: 0.81, cached: null, note: 'IBM；最便宜付费档', src: 'derived' }
};

/* ══════════════════════════════════════════════════════════════
   模型 id 归一化 → 别名 → 价格表

   渠道给模型起的名字五花八门：deepseek/deepseek-v4.1-flash、
   deepseek-v4-flash-0731、glm-5.3-flash:free、kimi-k3-preview……
   价格表只认自己的条目名，所以查价前先展开成一串候选名（带可信度），
   再依次尝试：别名 → 表内精确 → 前缀匹配。查不到就是"未定价"，
   由调用方标记出来，绝不能当成 0 元悄悄过掉。
   ══════════════════════════════════════════════════════════════ */

/**
 * 显式别名：渠道常用名 → 价格表条目名。
 * 一条一行，加名字不用动价格；远程价格表也能带 aliases（远程赢）。
 */
export const MODEL_ALIASES = {
  // 聚合站对新版 DeepSeek 用点号写法；表里 V4.1-Flash 的条目名是 deepseek-flash
  'deepseek-v4.1-flash': 'deepseek-flash',
  'deepseek-v4.1-flash-0731': 'deepseek-flash',
  'deepseek-v41-flash': 'deepseek-flash',
  // 带时间区间的别名：某天起官方把 v4-pro 路由到 V4.1-Flash 并按 Flash 价计费。
  // 之前的历史调用仍按 v4-pro 自己的价（表里那条）算，不会算错。
  'deepseek-v4-pro': {
    to: 'deepseek-flash',
    from: '2026-09-14T12:00:00+08:00',
    note: '该日起路由到 V4.1-Flash，按 Flash 价计费'
  }
};

/**
 * 别名的时间边界：没写 = 0（这一侧不设边界）；写了解析不出来 = null。
 * 不能把解析失败当成"没写边界" —— until 写错的别名会永不失效、from 写错的会回溯到
 * 全部历史，两种都是拿错价算钱，所以解析失败时整条别名作废（FAIL_CLOSED）。
 */
function parseAliasTime(value) {
  if (value === undefined || value === null || String(value).trim() === '') return 0;
  const t = Date.parse(String(value));
  return Number.isFinite(t) ? t : null;
}

/**
 * 解析别名在某个时刻指向谁：
 *   - 字符串 = 永久别名
 *   - { to, from?, until? } = 只在区间内生效（历史成本要按当时的规则算）
 * 传 at（调用时刻）时严格判定；不传时只排除"已经过期"的别名（界面预览场景）。
 */
export function aliasTargetAt(value, at = 0) {
  if (!value) return '';
  const t = Number(at) || 0;
  if (typeof value === 'string') return value.trim();
  if (typeof value !== 'object') return '';
  const to = String(value.to || '').trim();
  if (!to) return '';
  const from = parseAliasTime(value.from);
  const until = parseAliasTime(value.until);
  if (from === null || until === null) return '';
  if (from) {
    const ref = t || Date.now();
    if (ref < from) return '';
  }
  if (until) {
    const ref = t || Date.now();
    if (ref >= until) return '';
  }
  return to;
}

/** 只是"叫法"、不影响型号判断的后缀：去掉再查。 */
const COSMETIC_SUFFIXES = [
  ':free', ':beta', ':latest', '-free', '-beta', '-latest',
  '-preview', '-exp', '-experimental',
  '-thinking', '-nothink', '-nonthinking', '-non-thinking'
];

/** 日期快照后缀：-0731 / -20260101。 */
const DATE_SUFFIX = /-(?:\d{4}|\d{6}|\d{8})$/;

/**
 * 展开一个 model id 的候选名，按可信度从高到低：
 *   exact      —— 原样 / 去掉渠道前缀后的名字
 *   normalized —— 去掉叫法后缀、日期快照后缀
 *   fuzzy      —— 点号版本归并（v4.1 → v4）、点号转连字符
 * 只做名字层面的变换，不猜型号。
 */
export function modelIdCandidates(modelId) {
  const raw = String(modelId ?? '').trim().toLowerCase();
  if (!raw) return [];
  const out = [];
  const push = (id, confidence, via) => {
    if (id && !out.some((c) => c.id === id)) out.push({ id, confidence, via });
  };

  push(raw, 'exact', '');
  const bare = raw.includes('/') ? raw.slice(raw.indexOf('/') + 1) : raw;
  if (bare !== raw) push(bare, 'exact', '去渠道前缀');

  for (const base of [raw, bare]) {
    let id = base;
    for (const suffix of COSMETIC_SUFFIXES) {
      if (id.endsWith(suffix) && id.length > suffix.length) id = id.slice(0, -suffix.length);
    }
    if (id !== base) push(id, 'normalized', '去掉叫法后缀');
    const noDate = id.replace(DATE_SUFFIX, '');
    if (noDate !== id) push(noDate, 'normalized', '去掉日期快照后缀');
  }

  for (const cand of [...out]) {
    const minor = cand.id.replace(/v(\d+)\.(\d+)/g, 'v$1');
    if (minor !== cand.id) push(minor, 'fuzzy', '点号版本归并');
    const dashed = cand.id.replace(/\./g, '-');
    if (dashed !== cand.id) push(dashed, 'fuzzy', '点号转连字符');
  }
  return out;
}

/**
 * 在一张"id → 条目"的表里匹配模型（表用普通对象，方便直接喂内置/远程表）。
 * 候选顺序即优先级：别名 → 精确 → 归一化 → 模糊 → 前缀匹配。
 * 返回条目副本并带上 matched / confidence / via，取不到返回 null。
 */
function matchModelId(modelId, table, aliases, at = 0) {
  const candidates = modelIdCandidates(modelId);
  const keys = Object.keys(table || {});
  if (!candidates.length || !keys.length) return null;

  for (const cand of candidates) {
    const alias = aliasTargetAt(aliases[cand.id], at);
    if (alias && table[alias]) {
      const ranged = typeof aliases[cand.id] === 'object';
      return {
        ...table[alias],
        matched: alias,
        confidence: 'alias',
        via: `${cand.id} → ${alias}${ranged ? '（按该时段的别名规则）' : ''}`
      };
    }
    if (table[cand.id]) {
      return { ...table[cand.id], matched: cand.id, confidence: cand.confidence, via: cand.via };
    }
  }

  // 前缀匹配兜底：z-ai/glm-5.3-insider → glm-5.3（取最长匹配，避免 glm-5 抢先命中 glm-5.3）
  for (const cand of candidates) {
    let best = null;
    for (const key of keys) {
      if (
        cand.id === key
        || cand.id.startsWith(key + '/') || cand.id.startsWith(key + '-')
        || cand.id.startsWith(key + '@') || cand.id.startsWith(key + ':')
      ) {
        if (!best || key.length > best.length) best = key;
      }
    }
    if (best) return { ...table[best], matched: best, confidence: 'prefix', via: '前缀匹配' };
  }
  return null;
}

/**
 * 按模型 id 查官方价格。
 * 查不到返回 null —— 调用方按"未定价"处理（不要当成 0 元）。
 */
export function resolveOfficialPrice(modelId, options = {}) {
  return matchModelId(modelId, EFFECTIVE_PRICES, EFFECTIVE_ALIASES, Number(options.at) || 0);
}

/* ══════════════════════════════════════════════════════════════
   远程价格表（自托管 JSON，按 id 覆盖内置表）
   ══════════════════════════════════════════════════════════════

   内置表 OFFICIAL_PRICES 保持只读、随版本发布；
   远程表由 src/pricing/price-feed.js 拉取/校验后经 setRemotePrices 注入，
   与内置表**按模型 id 合并**（远程赢），内置表其余条目仍是兜底。
   查价时走 EFFECTIVE_PRICES —— 合并结果在注入时重建一次，
   不在每次查价时临时拼（用量统计要逐条解析几百次）。
   别名同理：远程 aliases 覆盖内置 MODEL_ALIASES。
*/
let REMOTE_OVERRIDES = {};                 // { 模型id(小写): 条目 }
let EFFECTIVE_PRICES = OFFICIAL_PRICES;    // 内置 + 远程的合并视图
let REMOTE_ALIASES = {};                   // { 渠道叫法: 表内条目名 }
let EFFECTIVE_ALIASES = MODEL_ALIASES;     // 内置 + 远程的合并视图

/** 注入远程价格表（已校验的条目）与别名。传 {} 即退回纯内置表。 */
export function setRemotePrices(map, aliases = null) {
  REMOTE_OVERRIDES = (map && typeof map === 'object') ? map : {};
  EFFECTIVE_PRICES = Object.keys(REMOTE_OVERRIDES).length
    ? { ...OFFICIAL_PRICES, ...REMOTE_OVERRIDES }
    : OFFICIAL_PRICES;

  const nextAliases = {};
  if (aliases && typeof aliases === 'object' && !Array.isArray(aliases)) {
    for (const [from, to] of Object.entries(aliases)) {
      const key = String(from ?? '').trim().toLowerCase();
      if (!key) continue;
      // 字符串 = 永久别名；对象 = 带时间区间（{ to, from?, until?, note? }）
      if (typeof to === 'string') {
        const value = to.trim().toLowerCase();
        if (value && key !== value) nextAliases[key] = value;
        continue;
      }
      if (to && typeof to === 'object') {
        const value = String(to.to ?? '').trim().toLowerCase();
        if (!value || key === value) continue;
        const entry = { to: value };
        if (to.from) entry.from = String(to.from);
        if (to.until) entry.until = String(to.until);
        if (to.note) entry.note = String(to.note);
        nextAliases[key] = entry;
      }
    }
  }
  REMOTE_ALIASES = nextAliases;
  EFFECTIVE_ALIASES = Object.keys(REMOTE_ALIASES).length
    ? { ...MODEL_ALIASES, ...REMOTE_ALIASES }
    : MODEL_ALIASES;
}

/** 当前生效的远程覆盖条目数（状态展示用）。 */
export function remoteOverrideCount() {
  return Object.keys(REMOTE_OVERRIDES).length;
}

/** 这个条目是不是远程表覆盖进来的（用于把来源标成"远程表"而不是"内置官方价"）。 */
export function isRemoteEntry(id) {
  const key = String(id ?? '').trim().toLowerCase();
  return Boolean(key) && Object.prototype.hasOwnProperty.call(REMOTE_OVERRIDES, key);
}

/** 当前生效的别名表（内置 + 远程），给界面/接口展示用。 */
export function listModelAliases() {
  return { ...EFFECTIVE_ALIASES };
}

/* ══════════════════════════════════════════════════════════════
   渠道价目表（每渠道一份，见 src/pricing/channel-prices.js）

   用户自己那家渠道公布/拉到的价目，按渠道分开存：
       CHANNEL_PRICES = { [渠道名]: { [模型id]: { in, out, cached } } }
   它在查价链里排在"用户手填的渠道价"之后、"用户手填的通用价"之前 ——
   渠道身份比通用模型身份更具体，而用户手填永远可以覆盖它。
   ══════════════════════════════════════════════════════════════ */
let CHANNEL_PRICES = {};

/** 注入某个渠道的价目（传 null/{} 即撤掉）。 */
export function setChannelPrices(vendor, prices) {
  const key = String(vendor || '').trim();
  if (!key) return;
  const table = (prices && typeof prices === 'object' && Object.keys(prices).length) ? prices : null;
  if (table) CHANNEL_PRICES[key] = table;
  else delete CHANNEL_PRICES[key];
}

/** 某个渠道的价目条数（状态展示/测试用）。 */
export function channelPriceCount(vendor) {
  return Object.keys(CHANNEL_PRICES[String(vendor || '').trim()] || {}).length;
}

/** 列出全部价格条目（给设置页展示/提示用）。远程覆盖的条目带 remote:true。 */
export function listOfficialPrices() {
  return Object.entries(EFFECTIVE_PRICES).map(([id, p]) => (
    Object.prototype.hasOwnProperty.call(REMOTE_OVERRIDES, id)
      ? { id, ...p, remote: true }
      : { id, ...p }
  ));
}

/**
 * 峰谷分时计价（DeepSeek 自 2026-08-16 起实行，其他厂商暂无此机制）。
 *
 * 官方规则原文：
 *   高峰时段 = 北京时间周一至周五 09:00-12:00、14:00-18:00
 *   其余时间（含整个周末）为闲时
 *   闲时价 = 高峰价的一半
 *
 * 之所以要单独处理：如果全按闲时价估算，会明显低估实际支出；
 * 全按高峰价又会高估。正确做法是**按每笔调用发生的时间分别取价**。
 */

// 高峰时段（北京时间）。weekday: 1=周一 … 5=周五；0/6 为周末，全天闲时。
export const PEAK_WINDOWS = [
  { from: 9, to: 12 },
  { from: 14, to: 18 }
];

// 目标时区相对 UTC 的小时偏移（北京 = UTC+8）。做成常量便于未来扩展其他厂商时区。
const PEAK_TZ_OFFSET_HOURS = 8;

/**
 * 判断某个时刻是否处于高峰时段。
 * @param {number|Date} at 时间戳（毫秒）或 Date；不传则用当前时间
 * @returns {boolean}
 */
export function isPeakHour(at = Date.now()) {
  const d = at instanceof Date ? at : new Date(Number(at) || Date.now());
  // 换算到目标时区的"本地小时"
  const localHour = (d.getUTCHours() + PEAK_TZ_OFFSET_HOURS) % 24;
  const wd = d.getUTCDay();
  // 周六(6)、周日(0) 全天闲时
  if (wd === 0 || wd === 6) return false;
  return PEAK_WINDOWS.some((w) => localHour >= w.from && localHour < w.to);
}

/**
 * 按时刻取对应档位的价格。
 * 没有 peak 字段的模型（绝大多数）峰谷同价，直接返回基础价。
 * @returns {{in:number, out:number, cached:number, peak:boolean}}
 */
export function priceAt(price, at = Date.now()) {
  const peak = isPeakHour(at);
  if (peak && price?.peak) {
    return {
      in: Number(price.peak.in) || Number(price.in) || 0,
      out: Number(price.peak.out) || Number(price.out) || 0,
      cached: price.peak.cached == null
        ? (price.cached == null ? Number(price.peak.in) || 0 : Number(price.cached) || 0)
        : Number(price.peak.cached) || 0,
      peak: true
    };
  }
  return {
    in: Number(price?.in) || 0,
    out: Number(price?.out) || 0,
    cached: price?.cached == null ? Number(price?.in) || 0 : Number(price.cached) || 0,
    peak: false
  };
}

/**
 * 对一批用量按各自发生时间分别计价后汇总。
 * 用于历史统计：每个会话都有 startedAt，逐条判定峰谷才准。
 *
 * @param {Array<{promptTokens,completionTokens,cachedTokens,at}>} rows
 * @param {object} price 价格条目
 * @returns {{cost:number, peakCost:number, offPeakCost:number, peakTokens:number, offPeakTokens:number}}
 */
export function sumCostByTime(rows, price) {
  let cost = 0, peakCost = 0, offPeakCost = 0, peakTokens = 0, offPeakTokens = 0;
  for (const r of rows || []) {
    const p = priceAt(price, r.at);
    const prompt = Number(r.promptTokens) || 0;
    const completion = Number(r.completionTokens) || 0;
    const cached = Math.min(Number(r.cachedTokens) || 0, prompt);
    const fresh = Math.max(0, prompt - cached);
    const c = (fresh / 1_000_000) * p.in + (cached / 1_000_000) * p.cached + (completion / 1_000_000) * p.out;
    cost += c;
    // 峰谷归属按"调用发生在哪个时段"判定，而不是按模型是否分档。
    // 否则一个无峰谷模型（如 GLM）在高峰时段花的钱会被算进闲时，
    // 用户看到的"高峰花了多少"就失真了。
    if (isPeakHour(r.at)) {
      peakCost += c;
      peakTokens += prompt + completion;
    } else {
      offPeakCost += c;
      offPeakTokens += prompt + completion;
    }
  }
  return { cost, peakCost, offPeakCost, peakTokens, offPeakTokens };
}

/**
 * 计算一张图片折算成多少输入 token。
 *
 * 各厂商规则差异极大 —— 有的按张封顶，有的按像素算，差可达十几倍：
 *   - DeepSeek 视觉版：缩放到约 1300×1300 等效总像素后**按张封顶 1024 token**
 *     （实测 420×160≈188、800×800≈432、≥2048²≈1004；detail=low 更省）
 *   - 千问（百炼）：**按像素** h×w/1024 + 2，上限 1600 万像素/图
 *     4096×4096 的图 → 15627 token，是 DeepSeek 封顶值的十几倍
 *
 * @param {object} price 价格条目（取其 image 字段）
 * @param {number} width  图片宽（像素），可省略（capped 模式不需要）
 * @param {number} height 图片高（像素），可省略
 * @returns {number|null} token 数；该模型不支持图片则返回 null
 */
export function imageTokens(price, width, height) {
  const img = price?.image;
  if (!img) return null;

  // 按张封顶：无论原图多大，都是固定值（内部已缩放）
  if (img.mode === 'capped') return Number(img.maxTokensPerImage) || 0;

  // 按像素：h × w / divisor + base，像素数先按上限截断
  if (img.mode === 'pixel') {
    const divisor = Number(img.divisor) || 1024;
    const base = Number(img.base) || 0;
    const maxPx = Number(img.maxPixels) || 0;
    if (!width || !height) return null;   // 没给尺寸算不了
    let px = Number(width) * Number(height);
    if (maxPx) px = Math.min(px, maxPx);
    return Math.floor(px / divisor) + base;
  }

  // 只知道"有图片计费"但没给公式：给个保守提示值
  if (img.maxTokensPerImage) return Number(img.maxTokensPerImage) || 0;
  return null;
}

/** 该模型是否支持图片输入（有 image 规则即视为支持）。 */
export function supportsImage(price) {
  return Boolean(price?.image);
}

/**
 * 模型价格的统一解析入口。
 *
 * ── 第 10 条原则：成本只与"实际调用的模型"有关，与"当前选择的模型"无关 ──
 * 历史统计里每次调用都会带上它自己的 model（网关返回的真名），
 * 逐条解析各自的价格，而不是拿当前配置里的模型去套所有调用。
 *
 * 优先级（从高到低）：
 *   1. 用户在「模型 API → 成本核算」为**该模型**单独设定的价格（cfg.modelPrices）
 *      —— 一旦设定就用它，与内置官方表开关无关
 *   2. 开了「使用官方价格表」且该模型 id 能在内置表中匹配到
 *   3. 全局兜底单价（cfg.priceInputPerM 等）
 *
 * @param {string} modelId 模型 id（通常是网关返回的真名）
 * @param {object} cfg 配置对象（getConfig() 的结果）
 * @returns {{
 *   in:number, out:number, cached:number,
 *   peak:?{in:number,out:number,cached:number},
 *   image:?object,
 *   source:'custom'|'official'|'manual'|'none',
 *   matched:?string, locked:boolean
 * }}
 *   - source: custom=用户自定义 / official=内置官方表 / manual=全局兜底 / none=无单价
 *   - locked: 是否因"命中内置官方表且开关打开"而不可编辑
 */

/* ══════════════════════════════════════════════════════════════
   模型单价解析
   ══════════════════════════════════════════════════════════════

   规则（刻意做得简单）：
     开关开 → 一律走内置官方价格表，且**只读**
              匹配不到就是单价 0（估不出成本），提示关开关自填
     开关关 → **可编辑**，优先该模型的自定义价，没设则用全局兜底

   可编辑性**只跟开关绑定**：不看有没有匹配到、也不看该模型存没存过
   自定义价。绝不依赖保存状态。
*/

/**
 * 查价主入口：按"谁最懂这个价"的顺序解析。
 *
 *   ① 渠道价     api.modelPrices[渠道：模型]  —— 用户在中转站/自建渠道手填的实付价
 *   ② 自定义价   api.modelPrices[模型]        —— 用户填的通用价
 *   ③ 账户口径   按月付（costMode=subscription）：所有模型按固定月费
 *   ④ 渠道价目表 该渠道拉到的价目（src/pricing/channel-prices.js）—— 同属实付口径
 *   ⑤ 价格表     官方表 / 远程表（costMode=multiplier 时统一乘折扣）
 *   ⑥ 兜底单价   api.priceInputPerM/...       —— 只在关掉官方价时用（老行为）
 *   ⑦ 当前模型   按 api.model 的价估算（默认开，可关：fallbackToCurrentModel=false）
 *   ⑧ 未定价     —— unpriced，界面显式提示（不是 0 元）
 *
 * 口径（kind）：①②③④=实付 actual；⑤⑥⑦=估算 estimate；⑧=未定价 unpriced。
 * 排序原则：手填的价 > 账户口径 > 自动拉到的渠道价目 > 公共参考表 —— 用户明确输入的数字永远优先。
 *
 * ⚠️ unpriced=true 表示"没有价格"，和"免费（单价 0）"是两回事：
 *    统计时要单独标出来，不能显示成 ¥0.00 让用户以为免费。
 * ⚠️ useOfficialPrice === false 时**不看价格表**（尊重"我不用官方价"的选择），
 *    这条老语义保留；用户填的价在任何模式下都优先。
 */
/**
 * 账户级成本口径（设置页只需用户选一次，不用逐模型配）：
 *   official      默认：按内置/远程价格表估算（"不是你的账单"）
 *   multiplier    渠道价 = 官方价 × costMultiplier（中转站常见：只知道一个折扣）
 *   subscription  按月付：所有模型按固定月费计（订阅制 / 本地自建）
 */
export function costModeOf(cfg) {
  const api = (cfg && cfg.api) || {};
  const raw = String(api.costMode ?? '').trim().toLowerCase();
  const mode = ['multiplier', 'subscription'].includes(raw) ? raw : 'official';
  return {
    mode,
    multiplier: parseMultiplier(api.costMultiplier),
    monthlyFee: Math.max(0, Number(api.costMonthlyFee) || 0)
  };
}

/**
 * 渠道倍率：没填 = 1；填了 0 就是 0（免费渠道）。
 * 不能用 `Number(x) || 1` —— 0 是合法值，会被当成"没填"变成原价。
 */
export function parseMultiplier(value) {
  if (value === undefined || value === null || String(value).trim() === '') return 1;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 1;
}

/** 把价格表条目按倍率打折（multiplier 模式：用户声明的渠道价）。 */
function scaleEntry(entry, multiplier) {
  const scale = (value) => Number(((Number(value) || 0) * multiplier).toFixed(6));
  const out = { ...entry, in: scale(entry.in), out: scale(entry.out) };
  if (entry.cached != null) out.cached = scale(entry.cached);
  if (entry.peak) {
    out.peak = {
      in: scale(entry.peak.in),
      out: scale(entry.peak.out),
      cached: entry.peak.cached == null ? out.cached : scale(entry.peak.cached)
    };
  }
  return out;
}

export function resolveModelPrice(modelId, cfg, priceTable = null, options = {}) {
  const id = String(modelId || '').trim();
  const api = (cfg && cfg.api) || {};
  const officialEnabled = api.useOfficialPrice !== false;
  const vendor = String(options.vendor || '').trim();
  const customMap = api.modelPrices || {};
  const cost = costModeOf(cfg);
  const fallbackAllowed = options.allowFallback !== false;

  // ① 渠道价：同一个模型在不同渠道是不同商品，用户可以为某个渠道单独定价
  if (vendor && id) {
    const key = channelPriceKey(vendor, id);
    const hit = customMap[key];
    if (hasManualPrice(hit)) {
      return customPrice(hit, {
        source: 'channel',
        matched: key,
        via: `渠道价（${vendor}）`,
        locked: false
      });
    }
  }

  // ② 模型自定义价（不分渠道）—— 手填的价永远优先于自动拉到的价目表
  const own = customMap[id];
  if (id && hasManualPrice(own)) {
    return customPrice(own, { source: 'custom', matched: id, via: '自定义价', locked: false });
  }

  // ③ 账户口径：按月付（订阅制 / 本地自建）—— 用户声明了固定月费，
  //    就不查表、不按 token 算（手填的价仍然优先于它）。
  if (cost.mode === 'subscription' && cost.monthlyFee > 0) {
    return {
      in: 0, out: 0, cached: 0,
      peak: null, image: null,
      billing: 'flat', amount: cost.monthlyFee, period: 'month',
      note: '账户口径：按月付',
      source: 'subscription',
      matched: null,
      locked: false,
      unpriced: false,
      kind: 'actual',
      confidence: 'manual',
      via: `按月付 ¥${cost.monthlyFee}/月`
    };
  }

  // ④ 渠道价目表（该渠道自动拉取/用户配置的价目，见 channel-prices.js）：
  //    比公共参考表更具体（就是这个渠道的价），但比不过上面几条手填的价。
  if (cost.mode !== 'subscription' && vendor && id && CHANNEL_PRICES[vendor]) {
    const hit = matchPriceTable(id, CHANNEL_PRICES[vendor], EFFECTIVE_ALIASES, Number(options.at) || 0);
    // 与手填价同一判据（见 hasManualPrice）：写出来的 0/0 是"明确免费"，
    // 不能用 `Number(x) ||` 判成"没价" —— 否则同一份价目走"手填"是免费、走"渠道表"却是官方价
    if (hit && hasManualPrice(hit)) {
      const { billing, amount, period } = billingOf(hit);
      const perToken = billing === 'token';
      return {
        in: perToken ? Number(hit.in) || 0 : 0,
        out: perToken ? Number(hit.out) || 0 : 0,
        cached: perToken ? (hit.cached == null ? Number(hit.in) || 0 : Number(hit.cached) || 0) : 0,
        peak: perToken ? (hit.peak || null) : null,
        image: null,
        billing,
        amount,
        period,
        note: typeof hit.note === 'string' ? hit.note : '',
        source: 'channel-table',
        matched: hit.matched || id,
        locked: false,
        unpriced: false,
        kind: 'actual',
        confidence: 'channel-table',
        via: `渠道价目表（${vendor}）`
      };
    }
  }

  // ⑤ 价格表（官方 + 远程）。远程条目优先，来源要标出来让界面区分"参考"与"渠道表"。
  //    multiplier 模式（用户声明"我的渠道价 = 官方价 × 折扣"）在这里统一打折。
  //    表里没有**不直接判未定价**：继续往下走 ⑥ 兜底单价 / ⑦ 按当前模型估算。
  let tableMissed = false;
  if (officialEnabled) {
    const at = Number(options.at) || 0;
    const hit = id ? (priceTable ? matchPriceTable(id, priceTable, null, at) : resolveOfficialPrice(id, { at })) : null;
    if (hit) {
      const remote = isRemoteEntry(hit.matched);
      const discounted = cost.mode === 'multiplier' && cost.multiplier !== 1;
      const p = discounted ? scaleEntry(hit, cost.multiplier) : hit;
      // 表里也能标计费方式（例如社区表把某个本地模型标成 none、某个订阅套餐标成 flat）
      const { billing, amount, period } = billingOf(p);
      const perToken = billing === 'token';
      return {
        in: perToken ? Number(p.in) || 0 : 0,
        out: perToken ? Number(p.out) || 0 : 0,
        cached: perToken ? (p.cached == null ? Number(p.in) || 0 : Number(p.cached) || 0) : 0,
        peak: perToken ? (p.peak || null) : null,
        image: perToken ? (p.image || null) : null,
        billing,
        amount,
        period,
        note: typeof p.note === 'string' ? p.note : '',
        source: discounted ? 'multiplier' : (remote ? 'remote' : 'official'),
        matched: p.matched ?? id,
        locked: discounted ? false : !remote,
        unpriced: false,
        // 倍率是用户自己声明的渠道价 → 实付口径；官方表原价 → 估算
        kind: discounted ? 'actual' : 'estimate',
        confidence: discounted ? 'manual' : (p.confidence || 'exact'),
        via: discounted ? `官方价 ×${cost.multiplier}` : (p.via || '')
      };
    }
    // 表里没有 → 记下来，继续走兜底/按当前模型估算
    tableMissed = true;
  }

  // ⑥ 全局兜底单价：老配置在"不用官方价"模式下的主力路径。
  //    官方价开着时不生效 —— 否则"未定价"会被一个粗估数字悄悄藏起来（老语义，别改）。
  const fi = Number(api.priceInputPerM) || 0;
  const fo = Number(api.priceOutputPerM) || 0;
  if (!officialEnabled && (fi || fo)) {
    return {
      in: fi,
      out: fo,
      cached: Number(api.priceCachedPerM) || fi,
      peak: null, image: null,
      billing: 'token', amount: 0, period: 'month',
      source: 'manual',
      matched: null,
      locked: false,
      unpriced: false,
      kind: 'estimate',
      confidence: 'manual',
      via: '全局兜底单价'
    };
  }

  // ⑦ 未定价之前：按"用户当前正在用的模型"的价估算（默认开，可在高级里关掉）。
  //    目的：不让"没价"变成用户要做的作业 —— 数字仍是估算口径，
  //    面板会说明有多少次是按它估的（fallbackCalls）。
  const currentModel = String(api.model || '').trim();
  if (fallbackAllowed && api.fallbackToCurrentModel !== false && id && currentModel && currentModel !== id) {
    const base = resolveModelPrice(currentModel, cfg, priceTable, { vendor, at: Number(options.at) || 0, allowFallback: false });
    if (base && base.unpriced !== true) {
      return {
        ...base,
        matched: base.matched,
        source: 'fallback-model',
        confidence: 'fallback-model',
        kind: 'estimate',
        via: `按当前模型「${currentModel}」的价估算`,
        fallbackFrom: currentModel
      };
    }
  }

  // ⑧ 未定价（官方价开着时只读：不允许在这些输入框里改官方价）
  return unpricedPrice({ locked: tableMissed });
}

/** 渠道价键：「渠道：模型」（全角冒号，与 modelLabel 一致，避免和 id 里的半角符号混淆）。 */
export function channelPriceKey(vendor, model) {
  return modelLabel(vendor, model);
}

/** 用户自填价的统一形状（渠道价与自定义价共用）。 */
/**
 * 计费方式：token（默认，按量）/ flat（包月、订阅，固定支出）/ none（本地、自建，不计费）。
 * 只有 token 会算进"按量成本"；flat 单独作为固定支出展示；none 只统计 token。
 */
export function billingOf(entry) {
  const raw = String(entry?.billing ?? '').trim().toLowerCase();
  if (raw === 'flat') {
    return {
      billing: 'flat',
      amount: Math.max(0, Number(entry?.amount) || 0),
      period: String(entry?.period ?? '').trim().toLowerCase() === 'day' ? 'day' : 'month'
    };
  }
  if (raw === 'none') return { billing: 'none', amount: 0, period: 'month' };
  return { billing: 'token', amount: 0, period: 'month' };
}

/**
 * 手填的一条价目算不算"填了价"。
 * 判据是"写没写 in/out 字段"，不是"算出来非 0" —— `{in:0,out:0}` 是用户明确写的
 * 免费价（本地模型、赠送额度），用 `Number(x) || ...` 判断会把它当成没填而回落到
 * 官方价，报出来的钱比实际高的多。billing 写了照样算填了（包月/不计费）。
 */
function hasManualPrice(entry) {
  if (!entry || typeof entry !== 'object') return false;
  if (String(entry.billing ?? '').trim()) return true;
  for (const key of ['in', 'out']) {
    const value = entry[key];
    if (value === undefined || value === null || String(value).trim() === '') continue;
    if (Number.isFinite(Number(value))) return true;
  }
  return false;
}

function customPrice(entry, { source, matched, via, locked }) {
  const { billing, amount, period } = billingOf(entry);
  // 包月/不计费的条目不按 token 计价：单价 0，成本口径由 billing 决定
  const perToken = billing === 'token';
  return {
    in: perToken ? Number(entry.in) || 0 : 0,
    out: perToken ? Number(entry.out) || 0 : 0,
    cached: perToken ? (entry.cached == null ? Number(entry.in) || 0 : Number(entry.cached) || 0) : 0,
    peak: perToken ? (entry.peak || null) : null,
    image: null,
    billing,
    amount,
    period,
    note: typeof entry.note === 'string' ? entry.note : '',
    source,
    matched,
    locked,
    unpriced: false,
    kind: 'actual',
    confidence: source,
    via
  };
}

function unpricedPrice({ locked }) {
  return {
    in: 0, out: 0, cached: 0,
    peak: null, image: null,
    billing: 'token', amount: 0, period: 'month',
    source: 'unmatched',
    matched: null,
    locked,
    unpriced: true,
    kind: 'unpriced',
    confidence: 'none',
    via: ''
  };
}

/** 这次解析结果算不算"没有价格"（与"免费"区分开）。 */
export function isPriceUnpriced(price) {
  return Boolean(price && price.unpriced === true);
}

/** 这次的价格是"实付"还是"估算"（面板口径标注用）。 */
export function priceKind(price) {
  if (!price || price.unpriced === true) return 'unpriced';
  return price.kind === 'actual' ? 'actual' : 'estimate';
}

/** 在一张价格表里匹配模型（供前端用本地数据算，不依赖接口往返）。 */
export function matchPriceTable(modelId, table, aliases = null, at = 0) {
  const list = Array.isArray(table) ? table : Object.entries(table || {}).map(([id, e]) => ({ id, ...e }));
  const map = {};
  for (const entry of list) {
    const key = String(entry?.id ?? '').trim().toLowerCase();
    if (key) map[key] = entry;
  }
  return matchModelId(modelId, map, aliases || EFFECTIVE_ALIASES, Number(at) || 0);
}

/* ══════════════════════════════════════════════════════════════
   渠道（vendor）
   ══════════════════════════════════════════════════════════════

   同一个模型 id 走不同**渠道**时，是两个不同的商品：
       「A6API中转站：z-ai/glm-5.3-flash」
       「OpenRouter：z-ai/glm-5.3-flash」
       「本地中转：z-ai/glm-5.3-flash」

   这里说的渠道 = 程序内配置的 API 端点（A6API / OpenRouter / 本地中转…），
   **不是**网关返回的下游供应商（raw.provider）—— 后者一次调用一个值、
   多达几十种，粒度太细，也不代表用户实际采购的渠道。
*/

/** 无渠道信息时的显示名。历史会话没记录渠道时用它，绝不拿当前配置去猜。 */
export const UNKNOWN_VENDOR = '未知渠道';

/**
 * 由 API 配置派生渠道名（只用于**新产生的调用**）。
 *
 * 优先级：
 *   1. providers 里 id 匹配 api.provider → displayName（如「A6API中转站」）
 *   2. providers 里 baseURL 匹配 api.baseUrl → displayName
 *   3. 退回 baseUrl 的域名（如 openrouter.ai）
 *   4. 都没有 → null（调用方按"未知渠道"处理）
 *
 * 历史会话请用它自己记录的 vendor 字段；拿当前配置倒推历史是错的。
 */
export function vendorOfConfig(cfg) {
  const c = cfg || {};
  const api = c.api || {};
  const provs = Array.isArray(c.providers) ? c.providers : [];
  const byId = api.provider ? provs.find((p) => p && p.id === api.provider) : null;
  if (byId && byId.displayName) return String(byId.displayName);
  return vendorOfBaseUrl(c, api.baseUrl);
}

/** 指定端点的渠道身份：优先 providers 里按 baseURL 匹配到的 displayName，回落 URL host。
 * 兜底模型接管后请求实际发往 api.fallback.baseUrl，记账要按这个端点归属渠道 ——
 * 不能拿当前主配置倒推（vendorOfConfig 注释同款约定："历史会话用它自己记录的 vendor"）。 */
export function vendorOfBaseUrl(cfg, baseUrl) {
  const c = cfg || {};
  const base = String(baseUrl || '').trim();
  const provs = Array.isArray(c.providers) ? c.providers : [];
  const norm = (u) => String(u || '').replace(/\/+$/, '');
  const byUrl = base ? provs.find((p) => p && p.baseURL && norm(p.baseURL) === norm(base)) : null;
  if (byUrl && byUrl.displayName) return String(byUrl.displayName);
  if (base) {
    try { return new URL(base).host; } catch { /* 非法 URL */ }
  }
  return null;
}

/** 模型完整身份：「渠道：模型 id」。全角冒号，避免与 id 里的半角符号混淆。 */
export function modelLabel(vendor, model) {
  const v = String(vendor || '').trim() || UNKNOWN_VENDOR;
  const m = String(model || '').trim() || '(未知模型)';
  return `${v}：${m}`;
}

/** 把「渠道：模型 id」拆回两半。拆不开时 vendor 为空串。 */
export function splitModelLabel(label) {
  const s = String(label || '');
  const i = s.indexOf('：');
  return i > 0 ? { vendor: s.slice(0, i), model: s.slice(i + 1) } : { vendor: '', model: s };
}
