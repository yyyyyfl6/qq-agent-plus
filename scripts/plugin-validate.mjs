#!/usr/bin/env node
// 插件清单校验：用宿主自己的 validator（唯一真源）跑一遍，并打印权限面摘要。
// 用法：node scripts/plugin-validate.mjs <插件目录> [--json]
import fs from 'node:fs';
import path from 'node:path';
import { parsePluginManifest } from '../src/plugins/manifest.js';

const args = process.argv.slice(2);
const target = path.resolve(args.find((arg) => !arg.startsWith('--')) || '.');
const asJson = args.includes('--json');

let raw = null;
try {
  raw = JSON.parse(fs.readFileSync(path.join(target, 'plugin.json'), 'utf8'));
} catch (error) {
  console.error(`✗ 读不到 ${path.join(target, 'plugin.json')}：${error?.message || error}`);
  process.exit(1);
}

const checked = parsePluginManifest(raw, { dir: target });
if (!checked.ok) {
  console.error(`✗ ${checked.error}`);
  process.exit(1);
}

const manifest = checked.manifest;
const summary = {
  id: manifest.id,
  version: manifest.version,
  apiVersion: manifest.apiVersion,
  capabilities: manifest.capabilities,
  httpDomains: manifest.httpDomains || [],
  tools: manifest.tools.map((tool) => ({
    name: tool.name,
    action: tool.action || '',
    actionTarget: tool.actionTarget || ''
  })),
  approvals: (manifest.approvals || []).map((item) => item.action),
  quotas: manifest.quotas || {},
  schedule: (manifest.schedule || []).map((item) => `${item.name} / ${item.everyMs}ms`),
  engines: manifest.engines || {}
};

if (asJson) {
  process.stdout.write(`${JSON.stringify({ ok: true, manifest: summary }, null, 2)}\n`);
  process.exit(0);
}

console.log(`✓ ${manifest.id} v${manifest.version}（apiVersion ${manifest.apiVersion}）`);
console.log(`  能力:    ${manifest.capabilities.join(', ')}`);
if (summary.httpDomains.length) console.log(`  域名:    ${summary.httpDomains.join(', ')}`);
console.log(`  工具:    ${manifest.tools.map((tool) => tool.name).join(', ')}`);
const writes = manifest.tools.filter((tool) => tool.action);
if (writes.length) {
  console.log(`  写动作:  ${writes.map((tool) => `${tool.name}→${tool.action}(${tool.actionTarget || '无目标'})`).join(', ')}`);
}
if (summary.approvals.length) console.log(`  待批准:  ${summary.approvals.join(', ')}`);
if (Object.keys(summary.quotas).length) console.log(`  配额:    ${Object.entries(summary.quotas).map(([key, value]) => `${key}=${value}`).join(', ')}`);
if (summary.schedule.length) console.log(`  周期:    ${summary.schedule.join(', ')}`);
const devSettings = path.join(target, 'dev-settings.json');
if (fs.existsSync(devSettings)) {
  try {
    const parsed = JSON.parse(fs.readFileSync(devSettings, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('必须是对象');
    console.log('  dev:     dev-settings.json 可读');
  } catch (error) {
    console.error(`✗ dev-settings.json 不是合法对象：${error?.message || error}`);
    process.exit(1);
  }
}
