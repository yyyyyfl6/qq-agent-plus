// 容器启动引导：写第一份 config.json、生成控制台令牌、把 compose 的环境变量落到配置里。
//
// 为什么放在应用启动之前、而不是在 config.js 里做运行期覆盖：
//   1) 这个项目的大量逻辑直接读 data/config.json（ops、巡检、更新器），只在应用内覆盖会
//      造成"控制台看到的"和"巡检读到的"不是同一份值；
//   2) 首次启动必须有一个能用的令牌，否则默认 host=127.0.0.1 在容器里根本收不到端口映射
//      的请求（Docker 的转发目标是容器 IP，不是 loopback）；
//   3) 引导脚本可以用临时文件 + rename 原子落盘，失败时给出可操作的错误（卷属主不对）。
//
// 约定：环境变量只在设置了非空值时才覆盖；没设置就保留已有配置。这样：
//   - 升级已有数据卷不会把用户在控制台改过的设置冲掉；
//   - compose 里写死的 OneBot 地址 / 令牌每次启动都会对齐（声明式部署更可预期）。
// 例外：server.host 在容器里默认 0.0.0.0（除非显式指定），因为 loopback 在容器里等于不可访问。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_DATA_DIR = '/data';
const DEFAULT_SERVER_HOST = '0.0.0.0';
const DEFAULT_SERVER_PORT = 3210;
const DEFAULT_ONEBOT_WS = 'ws://snowluma:3001';
const DEFAULT_ONEBOT_HTTP = 'http://snowluma:3000';

function nonEmpty(value) {
  return String(value ?? '').trim();
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function plainObject(value) {
  return isPlainObject(value) ? value : {};
}

function ensureSection(config, key) {
  if (!isPlainObject(config[key])) config[key] = {};
  return config[key];
}

function readConfigFile(configPath, now) {
  try {
    const text = fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(text);
    if (!plainObject(parsed)) throw new Error('配置根节点不是对象');
    return { config: parsed, existed: true, brokenBackup: '' };
  } catch (error) {
    if (error?.code === 'ENOENT') return { config: {}, existed: false, brokenBackup: '' };
    // 与 config.js 的容错同口径：坏文件先留档，不让一次手改成坏字符就覆盖整份配置。
    const backup = `${configPath}.broken-${now}`;
    try {
      fs.renameSync(configPath, backup);
    } catch (renameError) {
      throw new Error(`config.json 无法解析（${error?.message ?? error}），且备份失败（${renameError?.message ?? renameError}）。`
        + `请检查数据卷权限：${path.dirname(configPath)}`);
    }
    return { config: {}, existed: true, brokenBackup: backup, parseError: String(error?.message ?? error) };
  }
}

function writeConfigAtomic(configPath, config) {
  const dir = path.dirname(configPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${configPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flush: true });
  fs.renameSync(tmp, configPath);
  try { fs.chmodSync(configPath, 0o600); } catch { /* 某些文件系统不支持 mode，写入已成功 */ }
}

function writableError(dir, error) {
  const uid = typeof process.getuid === 'function' ? process.getuid() : '未知';
  if (error?.code === 'EROFS') {
    return new Error(`数据目录是只读的：${dir}（当前 uid=${uid}）。\n`
      + '  检查 compose 里的数据卷是否被写成了 `:ro`，或 NFS/SMB 是否以只读方式挂载。\n'
      + '  数据目录必须可写（config.json、SQLite、插件数据都写在这里）。');
  }
  return new Error(`数据目录不可写：${dir}（当前 uid=${uid}，${error?.code || error?.message}）。\n`
    + '  宿主机修法：sudo chown -R 1000:1000 <compose 所在目录>/data\n'
    + '  如果用的是 NFS/SMB 卷，请让卷对 uid 1000 可写，或改用本地目录。');
}

function truthy(value) {
  return ['1', 'true', 'yes', 'on'].includes(nonEmpty(value).toLowerCase());
}

/** 旧配置里的裸机地址（127.0.0.1:339x）在容器里一定连不上，允许环境变量替换它。 */
function isLoopbackUrl(value) {
  return /^(?:wss?|https?):\/\/(127\.\d+\.\d+\.\d+|localhost|\[::1\]|0\.0\.0\.0)(?::|\/|$)/i.test(nonEmpty(value));
}

function assertWritable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw writableError(dir, error);
  }
  const probe = path.join(dir, `.docker-write-test-${process.pid}`);
  try {
    fs.writeFileSync(probe, 'ok', { mode: 0o600 });
  } catch (error) {
    throw writableError(dir, error);
  } finally {
    try { fs.unlinkSync(probe); } catch { /* 写不进去时也无需清理 */ }
  }
}

