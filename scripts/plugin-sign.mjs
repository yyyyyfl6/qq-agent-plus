#!/usr/bin/env node
// 发布者签名：生成密钥对 / 给包签名 / 校验签名（Ed25519，只用 Node 自带 crypto，不装任何东西）。
//
// 这套东西解决的问题很窄，说清楚免得当成万灵药：**它只证明"这个包确实是那把私钥的主人发的"**。
// 至于"该不该信这个人"，那是索引人工审核的事（谁提的 PR、谁维护的仓库）。
// 宿主侧怎么用：配置里登记 `plugins.publishers: { "<发布者名>": "<公钥>" }`，安装时宿主自动验签；
// 登记过公钥的发布者，包没签名或验不过就**拒绝安装**（fail-closed）；没登记公钥的照常装，
// 但来源记录里标"未验证"、控制台会显示出来。
//
// 用法：
//   node scripts/plugin-sign.mjs --keygen --out ~/.qq-agent-plugin-key
//       → 生成 <out>.key（私钥，务必自己收好）与 <out>.pub（公钥，登记给使用者/贴进索引 PR）
//   node scripts/plugin-sign.mjs --key ~/.qq-agent-plugin-key.key --pack plugins/packages/weather-1.0.0.tar.gz
//       → 打印可粘进索引条目的 signature（base64）
//   node scripts/plugin-sign.mjs --key ~/.qq-agent-plugin-key.key --verify --pack <包> --signature <base64>
//       → 本地自查一遍（与宿主侧同一份实现）
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { verifyPluginSignature } from '../src/plugins/install.js';

const args = process.argv.slice(2);
const has = (name) => args.includes(`--${name}`);
const flag = (name, fallback = '') => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : (args[i + 1] ?? fallback);
};

if (has('keygen')) {
  const out = path.resolve(flag('out') || path.join(process.cwd(), 'plugin-signing-key'));
  if (fs.existsSync(`${out}.key`) && !has('force')) {
    console.error(`✗ ${out}.key 已存在（不想覆盖就换个 --out，确实要重生成加 --force —— 覆盖后旧签名全失效）`);
    process.exit(2);
  }
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  fs.writeFileSync(`${out}.key`, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  fs.writeFileSync(`${out}.pub`, `${raw.toString('base64')}\n`);
  console.log(`✓ 已生成密钥对：
  私钥（**不要**外传、不要进仓库）：${out}.key
  公钥（贴给使用者/写进索引 PR 说明）：${out}.pub
    ${raw.toString('base64')}

下一步：
  1) 签名：node scripts/plugin-sign.mjs --key ${out}.key --pack plugins/packages/<你的包>.tar.gz
  2) 把打印出来的 signature 与 publisher 一起写进索引条目
  3) 使用者侧登记公钥：plugins.publishers["<publisher>"] = "<上面的公钥 base64>"`);
  process.exit(0);
}

const packFile = flag('pack');
if (!packFile) {
  console.error('用法：node scripts/plugin-sign.mjs --keygen [--out 前缀] | --key <私钥> --pack <包> [--verify --signature <base64>]');
  process.exit(2);
}
const buffer = fs.readFileSync(path.resolve(packFile));
if (has('verify')) {
  const publicKey = flag('pub') || (() => {
    const keyFile = flag('key');
    if (!keyFile) return '';
    const priv = crypto.createPrivateKey(fs.readFileSync(path.resolve(keyFile)));
    return crypto.createPublicKey(priv).export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
  })();
  const verdict = verifyPluginSignature({ buffer, signature: flag('signature'), publicKey });
  console.log(verdict.ok ? '✓ 签名与包内容一致（用的是宿主侧同一份实现）' : `✗ ${verdict.error}`);
  process.exit(verdict.ok ? 0 : 1);
}

const keyFile = flag('key');
if (!keyFile) {
  console.error('✗ 签名需要 --key <私钥文件>（没有就先 --keygen）');
  process.exit(2);
}
const signature = crypto.sign(null, buffer, crypto.createPrivateKey(fs.readFileSync(path.resolve(keyFile))));
const sha = crypto.createHash('sha256').update(buffer).digest('hex');
console.log(`包：${path.relative(process.cwd(), path.resolve(packFile))}（${buffer.length} 字节）
sha256：${sha}

把这两行写进索引条目（publisher 是你登记给使用者的名字，signature 是下面这串）：
  "publisher": "<发布者名>",
  "signature": "${signature.toString('base64')}"`);
