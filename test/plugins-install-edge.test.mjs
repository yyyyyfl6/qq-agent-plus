// 安装器在"并发 / 环境不可写"这类复杂情况下的行为。
//
// 为什么会想测这两个：控制台里"安装"是一次点击，但用户会连点、会在两个标签页里同时点、
// 会在磁盘满或目录只读的机器上装。这几种情况下**最终状态**必须是可解释的：
// 要么装好、要么明确失败且没留下半成品；绝不能出现"两个都没装成、旧的也被回滚掉"。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const { installPlugin, rollbackPlugin } = await import('../src/plugins/install.js');
const { buildTar } = await import('./helpers/tar.mjs');
const { packPluginDir } = await import('../src/plugins/pack.js');

/** 造一个最小的合法插件目录，并打成宿主能装的包。 */
function makeTarball(t, id, version = '1.0.0') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `qq-race-src-${id}-`));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({
    id, apiVersion: 1, name: `并发 ${id}`, version, description: 'race fixture',
    entry: 'index.mjs', capabilities: ['tools'],
    tools: [{ name: 'ping', description: 'ping', parameters: { type: 'object', properties: {} } }]
  }));
  fs.writeFileSync(path.join(dir, 'index.mjs'),
    "const send=(m)=>process.stdout.write(JSON.stringify(m)+'\\n');\n"
    + "process.stdin.on('data',(c)=>{for(const line of String(c).split('\\n')){if(!line.trim())continue;"
    + "let m;try{m=JSON.parse(line)}catch{continue}"
    + "if(m.method==='init')send({id:m.id,result:{ok:true}});"
    + "else if(m.method==='shutdown')process.exit(0);"
    + "else if(m.method==='callTool')send({id:m.id,result:{pong:true}});}});\n");
  const packed = packPluginDir({ dir });
  assert.ok(packed.sha256, '夹具要能打包');
  return { tarball: packed.buffer, id, version };
}

const dataDirs = [];
function makeDataDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-race-data-'));
  dataDirs.push(dir);
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 句柄占用就算了 */ } });
  return dir;
}

/**
 * 只找**半成品**：`.staging-*` 是解包到一半的目录，必须清干净。
 * `.backup-*` 是升级的刻意产物（旧版本备份，保留最近 3 份），不是残留 —— 并发装同一个包时
 * 后到的那次会把先到的当成"旧版"备份起来，这是预期的升级语义。
 */
const leftovers = (dataDir) => {
  const root = path.join(dataDir, 'plugins');
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).filter((name) => name.startsWith('.staging-'));
};

test('并发安装同一个包：最终必须是一个可用的插件，且不留 staging 残留', async (t) => {
  const dataDir = makeDataDir(t);
  const pkg = makeTarball(t, 'race-demo');

  const results = await Promise.allSettled([
    installPlugin({ ...pkg, dataDir }),
    installPlugin({ ...pkg, dataDir })
  ]);

  const ok = results.filter((r) => r.status === 'fulfilled').length;
  assert.ok(ok >= 1, `两个并发安装至少成功一个：${results.map((r) => (r.status === 'rejected' ? r.reason?.message : 'ok')).join(' | ')}`);

  // 关键断言：**装完的树必须是完整的**（manifest + entry 都在）。竞争里最坏的形态是
  // "两边都把对方换入的目录挪走/回滚"，最后剩下的目录缺文件 —— 那比失败更糟。
  const target = path.join(dataDir, 'plugins', 'race-demo');
  assert.ok(fs.existsSync(path.join(target, 'plugin.json')), '装完之后插件目录里必须有 plugin.json');
  assert.ok(fs.existsSync(path.join(target, 'index.mjs')), '装完之后 entry 文件必须在');
  const manifest = JSON.parse(fs.readFileSync(path.join(target, 'plugin.json'), 'utf8'));
  assert.equal(manifest.id, 'race-demo');

  assert.deepEqual(leftovers(dataDir), [], `并发安装不许留下解包到一半的目录：${leftovers(dataDir).join(', ')}`);

  // 备份是允许的（那一次算"升级"），但必须也是**完整可用的**旧副本，并且不超过保留上限
  const pluginsRoot = path.join(dataDir, 'plugins');
  const backups = fs.readdirSync(pluginsRoot).filter((name) => name.startsWith('.backup-race-demo.'));
  assert.ok(backups.length <= 3, `备份最多保留 3 份（实际 ${backups.length}）`);
  for (const name of backups) {
    assert.ok(fs.existsSync(path.join(pluginsRoot, name, 'plugin.json')), `备份 ${name} 也要是完整的一份`);
  }
});