/**
 * 从 SnowLuma 的 onebot*.json 读取 accessToken。
 *
 * SnowLuma 不读 ONEBOT_TOKEN 环境变量；它首次启动会在 `<data>/config/onebot.json`
 * 里生成随机 accessToken。full-stack compose 把该目录只读挂进 Agent，这里同步过去，
 * 否则 WS/HTTP 都会 401。
 */
function readOneBotTokenFrom(dir) {
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((name) => name === 'onebot.json' || /^onebot_\d+\.json$/.test(name));
  } catch {
    return '';
  }
  for (const name of names) {
    try {
      const config = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      const networks = plainObject(config.networks);
      for (const key of ['httpServers', 'wsServers']) {
        const list = Array.isArray(networks[key]) ? networks[key] : [];
        for (const server of list) {
          const token = nonEmpty(server?.accessToken);
          if (token) return token;
        }
      }
      const direct = nonEmpty(config.accessToken);
      if (direct) return direct;
    } catch { /* 可能正在写盘，下一轮再读 */ }
  }
  return '';
}

function sleepSync(ms) {
  if (!(ms > 0)) return;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch { /* 极少数运行时不支持，放弃等待 */ }
}

/** 等 SnowLuma 首次启动把 onebot.json 写出来（默认最多 120 秒；外部协议端不设该目录）。 */
export function readSnowlumaOneBotToken(env = process.env) {
  const dir = nonEmpty(env.QQ_AGENT_SNOWLUMA_CONFIG_DIR);
  if (!dir) return '';
  const waitMs = Math.max(0, Number(env.QQ_AGENT_SNOWLUMA_CONFIG_WAIT_MS ?? 120000) || 0);
  const deadline = Date.now() + waitMs;
  for (;;) {
    const token = readOneBotTokenFrom(dir);
    if (token) return token;
    if (Date.now() >= deadline) return '';
    sleepSync(300);
  }
}

/**
 * 把环境变量应用到配置对象（就地修改）。只认下面这些键；其余配置保持原样。
 * @returns {{changed:boolean, tokenSource:'env'|'config'|'generated', onebotTokenSource:'env'|'snowluma'|'config'|'none', token:string, warnings:string[]}}
 */
