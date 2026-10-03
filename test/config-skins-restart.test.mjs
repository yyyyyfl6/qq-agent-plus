import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';

const configUrl = new URL('../src/core/config.js', import.meta.url).href;
const skinsUrl = new URL('../src/skins/skins.js', import.meta.url).href;
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-skins-restart-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const skins = {
    enabled: true, default: 'fish', switchCommands: ['/skin'], ack: '切到 {label}',
    list: [
      { id: 'fish', label: '蓝色大肥鱼', templateId: 'custom_1', commands: ['切鱼'], model: 'deepseek-flash' },
      { id: 'cat', label: '哈基米', templateId: 'custom_2', commands: ['切猫'], model: 'gemini-test' },
      { id: 'tieba', label: '贴吧鱼', templateId: 'custom_0', commands: ['切贴吧'], model: 'deepseek-flash' }
    ],
    handoffOnSwitch: { enabled: true, model: 'deepseek-chat', provider: 'summary', maxChars: 1400, recentMessages: 40 }
  };
  const config = { skins, customPersonas: [
    { name: '贴吧鱼', text: '贴吧鱼原文' }, { name: '蓝色大肥鱼', text: '蓝色大肥鱼原文' }, { name: '哈基米', text: '哈基米原文' }
  ] };
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config));
  return { dir, config };
}
function boot(dir) {
  const code = `
    import fs from 'node:fs';
    import { getConfig, scheduleConfigSave } from ${JSON.stringify(configUrl)};
    import { SkinManager } from ${JSON.stringify(skinsUrl)};
    const cfg = getConfig({ unscoped: true });
    const manager = new SkinManager({ store: {}, getConfig: () => ({ ...cfg, skins: { ...cfg.skins, enabled: false } }) });
    const settings = manager.settings;
    scheduleConfigSave();
    await new Promise(r => setTimeout(r, 600));
    const disk = JSON.parse(fs.readFileSync(process.env.QQ_AGENT_DATA_DIR + '/config.json', 'utf8'));
    console.log(JSON.stringify({ skins: cfg.skins, customs: cfg.customPersonas, settings, diskSkins: disk.skins }));
  `;
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', code], {
    env: { ...process.env, QQ_AGENT_DATA_DIR: dir }, encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe']
  }));
}
test('three custom personas and summary model survive two fresh process boots and automatic saves', (t) => {
  const { dir, config } = fixture(t);
  for (let restart = 0; restart < 2; restart++) {
    const loaded = boot(dir);
    assert.equal(loaded.skins.enabled, true);
    assert.deepEqual(loaded.skins.list.map(s => [s.id, s.templateId, s.commands]), [
      ['fish', 'custom_1', ['切鱼']], ['cat', 'custom_2', ['切猫']], ['tieba', 'custom_0', ['切贴吧']]
    ]);
    assert.deepEqual(loaded.skins.handoffOnSwitch, config.skins.handoffOnSwitch);
    assert.deepEqual(loaded.diskSkins, loaded.skins);
    assert.deepEqual(loaded.customs, config.customPersonas);
  }
});
test('invalid preset disables runtime safely while retaining persona list, settings and original backup', (t) => {
  const { dir, config } = fixture(t);
  config.skins.list[2].templateId = 'custom_99';
  const original = JSON.stringify(config);
  fs.writeFileSync(path.join(dir, 'config.json'), original);
  const loaded = boot(dir);
  assert.equal(loaded.skins.enabled, false);
  assert.deepEqual(loaded.diskSkins.list, config.skins.list);
  assert.deepEqual(loaded.diskSkins.handoffOnSwitch, config.skins.handoffOnSwitch);
  assert.equal(loaded.settings.enabled, false);
  const backups = fs.readdirSync(dir).filter(f => f.startsWith('config.json.skins-invalid-'));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, backups[0]), 'utf8'), original);
});