test('连装 5 次：备份只保留 3 份，最终版本是最新的', async (t) => {
  const dataDir = makeDataDir(t);
  for (let i = 1; i <= 5; i += 1) {
    const pkg = makeTarball(t, 'multi-demo', `1.0.${i}`);
    const out = await installPlugin({ ...pkg, dataDir });
    assert.equal(out.version, `1.0.${i}`);
  }
  const pluginsRoot = path.join(dataDir, 'plugins');
  const backups = fs.readdirSync(pluginsRoot).filter((name) => name.startsWith('.backup-multi-demo.'));
  assert.ok(backups.length <= 3, `连装 5 次之后备份最多 3 份（实际 ${backups.length}）`);
  assert.equal(JSON.parse(fs.readFileSync(path.join(pluginsRoot, 'multi-demo', 'plugin.json'), 'utf8')).version, '1.0.5');
  assert.deepEqual(leftovers(dataDir), []);
});

test('安装到不可写的目录：明确失败、不留下半成品（部署机上目录权限错了会长这样）', { skip: process.platform === 'win32' ? 'chmod 在 Windows 上不生效' : false }, async (t) => {
  const dataDir = makeDataDir(t);
  const pluginsRoot = path.join(dataDir, 'plugins');
  fs.mkdirSync(pluginsRoot, { recursive: true });
  fs.chmodSync(pluginsRoot, 0o555);          // r-x：能进不能写
  t.after(() => { try { fs.chmodSync(pluginsRoot, 0o755); } catch { /* 已还原 */ } });

  const pkg = makeTarball(t, 'readonly-demo');
  await assert.rejects(
    () => installPlugin({ ...pkg, dataDir }),
    (error) => {
      assert.ok(error, '不可写目录必须抛错，而不是"装成功了"');
      assert.ok(/EACCES|EPERM|permission|权限|denied/i.test(String(error.message ?? error)),
        `错误里要说清是权限问题：${error.message}`);
      return true;
    }
  );

  const entries = fs.existsSync(pluginsRoot) ? fs.readdirSync(pluginsRoot) : [];
  assert.deepEqual(entries.filter((n) => n.startsWith('.staging-')), [], '失败后不许留 staging（目录不可写时它连建都建不出来，这条是兜底）');
  assert.equal(fs.existsSync(path.join(pluginsRoot, 'readonly-demo')), false, '失败的安装不该留下插件目录');
});

test('升级换入前会通知调用方停掉旧进程（Windows 上 rename 存活进程的 cwd 会失败）', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-install-before-replace-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const calls = [];

  // 首次安装：没有旧目录 → 不该触发（下载/解包失败的路径也就不必白白停插件）
  await installPlugin({
    tarball: makeTarball(t, 'swapme', '1.0.0').tarball, dataDir, log: () => {},
    beforeReplace: (id) => { calls.push(id); }
  });
  assert.deepEqual(calls, [], '首次安装没有"旧进程"可停');

  // 升级：换入前**必须**先停（否则 Windows 上 rename 直接 EPERM）
  await installPlugin({
    tarball: makeTarball(t, 'swapme', '1.1.0').tarball, dataDir, log: () => {},
    beforeReplace: (id) => { calls.push(id); }
  });
  assert.deepEqual(calls, ['swapme'], '升级前要按最终 id 通知一次');
  const manifest = JSON.parse(fs.readFileSync(path.join(dataDir, 'plugins', 'swapme', 'plugin.json'), 'utf8'));
  assert.equal(manifest.version, '1.1.0');
});

test('回退后 install.json 必须描述回退到的版本（不能继续显示被回退掉的那份）', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-install-rollback-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  await installPlugin({ tarball: makeTarball(t, 'rollme', '1.0.0').tarball, dataDir, log: () => {} });
  await installPlugin({ tarball: makeTarball(t, 'rollme', '2.0.0').tarball, dataDir, log: () => {} });
  rollbackPlugin({ id: 'rollme', dataDir, log: () => {} });

  const record = JSON.parse(fs.readFileSync(path.join(dataDir, 'plugin-data', 'rollme', 'install.json'), 'utf8'));
  assert.equal(record.version, '1.0.0', '记录要跟着回退后的版本走');
  assert.equal(record.sha256, '', '备份里没有原始包，指纹无法重算 —— 不能继续沿用上一版的');
  assert.match(record.source, /回退自 2\.0\.0/, '来源里要注明从哪个版本回退');
});

test('包里的 manifest 文件名必须精确是小写 plugin.json（Windows 上 Plugin.json 也能读到）', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-install-case-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const manifest = JSON.stringify({
    id: 'case-demo', apiVersion: 1, name: '大小写', version: '1.0.0', description: 'case',
    entry: 'index.mjs', capabilities: ['tools'],
    tools: [{ name: 'ping', description: 'p', parameters: { type: 'object', properties: {} } }]
  });
  const tarball = buildTar([
    { name: 'Plugin.json', data: manifest },
    { name: 'index.mjs', data: "process.stdin.on('data', () => {});" }
  ]);
  await assert.rejects(
    () => installPlugin({ tarball, id: 'case-demo', dataDir, log: () => {} }),
    (error) => error.code === 'E_MANIFEST' && /大小写/.test(error.message)
  );
});