export function applyBootstrapEnv(config, env = process.env, { generate = true } = {}) {
  const warnings = [];
  const ignored = [];
  const forceAll = truthy(env.QQ_AGENT_FORCE_ENV) || truthy(env.QQ_AGENT_FORCE_ENV_VARS);
  const server = ensureSection(config, 'server');
  const onebot = ensureSection(config, 'onebot');

  const envHost = nonEmpty(env.QQ_AGENT_SERVER_HOST);
  server.host = envHost || DEFAULT_SERVER_HOST;
  if (server.host === '127.0.0.1' || server.host === 'localhost' || server.host === '::1') {
    warnings.push('server.host 指向回环地址：容器内绑定 127.0.0.1 时，宿主端口映射访问不到控制台。'
      + '除非你确定通过 docker exec/sidecar 访问，否则请用 0.0.0.0。');
  }

  const envPort = Number.parseInt(nonEmpty(env.QQ_AGENT_SERVER_PORT), 10);
  server.port = Number.isFinite(envPort) && envPort > 0 && envPort < 65536
    ? envPort
    : (Number(server.port) || DEFAULT_SERVER_PORT);

  // 令牌：环境变量只做**首次播种**。配置里已有令牌时默认不覆盖 —— 否则用户在控制台
  // 轮换令牌、重启后又变回旧环境变量，安全轮换被静默撤销。要强制覆盖设
  // QQ_AGENT_FORCE_ENV=1（或 QQ_AGENT_FORCE_CONSOLE_TOKEN=1）。
  const envToken = nonEmpty(env.QQ_AGENT_CONSOLE_TOKEN);
  const storedToken = nonEmpty(server.token);
  const forceToken = forceAll || truthy(env.QQ_AGENT_FORCE_CONSOLE_TOKEN);
  let tokenSource = 'config';
  if (envToken && (forceToken || !storedToken)) {
    server.token = envToken;
    tokenSource = 'env';
  } else if (!storedToken) {
    if (!generate) {
      server.token = '';
      tokenSource = 'config';
    } else {
      server.token = crypto.randomBytes(24).toString('base64url');
      tokenSource = 'generated';
    }
  } else if (envToken && !forceToken) {
    ignored.push('QQ_AGENT_CONSOLE_TOKEN');
  }

  // OneBot 地址：首次播种；配置里是可用的非回环地址时保留（用户在控制台改过的值
  // 不该每次重启被 compose 默认值顶回去）。裸机迁移留下的 127.0.0.1:339x 允许替换。
  const envWs = nonEmpty(env.QQ_AGENT_ONEBOT_WS_URL);
  const envHttp = nonEmpty(env.QQ_AGENT_ONEBOT_HTTP_URL);
  const existingWs = nonEmpty(onebot.wsUrl);
  const existingHttp = nonEmpty(onebot.httpUrl);
  onebot.wsUrl = envWs && (forceAll || !existingWs || isLoopbackUrl(existingWs))
    ? envWs
    : (existingWs || DEFAULT_ONEBOT_WS);
  onebot.httpUrl = envHttp && (forceAll || !existingHttp || isLoopbackUrl(existingHttp))
    ? envHttp
    : (existingHttp || DEFAULT_ONEBOT_HTTP);

  const envAccess = nonEmpty(env.QQ_AGENT_ONEBOT_ACCESS_TOKEN);
  if (envAccess && (forceAll || !nonEmpty(onebot.accessToken))) onebot.accessToken = envAccess;
  else if (envAccess && !forceAll) ignored.push('QQ_AGENT_ONEBOT_ACCESS_TOKEN');
  const envHttpToken = nonEmpty(env.QQ_AGENT_ONEBOT_HTTP_TOKEN);
  if (envHttpToken && (forceAll || !nonEmpty(onebot.httpAccessToken))) onebot.httpAccessToken = envHttpToken;
  else if (envHttpToken && !forceAll) ignored.push('QQ_AGENT_ONEBOT_HTTP_TOKEN');

  // OneBot 令牌来源（优先级）：显式环境变量 > SnowLuma 配置 > 已有配置 > 空。
  // SnowLuma 的配置是 full-stack 的唯一真相：即使旧 data/config.json 里有一个过期令牌，
  // 也要以 SnowLuma 当前生成的为准，否则登录后仍然 401。
  let onebotTokenSource = (envAccess || envHttpToken) ? 'env' : 'config';
  if (!envAccess && !envHttpToken) {
    const snowlumaToken = readSnowlumaOneBotToken(env);
    if (snowlumaToken) {
      onebot.accessToken = snowlumaToken;
      onebot.httpAccessToken = snowlumaToken;
      onebotTokenSource = 'snowluma';
    } else if (!nonEmpty(onebot.accessToken) && !nonEmpty(onebot.httpAccessToken)) {
      onebotTokenSource = 'none';
    }
  }

  // 可选：用环境变量完成模型配置（适合"完全无控制台"的声明式部署）。
  // 与令牌同一口径：只填空位；控制台里配过的值不覆盖。
  const envApiBase = nonEmpty(env.QQ_AGENT_API_BASE_URL);
  const envApiKey = nonEmpty(env.QQ_AGENT_API_KEY);
  const envApiModel = nonEmpty(env.QQ_AGENT_API_MODEL);
  const api = ensureSection(config, 'api');
  if (envApiBase && (forceAll || !nonEmpty(api.baseUrl))) api.baseUrl = envApiBase;
  else if (envApiBase && !forceAll) ignored.push('QQ_AGENT_API_BASE_URL');
  if (envApiKey && (forceAll || !nonEmpty(api.apiKey))) api.apiKey = envApiKey;
  else if (envApiKey && !forceAll) ignored.push('QQ_AGENT_API_KEY');
  if (envApiModel && (forceAll || !nonEmpty(api.model))) api.model = envApiModel;
  else if (envApiModel && !forceAll) ignored.push('QQ_AGENT_API_MODEL');

  if (ignored.length) {
    warnings.push(`以下环境变量已设置，但配置里已有值，本次保留配置：${[...new Set(ignored)].join(', ')}`
      + '（要强制用环境变量覆盖，设 QQ_AGENT_FORCE_ENV=1 后重启一次）。');
  }

  return { tokenSource, token: server.token, onebotTokenSource, warnings };
}

