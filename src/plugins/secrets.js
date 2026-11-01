// 插件凭据的加密存储（apiVersion 2 的 `secrets` 能力）。
//
// 目标不是"防住拿到服务器 root 的人"，而是三条更现实的：
//   1. 凭据不跟普通配置一起躺在 config.json 里（备份、导出、截图、日志都不会顺手带出去）；
//   2. 控制台只能看到"已配置/未配置"，永远不回显明文；
//   3. 插件只能读写自己 manifest 里声明为 secret 的字段，拿不到别人的、也拿不到未声明的键。
//
// 密钥文件与密文分开放（data/plugin-secrets/.key，0600）。AES-256-GCM 带随机 IV 与认证标签：
// 密文被改过一个字节，解密直接失败，而不是解出一段垃圾继续用。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const KEY_BYTES = 32;
const IV_BYTES = 12;
const MAX_SECRETS_BYTES = 64 * 1024;
const MAX_VALUE_CHARS = 8192;

const fail = (code, message) => Object.assign(new Error(message), { code });

function secretsDir(dataDir) {
  return path.join(dataDir, 'plugin-secrets');
}

function keyFile(dataDir) {
  return path.join(secretsDir(dataDir), '.key');
}

function secretFile(dataDir, pluginId) {
  return path.join(secretsDir(dataDir), `${pluginId}.json`);
}

function ensureKey(dataDir) {
  const file = keyFile(dataDir);
  fs.mkdirSync(secretsDir(dataDir), { recursive: true, mode: 0o700 });
  try {
    const existing = fs.readFileSync(file);
    if (existing.length === KEY_BYTES) return existing;
    // 长度不对说明文件被截断/覆盖过：这时**不能**悄悄换一把新钥匙 ——
    // 那会让所有已存凭据永久解不开，而用户只看到"Cookie 莫名失效"。
    throw fail('E_SECRET_KEY', '插件凭据密钥文件已损坏（长度不对），请恢复 data/plugin-secrets/.key 或删除所有插件凭据后重配');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const key = crypto.randomBytes(KEY_BYTES);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, key, { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch { /* Windows 上 chmod 基本无效，不阻断 */ }
  return key;
}

function readEnvelope(dataDir, pluginId) {
  try {
    const raw = JSON.parse(fs.readFileSync(secretFile(dataDir, pluginId), 'utf8'));
    if (!raw || raw.v !== 1 || typeof raw.iv !== 'string' || typeof raw.tag !== 'string' || typeof raw.data !== 'string') {
      throw fail('E_SECRET_FILE', '凭据文件格式不对');
    }
    return raw;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    if (error?.code === 'E_SECRET_FILE') throw error;
    throw fail('E_SECRET_FILE', `凭据文件读不了：${error?.message ?? error}`);
  }
}

function decryptEnvelope(dataDir, pluginId) {
  const envelope = readEnvelope(dataDir, pluginId);
  if (!envelope) return {};
  const key = ensureKey(dataDir);
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    const plain = Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]);
    const parsed = JSON.parse(plain.toString('utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    // 认证失败 = 密文/密钥/文件被改过。报错而不是当成空：否则下一次写会覆盖掉还能恢复的数据
    throw fail('E_SECRET_DECRYPT', '插件凭据解密失败（密钥或文件被改动过），请重新配置该插件的凭据');
  }
}

function writeEnvelope(dataDir, pluginId, secrets) {
  const body = JSON.stringify(secrets);
  if (Buffer.byteLength(body) > MAX_SECRETS_BYTES) {
    throw fail('E_TOO_BIG', `凭据总量上限 ${MAX_SECRETS_BYTES / 1024}KB`);
  }
  const key = ensureKey(dataDir);
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(Buffer.from(body, 'utf8')), cipher.final()]);
  const envelope = {
    v: 1,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: encrypted.toString('base64'),
    updatedAt: Date.now()
  };
  const dir = secretsDir(dataDir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = secretFile(dataDir, pluginId);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(envelope), { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch { /* 同 keyFile */ }
}

/** 读取某个插件的全部凭据（只给宿主/授权后的插件进程；永远不要塞进日志）。 */
export function readPluginSecrets(dataDir, pluginId) {
  return decryptEnvelope(dataDir, pluginId);
}

/**
 * 合并写入：只覆盖传入的键，`undefined` 表示删除。
 * @param {string[]} allowed 该插件 manifest 声明为 secret 的字段（不在里面的键一律拒）
 */
export function writePluginSecrets(dataDir, pluginId, patch, allowed = []) {
  const allow = new Set(allowed);
  const next = decryptEnvelope(dataDir, pluginId);
  for (const [key, value] of Object.entries(patch || {})) {
    if (!allow.has(key)) throw fail('E_SECRET_DENIED', `字段 ${key} 没有在 manifest.settings 里声明为 secret`);
    if (value === undefined || value === null || value === '') {
      delete next[key];
      continue;
    }
    const text = String(value);
    if (text.length > MAX_VALUE_CHARS) throw fail('E_TOO_BIG', `单个凭据上限 ${MAX_VALUE_CHARS} 字符`);
    next[key] = text;
  }
  writeEnvelope(dataDir, pluginId, next);
}

/** 控制台展示用：只返回哪些字段已配置，不返回任何明文（连前缀都不给）。 */
export function pluginSecretStatus(dataDir, pluginId, fields = []) {
  let secrets = {};
  try { secrets = decryptEnvelope(dataDir, pluginId); } catch (error) {
    return { ok: false, error: error?.message ?? String(error), configured: {} };
  }
  const configured = {};
  for (const key of fields) configured[key] = typeof secrets[key] === 'string' && secrets[key].length > 0;
  return { ok: true, configured };
}

/** 删除某个插件的全部凭据（卸载/重置用）。 */
export function clearPluginSecrets(dataDir, pluginId) {
  try { fs.rmSync(secretFile(dataDir, pluginId)); } catch { /* 本来就不存在 */ }
}

/** manifest 里声明为 secret 的字段名（宿主据此做白名单）。 */
export function secretFieldKeys(settings) {
  const keys = [];
  for (const group of settings?.groups || []) {
    for (const field of group.fields || []) {
      if (field.type === 'secret') keys.push(field.key);
    }
  }
  return keys;
}
