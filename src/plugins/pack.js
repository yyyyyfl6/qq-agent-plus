// 插件打包：把插件目录打成宿主能直接装的 `ustar` tar.gz。
//
// 为什么自己写 tar 而不 shell 出去调系统的 tar：
//  1) 我们的安装器**只认 ustar**（pax 长路径头会被拒），而不同平台的 tar 默认格式不一样
//     （GNU tar 短路径也给 ustar，bsdtar 默认 pax）—— 让作者"在哪个机器上打都一样"；
//  2) 可复现：mtime 固定、条目按名字排序 → **同一份源码打出的包逐字节相同**，
//     于是"CI 里算的 sha256" 与 "作者本地算的" 必然一致；
//  3) 只写普通文件与目录，不写符号链接/设备节点（安装器本来也会拒）。
//
// 打包后由调用方（scripts/plugin-pack.mjs）做一次**真装一遍**的自测：包能不能装，不靠嘴说。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { parsePluginManifest } from './manifest.js';

const BLOCK = 512;
const MAX_NAME = 100;
const MAX_PREFIX = 155;
const MAX_PACKED_BYTES = 5 * 1024 * 1024;   // 与安装器的下载上限一致

const fail = (code, message) => Object.assign(new Error(message), { code });

// 排序**必须与语言环境无关**：localeCompare 走 ICU 默认 locale，而 Windows（本机 zh-CN）与 Linux
// 的大小写/标点权重不同 —— "README.md / index.mjs / plugin.json" 在 zh-CN 下排成
// [index, plugin, README]，在 C 下排成 [README, index, plugin]。包内容一样、字节数一样，sha256
// 却不同，于是"CI 算的校验和 = 作者本地算的"这句承诺当场失效（2026-10-16 跨平台实测抓到）。
// 按码位比（JS 默认的字符串比较）则在任何机器上都得到同一个顺序。
const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

const octal = (value, length) => {
  const text = Math.max(0, Number(value) || 0).toString(8);
  if (text.length > length - 1) throw fail('E_PACK', `字段放不下：${text}`);
  return `${'0'.repeat(length - 1 - text.length)}${text}\0`;
};

/** 长路径拆成 ustar 的 prefix + name 两段（放不下就明确报错，别悄悄截断）。 */
function splitName(name) {
  if (Buffer.byteLength(name) <= MAX_NAME) return { name, prefix: '' };
  const parts = name.split('/');
  for (let i = parts.length - 1; i > 0; i -= 1) {
    const prefix = parts.slice(0, i).join('/');
    const rest = parts.slice(i).join('/');
    if (Buffer.byteLength(prefix) <= MAX_PREFIX && Buffer.byteLength(rest) <= MAX_NAME) return { name: rest, prefix };
  }
  throw fail('E_PACK', `路径太长，ustar 放不下：${name}（把目录层级或文件名改短些）`);
}

function header({ name, size, type, mtime }) {
  const { name: short, prefix } = splitName(name);
  const buf = Buffer.alloc(BLOCK);
  buf.write(short, 0, 'utf8');
  buf.write(octal(type === '5' ? 0o755 : 0o644, 8), 100, 'ascii');
  buf.write(octal(0, 8), 108, 'ascii');            // uid
  buf.write(octal(0, 8), 116, 'ascii');            // gid
  buf.write(octal(size, 12), 124, 'ascii');
  buf.write(octal(mtime, 12), 136, 'ascii');
  buf.write('        ', 148, 'ascii');             // 校验和先按空格算
  buf.write(type, 156, 'ascii');
  buf.write('ustar', 257, 'ascii');                // magic：安装器认的就是它
  buf.write('00', 263, 'ascii');                   // version
  buf.write(prefix, 345, 'utf8');   // 与 name 段同口径：ascii 会把非 ASCII 字节截成低 8 位
  let sum = 0;
  for (const byte of buf) sum += byte;
  buf.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
  return buf;
}

/** 递归收集要打进包里的文件（跳过 node_modules/.git/隐藏文件与 .tar.gz 自身）。 */
export function collectPluginFiles(dir, { root = dir, out = [] } = {}) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort(byName)) {
    if (entry.name.startsWith('.')) continue;                    // .git/.DS_Store/我们自己生成的都别进包
    if (entry.name === 'node_modules') continue;
    // 打好的包本身不进包：作者手工在插件目录里跑过一次 `tar -czf` 之后，那个包会被永久打进后续每一份
    // 新包里（体积递增、sha256 每次都变 —— 现象看起来只是"改了源码"，极难联想）
    if (/\.t(ar\.gz|gz)$/i.test(entry.name)) continue;
    const full = path.join(dir, entry.name);
    const rel = path.relative(root, full).split(path.sep).join('/');
    if (entry.isDirectory()) collectPluginFiles(full, { root, out });
    else if (entry.isFile()) out.push({ name: rel, file: full });
    else throw fail('E_PACK', `插件目录里有不支持的东西（符号链接/设备节点等）：${rel}`);
  }
  return out;
}