/** 控制台访问信息落盘（0600）：日志里不再打印令牌，用户用 docker exec cat 查看。 */
function writeConsoleAccess(dataDir, config) {
  const server = plainObject(config.server);
  const token = nonEmpty(server.token);
  if (!token) return '';
  const host = server.host === '0.0.0.0' ? '127.0.0.1' : String(server.host || '127.0.0.1');
  const port = Number(server.port) || DEFAULT_SERVER_PORT;
  const file = path.join(dataDir, 'console-access.txt');
  const body = 'QQ Agent Linux\n'
    + `URL: http://${host}:${port}/?token=${encodeURIComponent(token)}\n`
    + `Token: ${token}\n`
    + 'Mode: container\n';
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, body, { mode: 0o600, flush: true });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch { /* 某些文件系统不支持 mode */ }
  return file;
}

/**
 * 引导入口（可测试）：确保数据目录可写、生成/对齐配置、返回摘要。
 * 不打印任何内容；输出由 main() 负责。
 */
export function bootstrap({ dataDir = DEFAULT_DATA_DIR, env = process.env, now = Date.now() } = {}) {
  assertWritable(dataDir);
  const configPath = path.join(dataDir, 'config.json');
  const read = readConfigFile(configPath, now);
  // 全新 Docker 部署默认 active：observe 会让"配置完白名单 @ 一句"毫无反应。
  // 已有配置里用户自己选的 observe 保留；也可以用 QQ_AGENT_RUNTIME_MODE 指定。
  if (!read.existed) {
    const runtime = ensureSection(read.config, 'runtime');
    const requested = nonEmpty(env.QQ_AGENT_RUNTIME_MODE);
    runtime.mode = ['active', 'observe'].includes(requested) ? requested : 'active';
  }
  const before = JSON.stringify(read.config);
  const applied = applyBootstrapEnv(read.config, env);
  const changed = before !== JSON.stringify(read.config);
  if (changed) writeConfigAtomic(configPath, read.config);
  const accessFile = writeConsoleAccess(dataDir, read.config);
  const api = plainObject(read.config.api);
  return {
    dataDir,
    configPath,
    accessFile,
    created: !read.existed,
    changed,
    brokenBackup: read.brokenBackup || '',
    parseError: read.parseError || '',
    token: applied.token,
    tokenSource: applied.tokenSource,
    onebotTokenSource: applied.onebotTokenSource,
    runtimeMode: plainObject(read.config.runtime).mode || '',
    warnings: applied.warnings,
    apiConfigured: Boolean(nonEmpty(api.baseUrl) && nonEmpty(api.model)),
    serverHost: plainObject(read.config.server).host,
    serverPort: plainObject(read.config.server).port,
    onebotWsUrl: plainObject(read.config.onebot).wsUrl,
    onebotHttpUrl: plainObject(read.config.onebot).httpUrl
  };
}

