// 常用 MCP server 预设：离线可用，避免依赖官方 Registry 的网络可达性。
// 命令与参数来自官方参考 server / 常见发行包；导入后仍需管理员确认目录、令牌和信任。

const preset = (id, title, description, command, args, env = {}, category = '效率') => ({
  id,
  title,
  name: id,
  description,
  version: '',
  repository: '',
  category,
  source: 'preset',
  unsupported: false,
  config: {
    id,
    enabled: false,
    transport: 'stdio',
    command,
    args,
    env,
    timeoutMs: 30000,
    maxCallsPerMinute: 30,
    toolMounting: 'direct'
  }
});

export const MCP_PRESETS = [
  preset(
    'filesystem',
    'Filesystem',
    '让模型读你放进去的群规/手册/资料目录。默认只给 data/knowledge；不要改成数据根目录（里面有 config.json、密钥和人物记忆）。',
    'npx',
    ['-y', '@modelcontextprotocol/server-filesystem', '/data/knowledge'],
    {},
    '知识'
  ),
  preset(
    'fetch',
    'Fetch',
    '抓网页并转成 markdown，适合让它读文章、公告、文档。注意：它自己联网，不走宿主的 SSRF 拦截，不要用于内网地址。',
    'uvx',
    ['mcp-server-fetch'],
    {},
    '知识'
  ),
  preset(
    'context7',
    'Context7',
    '查第三方库/框架的最新文档和示例，减少“模型记错 API”。',
    'npx',
    ['-y', '@upstash/context7-mcp'],
    {},
    '知识'
  ),
  preset(
    'brave-search',
    'Brave Search',
    '网页搜索。需要 BRAVE_API_KEY；适合群里的实时信息、新闻和梗。',
    'npx',
    ['-y', '@brave/brave-search-mcp-server'],
    { BRAVE_API_KEY: '' },
    '搜索'
  ),
  preset(
    'playwright',
    'Playwright',
    '浏览器自动化：打开网页、点击、抓页面。注意：它自己联网，不走宿主的 SSRF 拦截；不要让它访问内网/控制台。首次运行可能要装浏览器。',
    'npx',
    ['-y', '@playwright/mcp@latest'],
    {},
    '浏览器'
  ),
  preset(
    'memory',
    'Memory',
    '结构化知识图谱记忆，适合存“群运营笔记/项目上下文”，和内置人物印象互补。',
    'npx',
    ['-y', '@modelcontextprotocol/server-memory'],
    {},
    '效率'
  ),
  preset(
    'sequential-thinking',
    'Sequential Thinking',
    '把复杂问题拆成可回溯的思考步骤，适合规划和多步任务。',
    'npx',
    ['-y', '@modelcontextprotocol/server-sequential-thinking'],
    {},
    '效率'
  ),
  preset(
    'time',
    'Time',
    '时区/时间换算，适合跨时区群友和定时任务。需要本机有 uv/uvx。',
    'uvx',
    ['mcp-server-time'],
    {},
    '效率'
  ),
  preset(
    'git',
    'Git',
    '查本地仓库日志、diff、状态。导入后把 /path/to/repo 改成仓库路径。',
    'uvx',
    ['mcp-server-git', '--repository', '/path/to/repo'],
    {},
    '开发'
  ),
  preset(
    'github',
    'GitHub',
    '读写 issue/PR/仓库，适合把群里的反馈直接落到 GitHub。需要 GITHUB_PERSONAL_ACCESS_TOKEN。',
    'npx',
    ['-y', '@modelcontextprotocol/server-github'],
    { GITHUB_PERSONAL_ACCESS_TOKEN: '' },
    '开发'
  ),
  preset(
    'everything',
    'Everything',
    '官方参考实现，包含多种示例工具，适合先验证 MCP 接入是否正常。',
    'npx',
    ['-y', '@modelcontextprotocol/server-everything'],
    {},
    '开发'
  )
];

export function searchPresets(query = '') {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return MCP_PRESETS;
  return MCP_PRESETS.filter((item) =>
    [item.id, item.title, item.description, item.category].some((value) => String(value).toLowerCase().includes(q)));
}