/** 把一组文件打成 ustar tar.gz（mtime 固定 0 → 可复现）。 */
export function buildPluginTarball(files, { mtime = 0 } = {}) {
  const chunks = [];
  for (const item of [...files].sort(byName)) {
    const data = readPackable(item.file, item.name);
    chunks.push(header({ name: item.name, size: data.length, type: '0', mtime }));
    chunks.push(data, Buffer.alloc((BLOCK - (data.length % BLOCK)) % BLOCK));
  }
  chunks.push(Buffer.alloc(BLOCK * 2));            // 归档结束（两个全零块）
  return gzipDeterministic(Buffer.concat(chunks));
}

// 这些扩展名按文本处理（行尾归一）。二进制资产（png/woff/…）绝不能动一个字节。
const TEXT_EXT = /\.(?:js|mjs|cjs|json|md|markdown|txt|ya?ml|toml|html|css|svg)$/i;

/**
 * 读一个待打包文件，文本类把 CRLF 统一成 LF。
 *
 * 为什么必须做：Git for Windows 默认 `core.autocrlf=true` —— 作者在 Windows 上 clone 的插件
 * 是 CRLF，同一份源码在 Linux 上打出来的包就不一样。而 docs/PLUGINS.md 承诺"跨平台逐字节一致"
 *（这条承诺是 sha256 能用作内容锚点的前提）。本仓库自己的 `.gitattributes` 只有本仓库有，
 * 外部作者的仓库不继承它 —— 所以在打包器里兜底，而不是在文档里要求别人配。
 */
function readPackable(file, name) {
  const data = fs.readFileSync(file);
  if (!TEXT_EXT.test(String(name || ''))) return data;
  if (!data.includes(0x0d)) return data;
  const text = data.toString('utf8');
  if (!text.includes('\r\n')) return data;
  return Buffer.from(text.replace(/\r\n/g, '\n'), 'utf8');
}

/**
 * gzip 头第 10 个字节是"生成它的操作系统"（OS 字段），zlib 按平台写：Linux=3、Windows=10。
 * 内容、字节数、条目顺序全都一样，压缩流却差一个字节 —— sha256 又对不上（2026-10-16 实测：
 * Windows 3e753a7f…、Linux 5e99d112…，两个包的 gzip 头只差这一字节）。统一写 255（未指定），
 * 和 tar 里被归零的 mtime/uid/gid 是同一类"必须抹掉的平台痕迹"。
 */
function gzipDeterministic(buffer) {
  const gz = zlib.gzipSync(buffer, { level: 9 });
  // FLG 位必须是 0：一旦有 FNAME/FEXTRA 之类的可选字段，OS 就不在第 10 个字节上，
  // 这里的定位会失效 —— 与其悄悄写出平台相关的包，不如当场报错。
  if (gz[0] !== 0x1f || gz[1] !== 0x8b || gz[2] !== 0x08 || gz[3] !== 0x00) {
    throw fail('E_PACK', 'gzip 头不是预期形状（可选字段会挪动 OS 字段），打包不再可复现');
  }
  gz[9] = 0xff;
  return gz;
}

/**
 * 打包一个插件目录：校验 manifest → 收集文件 → 打 tar.gz → 算 sha256。
 * @returns {{ok:true, id, version, file, buffer, sha256, manifest, bytes}} 或抛带 code 的错误
 */