function printBanner(result, log = console.log) {
  log('[docker] 数据目录：' + result.dataDir);
  if (result.brokenBackup) {
    log(`[docker] 原 config.json 无法解析，已备份为 ${result.brokenBackup}，按默认配置启动`);
  }
  const url = `http://${result.serverHost === '0.0.0.0' ? '127.0.0.1' : result.serverHost}:${result.serverPort}`;
  // 令牌默认不再打进容器日志（日志常被 journald/云日志长期收集）。访问信息写在
  // /data/console-access.txt（0600）；需要日志直出时显式设 QQ_AGENT_PRINT_TOKEN=1。
  if (result.accessFile) {
    log(`[docker] 控制台：${url}（令牌来自 ${result.tokenSource === 'env' ? '环境变量' : result.tokenSource === 'generated' ? '首次生成' : '配置文件'}）`);
    log(`[docker] 访问信息已写入 ${result.accessFile}；查看：docker compose exec agent cat ${result.accessFile}`);
    if (truthy(process.env.QQ_AGENT_PRINT_TOKEN)) {
      log(`[docker] QQ_AGENT_PRINT_TOKEN=1：控制台令牌 ${result.token}`);
      log(`[docker] 直接打开：${url}/?token=${encodeURIComponent(result.token)}`);
    }
  } else {
    log(`[docker] 控制台：${url}`);
  }
  log(`[docker] OneBot：ws=${result.onebotWsUrl} http=${result.onebotHttpUrl}`);
  if (result.onebotTokenSource === 'snowluma') {
    log('[docker] OneBot 令牌：已从 SnowLuma 配置（/snowluma-config/onebot*.json）同步');
  } else if (result.onebotTokenSource === 'env') {
    log('[docker] OneBot 令牌：来自环境变量');
  } else if (result.onebotTokenSource === 'config') {
    log('[docker] OneBot 令牌：来自 data/config.json');
  } else {
    log('[docker] OneBot 令牌：未配置（SnowLuma 登录后若仍连不上，重启 agent 或检查 /snowluma-config/onebot.json）');
  }
  log(`[docker] 运行模式：${result.runtimeMode || '（默认）'}${result.runtimeMode === 'observe' ? '（观察模式：不会回复）' : ''}`);
  if (!result.apiConfigured) {
    log('[docker] 模型尚未配置：打开控制台 → 设置 → 模型 API，填入 Base URL、Key 与模型名');
  }
  for (const warning of result.warnings) log('[docker] 警告：' + warning);
  log('[docker] 容器内没有 systemd / 宿主 Docker：请不要执行 deploy.sh、systemctl 或控制台的"立即更新"；'
    + '升级请拉取新镜像后重建容器。');
}

function isMain() {
  try {
    return process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isMain()) {
  try {
    const result = bootstrap({
      dataDir: nonEmpty(process.env.QQ_AGENT_DATA_DIR) || DEFAULT_DATA_DIR,
      env: process.env
    });
    printBanner(result);
  } catch (error) {
    console.error(`[docker] 启动引导失败：${error?.message ?? error}`);
    process.exit(1);
  }
}

export { DEFAULT_DATA_DIR, DEFAULT_ONEBOT_HTTP, DEFAULT_ONEBOT_WS, DEFAULT_SERVER_HOST, DEFAULT_SERVER_PORT, printBanner, writableError };
