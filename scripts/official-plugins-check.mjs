#!/usr/bin/env node
// 官方插件打包与安装冒烟：每个 examples/plugins/* 在干净数据目录里真打一遍、真装一遍、再卸载。
// 不启动插件进程、不联网；只验证"包能不能装、清单能不能过宿主校验"。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { packPluginDir } from '../src/plugins/pack.js';
import { installPlugin, uninstallPlugin } from '../src/plugins/install.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const examples = path.join(ROOT, 'examples', 'plugins');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-official-plugins-'));

let failed = 0;
let checked = 0;
try {
  const dirs = fs.readdirSync(examples, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const name of dirs) {
    const dir = path.join(examples, name);
    if (!fs.existsSync(path.join(dir, 'plugin.json'))) continue;
    checked += 1;
    const dataDir = path.join(temp, `data-${name}`);
    try {
      const packed = packPluginDir({ dir, outDir: path.join(temp, 'packs') });
      await installPlugin({
        id: packed.id,
        tarball: packed.buffer,
        dataDir,
        log: () => {}
      });
      const installed = path.join(dataDir, 'plugins', packed.id, 'plugin.json');
      if (!fs.existsSync(installed)) throw new Error('安装后找不到 plugin.json');
      uninstallPlugin({ id: packed.id, dataDir });
      console.log(`OK   ${name} v${packed.version}（${packed.fileCount} 个文件，${(packed.bytes / 1024).toFixed(1)}KB）`);
    } catch (error) {
      failed += 1;
      console.error(`FAIL ${name}: ${error?.message || error}`);
    }
  }
} finally {
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

if (!checked) {
  console.error('没有找到任何官方插件（examples/plugins/*/plugin.json）');
  process.exit(1);
}
console.log(`\n官方插件冒烟：${checked - failed}/${checked} 通过`);
process.exit(failed ? 1 : 0);