export function packPluginDir({ dir, outDir = null, now = () => Date.now() } = {}) {
  const clock = now;   // 注入点先落到本地常量：scan --strict 不认"直接调用解构参数默认值"这种形状
  const root = path.resolve(String(dir || ''));
  // 把包打进插件目录**自己**里面是最容易犯的错：下一次打包会把上一次的包也收进去（.tar.gz 不是
  // 隐藏文件，collectPluginFiles 不会跳过它），于是包越来越大、sha256 每次都变 —— 而现象看起来
  // 只是"改了源码"，极难联想。宁可当场拒绝，也不让作者带着一个自己变大的包去上架。
  if (outDir) {
    const out = path.resolve(String(outDir));
    if (out === root || out.startsWith(root + path.sep)) {
      throw fail('E_ARGS', `--out（${out}）在插件目录里面：下次打包会把这次打出的包也装进去（改成插件目录外，例如 ../dist）`);
    }
  }
  // 大小写必须精确：Windows/macOS 的文件系统不区分大小写，`Plugin.json` 在本机读得到、
  // 打进包里也能过自测，而 Linux 用户装的时候直接 E_MANIFEST（2026-10-17 审查 P3）
  if (!fs.readdirSync(root).includes('plugin.json')) {
    throw fail('E_ARGS', `${root} 里没有 plugin.json（注意文件名大小写：Linux 上 Plugin.json 不算）`);
  }
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(path.join(root, 'plugin.json'), 'utf8')); }
  catch (error) { throw fail('E_MANIFEST', `plugin.json 读不了：${error?.message ?? error}`); }
  const parsed = parsePluginManifest(raw, { dir: root });
  if (!parsed.ok) throw fail('E_MANIFEST', parsed.error);
  const manifest = parsed.manifest;

  const files = collectPluginFiles(root);
  // 按**相对路径**精确比对（原来只比 basename）：entry 写 `lib/main.mjs` 时，包里随便哪个位置
  // 有个 main.mjs 就能过，而后打包自测通过、装到用户机器上却起不来。
  const entryRel = path.relative(root, manifest.entry).split(path.sep).join('/');
  if (!files.some((item) => item.name === entryRel)) {
    throw fail('E_PACK', `manifest 里的入口 ${entryRel} 不在包里（注意要在插件目录下的同一个相对路径上）`);
  }
  // v1 的硬约定：插件零第三方依赖（安装侧不用在用户机器上跑 npm）
  const deps = new Set();
  for (const item of files) {
    if (item.name === 'package.json') {
      try {
        const pkg = JSON.parse(fs.readFileSync(item.file, 'utf8'));
        for (const key of Object.keys(pkg.dependencies || {})) deps.add(key);
        for (const key of Object.keys(pkg.peerDependencies || {})) deps.add(key);
      } catch { /* 坏 package.json 由 manifest 校验兜着，这里不重复报 */ }
    }
    if (/\.(ts|tsx)$/.test(item.name)) throw fail('E_PACK', `${item.name} 是 TypeScript：请先编译成 JS 再打包（宿主不装构建工具）`);
  }
  if (deps.size) {
    throw fail('E_PACK', `插件里声明了第三方依赖（${[...deps].slice(0, 5).join(', ')}）：v1 只收零依赖插件`
      + `（安装时不跑 npm）。要分发带依赖的插件请把依赖内联进来，或等 v2 的依赖树方案`);
  }
  if (!files.length) throw fail('E_PACK', '目录里没有可打包的文件');

  const buffer = buildPluginTarball(files);
  if (buffer.length > MAX_PACKED_BYTES) {
    throw fail('E_PACK', `打出来 ${(buffer.length / 1024 / 1024).toFixed(1)}MB，超过安装器的 ${MAX_PACKED_BYTES / 1024 / 1024}MB 上限`);
  }
  let file = '';
  if (outDir) {
    fs.mkdirSync(outDir, { recursive: true });
    file = path.join(outDir, `${manifest.id}-${manifest.version}.tar.gz`);
    fs.writeFileSync(file, buffer);
  }
  return {
    ok: true,
    id: manifest.id,
    version: manifest.version,
    manifest,
    file,
    buffer,
    bytes: buffer.length,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    fileCount: files.length,
    packedAt: clock()
  };
}

/**
 * 生成可直接粘进索引的条目（字段名照 OneBot 生态事实标准 NapCat 那套：
 * downloadUrl / minVersion / tags），外加我们比它严的 sha256 与 apiVersion。
 */
export function indexEntryFor(packed, { baseUrl = '', tag = '', minVersion = '', tags = [], homepage = '', author = '' } = {}) {
  const fileName = `${packed.id}-${packed.version}.tar.gz`;
  const downloadUrl = baseUrl
    ? `${String(baseUrl).replace(/\/$/, '')}${tag ? `/releases/download/${tag}` : ''}/${fileName}`
    : `<把 ${fileName} 上传到哪里，就填哪里的直链>`;
  return {
    id: packed.id,
    name: packed.manifest.name,
    version: packed.version,
    description: packed.manifest.description || '',
    author: author || '<你的名字>',
    homepage: homepage || '<源码仓库或说明页的链接>',
    apiVersion: packed.manifest.apiVersion,
    minVersion: minVersion || '<插件要求的宿主最低版本，例如 0.8.5>',
    tags: tags.length ? tags : ['社区'],
    capabilities: packed.manifest.capabilities,
    downloadUrl,
    sha256: packed.sha256
  };
}
