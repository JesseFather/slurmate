#!/usr/bin/env node
/**
 * test-packer.mjs —— 打包器的用例。
 *
 * ★ 这一组测的是**它拒得对不对**，不是成功路径。每一条对应一件能让作者说出
 *   一句错话的事：
 *
 *     「打好了」而负载里混进了上一次打包留下的 .splug（于是摘要每次都变）
 *     「打好了」而树里有个符号链接被当成普通文件装了进来
 *     「只改了一个键」而写回把 `\u` 转义和数字写法都重排了一遍
 *     「两个包一样」而它们其实差在排序上
 *     「版本号没问题」而它放行了前导零
 *
 * ★ 判据不是这里写的，是 `tools/conformance/`。而且这里**顺带把客户端那一份
 *   读方也拉进来跑同一批坏包** —— 三份实现里这两份都在 JS 里，让它们在同一
 *   批字节上给出同一个理由词，是"三端一致"这条契约里最容易分家的一半。
 *
 * 用法：`node packer/test-packer.mjs`（不需要 Electron、不需要网络、不需要这个
 *       仓库处于任何特定的提交状态 —— 它自己造临时仓库）
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PACKER = path.join(HERE, 'slurmate-packer.js');
const P = require('./slurmate-packer.js');
const C = require(path.join(ROOT, 'client', 'src', 'main', 'plugin-package.js'));

const CONF = path.join(ROOT, 'tools', 'conformance');
const EXPECTED = JSON.parse(fs.readFileSync(path.join(CONF, 'expected.json'), 'utf8'));
const BAD = JSON.parse(fs.readFileSync(path.join(CONF, 'bad.json'), 'utf8'));
const unhex = (lines) => Buffer.from(lines.join(''), 'hex');

let PASS = 0;
let FAIL = 0;
function check(desc, cond, detail = '') {
  if (cond) { PASS++; console.log(`  [PASS] ${desc}`); } else {
    FAIL++; console.log(`  [FAIL] ${desc}  ${detail}`);
  }
}
function section(t) { console.log(`\n── ${t} ──`); }

// ==============================================================================
//  临时仓库
// ==============================================================================

const TMP = [];

function mkRepo(files, opts = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'slurmate-packer-'));
  TMP.push(base);
  const plug = path.join(base, 'plug');
  fs.mkdirSync(plug, { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(plug, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
  for (const [rel, target] of Object.entries(opts.links || {})) {
    const full = path.join(plug, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.symlinkSync(target, full);
  }
  for (const [rel, mode] of Object.entries(opts.modes || {})) {
    fs.chmodSync(path.join(plug, rel), mode);
  }
  const git = (...a) => execFileSync('git', ['-C', base, '-c', 'user.email=t@example.com',
    '-c', 'user.name=t', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false'].concat(a),
  { encoding: 'utf8', maxBuffer: 1 << 28 });
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-qm', 't');
  return { base, plug, git };
}

/** 跑一次打包器 CLI，返回 `{code, out, err}`。 */
function packer(...args) {
  try {
    const out = execFileSync(process.execPath, [PACKER].concat(args),
      { encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out, err: '' };
  } catch (e) {
    return { code: e.status == null ? -1 : e.status, out: e.stdout || '', err: e.stderr || '' };
  }
}

/** 一个最小的、合法的清单。 */
const mf = (over = {}) => `${JSON.stringify({
  id: '01M2JKHTZGQ7X8V4T5R6N7B8C9',
  name: 'plug',
  displayName: '插件',
  version: '1.0.0',
  description: 'x',
  author: 'a',
  engines: { slurmate: '>=0.5' },
  ...over,
}, null, 2)}\n`;

const baseFiles = () => ({
  'plugin.json': mf(),
  'client/index.js': 'module.exports = {};\n',
  'job/start.sh': '#!/bin/bash\necho hi\n',
});

// ==============================================================================
//  1. 打出来的字节 == 符合性向量里那份
// ==============================================================================

section('1. 一个提交 ⇒ 一份确定的字节');

{
  // 用符合性向量那棵**真的**输入树（不是这里另造一棵）—— 于是"打包器的输出"
  // 与"三端共用的那份期望值"是同一次比对，而不是两处各自说对。
  const { base, plug } = mkRepo(
    Object.fromEntries(walkTree(path.join(CONF, 'tree'))));
  fs.chmodSync(path.join(plug, 'job', 'start.sh'), 0o755);
  const { git } = { git: (...a) => execFileSync('git', ['-C', base, '-c', 'user.email=t@example.com',
    '-c', 'user.name=t', '-c', 'commit.gpgsign=false'].concat(a), { encoding: 'utf8' }) };
  git('add', '-A');
  git('commit', '-qm', 'chmod');

  const out1 = path.join(base, 'a.splug');
  const out2 = path.join(base, 'b.splug');
  const r1 = packer('build', plug, '--commit', 'HEAD', '--out', out1);
  const r2 = packer('build', plug, '--commit', 'HEAD', '--out', out2);
  check('打包成功', r1.code === 0, r1.err);
  const b1 = fs.readFileSync(out1);
  const b2 = fs.readFileSync(out2);
  check('★★ 打出来的字节**逐字节**等于符合性向量里那份（三端共用的期望值）',
    b1.equals(unhex(EXPECTED.package.hex)),
    `得到 ${b1.length} 字节 / ${crypto.createHash('sha256').update(b1).digest('hex').slice(0, 16)}，`
    + `期望 ${EXPECTED.package.bytes} 字节 / ${EXPECTED.package.sha256.slice(0, 16)}`);
  check('★ 同一个提交打两次，逐字节相同（§3.5）', b1.equals(b2));
  const parsed = P.parsePackage(b1);
  check('★ 内容摘要与夹具一致', parsed.ok && parsed.digest === EXPECTED.digest,
    parsed.ok ? parsed.digest : `${parsed.code} ${parsed.why}`);
  check('★★ 记录次序是 **UTF-8 字节序**（不是 JS 的 `<`）',
    parsed.ok && parsed.files.map((f) => f.path).join('\n')
      === EXPECTED.files.map((f) => f.path).join('\n'),
    parsed.ok ? parsed.files.map((f) => f.path).join('、') : '');
  check('★ 而 JS 的 `<` 会给一个**不同**的次序（这一条说明上一条不是在防假想）',
    [...EXPECTED.files.map((f) => f.path)].sort((a, b) => (a < b ? -1 : 1)).join('\n')
      !== EXPECTED.files.map((f) => f.path).join('\n'));

  // 0755 归一成 0644 时**必须说一声** —— 它确实丢了信息
  check('★ 树里那份 100755 被归一掉时，输出里说了这件事（不许静默）',
    /100755/.test(r1.out) && /0644/.test(r1.out), JSON.stringify(r1.out.slice(-200)));

  // verify --against：§3.6 的用例住在这里（部署期没有源码树可对照）
  const v = packer('verify', out1, '--against', plug);
  check('★ verify --against：负载与源码树逐字节相同（§3.6）',
    v.code === 0 && /§3\.6/.test(v.out), v.out + v.err);
  // ★ `--against` 比的是**提交**（§3.5）：所以要先提交，再比。
  //   只改工作树是不够的 —— 那正是"输入是一个提交、不是工作树"那句话的意思。
  fs.appendFileSync(path.join(plug, 'client', 'index.js'), '// 改了\n');
  git('add', '-A');
  git('commit', '-qm', '改了');
  const v2 = packer('verify', out1, '--against', plug);
  check('★ 改了一份源码并提交之后再 --against ⇒ 明确指出是哪一份，且非零退出',
    v2.code !== 0 && /只(在包里|在源码树里)/.test(v2.err),
    JSON.stringify(v2.err.slice(-260)));
}

// ==============================================================================
//  2. 不该进包的东西
// ==============================================================================

section('2. 不该进包的东西：排除并说出来，或者干脆拒绝');

{
  const { plug, base } = mkRepo({
    ...baseFiles(),
    '.gitignore': 'node_modules\n',
    '.github/workflows/x.yml': 'name: x\n',
    'node_modules/dep/index.js': 'x\n',
    'old.splug': Buffer.from('上一次打出来的包\n'),
  });
  const out = path.join(base, 'o.splug');
  const r = packer('build', plug, '--out', out);
  check('打好了', r.code === 0, r.err);
  const parsed = P.parsePackage(fs.readFileSync(out));
  const names = parsed.ok ? parsed.files.map((f) => f.path) : [];
  check('★ 跳过表里的东西一个都没进负载',
    !names.some((p) => /\.gitignore|\.github|node_modules/.test(p)), names.join('、'));
  check('★★ 上一次打出来的 .splug 没进负载（进了的话摘要每次都变）',
    !names.includes('old.splug'), names.join('、'));
  check('★ 而且输出里**说了**跳过了几项（静默少东西是这个仓库最忌讳的一类）',
    /跳过/.test(r.out) && /splug|gitignore/.test(r.out), JSON.stringify(r.out.slice(-260)));

  // 包落在自己的源码树里 ⇒ 拒绝（在写之前）
  const inTree = packer('build', plug, '--out', path.join(plug, 'self.splug'));
  check('★★ 输出落在插件自己的源码树里 ⇒ 拒绝，而且一个字节都没写',
    inTree.code !== 0 && /源码树/.test(inTree.err)
    && !fs.existsSync(path.join(plug, 'self.splug')), inTree.err);
}

{
  const { plug, base } = mkRepo(baseFiles(), { links: { 'client/link.js': '../x.js' } });
  const r = packer('build', plug, '--out', path.join(base, 'o.splug'));
  check('★★ 符号链接 ⇒ 拒绝整个包（它进了负载就是"内容恰好是那个目标串的普通文件"）',
    r.code !== 0 && /符号链接/.test(r.err), r.err);
}

{
  const { plug, base } = mkRepo({ ...baseFiles(), 'Client/x.js': 'a\n', 'client/x.js': 'b\n' });
  const r = packer('build', plug, '--out', path.join(base, 'o.splug'));
  check('★★ 只差大小写的两条路径 ⇒ 拒绝（磁盘上会互相覆盖，而摘要按磁盘算）',
    r.code !== 0 && /大小写/.test(r.err), r.err);
}

{
  // ★ 而 `İ`（U+0130）与 `i` **不**算只差大小写：折叠是 ASCII-only 的。
  //   全 Unicode 的 toLowerCase 会把它们折到一起 —— 那会让两个实现一边收一边拒。
  const { plug, base } = mkRepo({ ...baseFiles(), 'İ.js': 'a\n', 'i.js': 'b\n' });
  const r = packer('build', plug, '--out', path.join(base, 'o.splug'));
  const withIdot = path.join(base, 'o.splug');
  check('★ `İ` 与 `i` 不是"只差大小写"（ASCII-only 折叠 —— 全 Unicode 的会判成冲突）',
    r.code === 0
    && P.parsePackage(fs.readFileSync(withIdot)).files.map((f) => f.path).includes('İ.js'),
    `${r.err} ${r.code === 0 ? P.parsePackage(fs.readFileSync(withIdot)).files.map((f) => f.path).join('、') : ''}`);
  check('★ 而 `İ`.toLowerCase() 确实会折成 `i`（说明上一条不是在防一个假想）',
    'İ'.toLowerCase().normalize('NFC') !== 'İ');
}

{
  const { plug, base } = mkRepo(baseFiles());
  const r = packer('build', plug, '--out', path.join(base, 'o.splug'), '--commit', 'HEAD');
  check('★ 树不脏时能打（对照组）', r.code === 0, r.err);
  fs.appendFileSync(path.join(plug, 'client', 'index.js'), '// 未提交\n');
  const r2 = packer('build', plug, '--out', path.join(base, 'o2.splug'));
  check('★★ 工作树脏了 ⇒ 拒绝打包（§3.5：输入是一个**提交**，不是工作树）',
    r2.code !== 0 && /不干净/.test(r2.err), r2.err);
}

// ==============================================================================
//  3. init：铸 id 与**插入**写回
// ==============================================================================

section('3. init —— 铸一个 id，只动一个键');

{
  const original = `{
  "name": "x",
  "displayName": "\\u4e2d\\u6587",
  "version": "1.0.0",
  "n": 1e3,
  "z": [1, 2]
}
`;
  const { plug } = mkRepo({ 'plugin.json': original, 'client/index.js': 'x\n' });
  const r = packer('init', plug);
  check('init 成功', r.code === 0, r.err);
  const after = fs.readFileSync(path.join(plug, 'plugin.json'), 'utf8');
  // ★ 解析放在 try 里：写回要是少了一个逗号，这里是**一份不合法的 JSON**，
  //   而 `JSON.parse` 抛出去会让整个脚本**崩**掉 —— 后面每一条用例都不会跑，
  //   于是"改坏了哪一处"这个问题就没有答案了（CI 上它看起来还像基础设施故障，
  //   不像一条失败的用例）。变异验证里就撞上过这一次。
  let obj = null;
  try {
    obj = JSON.parse(after);
  } catch (e) {
    check('★ init 写回的是一份**合法的 JSON**', false, e.message);
  }
  check('★ 铸出来的 id 是一个 26 字符的 ULID',
    !!obj && P.ULID_RE.test(obj.id), obj ? obj.id : '(JSON 不合法，上面那条已经报了)');
  if (!obj) obj = {};
  check('★ 其余键**一个都没动**（值逐字相同）',
    obj.name === 'x' && obj.displayName === '中文' && obj.version === '1.0.0'
    && obj.n === 1000 && Array.isArray(obj.z));
  check('★★ `\\u4e2d\\u6587` 还是转义写法（JSON.parse + stringify 会把它还原成汉字）',
    after.includes('\\u4e2d\\u6587'), JSON.stringify(after));
  check('★★ `1e3` 还是 `1e3`（JSON.parse + stringify 会写成 1000）', after.includes('1e3'));
  check('★ 键的**次序**没变：id 在第一个，其余按原序跟在后面',
    Object.keys(obj).join(',') === 'id,name,displayName,version,n,z', Object.keys(obj).join(','));
  check('★ 只多了一行（逐行比，除了插入那一行之外一模一样）',
    after.split('\n').filter((l) => !/^\s*"id":/.test(l)).join('\n') === original,
    JSON.stringify(after));

  // 已经铸过 ⇒ 什么都不做（id 铸一次、永不改变）
  const before = fs.readFileSync(path.join(plug, 'plugin.json'), 'utf8');
  const again = packer('init', plug);
  check('★ 树里已经有 id 时什么都不做（§2.1：id 铸一次、此后永不改变）',
    again.code === 0 && fs.readFileSync(path.join(plug, 'plugin.json'), 'utf8') === before,
    again.err);
}

{
  const { plug } = mkRepo({ ...baseFiles(), 'plugin.json': mf({ id: undefined }) });
  fs.appendFileSync(path.join(plug, 'client', 'index.js'), '// 脏\n');
  const before = fs.readFileSync(path.join(plug, 'plugin.json'), 'utf8');
  const r = packer('init', plug);
  check('★ 树不干净时拒绝铸 id（§2.1「应当拒绝」）—— 否则"提交里那棵树"与"你看到的"不是一回事',
    r.code !== 0 && /不干净/.test(r.err), `${r.code} ${r.err}`);
  check('★ 而它确实一个字节都没写',
    fs.readFileSync(path.join(plug, 'plugin.json'), 'utf8') === before);
}

{
  // 没有 id 的树、工作树干净 ⇒ build 必须说"先跑 init"，而不是偷偷替你铸一个
  const { plug } = mkRepo({ ...baseFiles(), 'plugin.json': mf({ id: undefined }) });
  const r = packer('build', plug, '--out', path.join(os.tmpdir(), 'nope.splug'));
  check('★★ 树里没有 id ⇒ build 拒绝并指向 init（它**不**偷偷替你铸一个）',
    r.code !== 0 && /init/.test(r.err), r.err);
}

// ==============================================================================
//  4. 版本号与跳过表：跨文件的常量
// ==============================================================================

section('4. 跨文件的常量');

{
  // ★ 打包器里的插件版本号正则，与两侧读的是**同一份**夹具。
  const fx = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'version-fixtures.json'), 'utf8'));
  const badValid = fx.plugin.valid.filter((v) => !P.PLUGIN_VERSION_RE.test(v));
  const badInvalid = fx.plugin.invalid.filter((v) => P.PLUGIN_VERSION_RE.test(v));
  check(`★ 打包器的插件版本号正则对上夹具（合法 ${fx.plugin.valid.length} 条、`
    + `不合法 ${fx.plugin.invalid.length} 条）`,
  !badValid.length && !badInvalid.length,
  `该收没收 ${JSON.stringify(badValid)}；该拒没拒 ${JSON.stringify(badInvalid)}`);
}

{
  // ★ 跳过表现在有**三份**（客户端、守护进程、打包器）。打包器那一份是没办法的：
  //   它要"下载这个文件夹就能用"，所以它 import 不到客户端里的常量。
  //   这个 lint 就是那份代价的对价 —— 它原来只比两端（见 checks.yml）。
  const js = fs.readFileSync(path.join(ROOT, 'client', 'src', 'main', 'plugins', 'index.js'), 'utf8');
  const py = fs.readFileSync(path.join(ROOT, 'cluster', 'slurmate-sessiond'), 'utf8');
  const grab = (text, re) => {
    const m = re.exec(text);
    return m ? [...m[1].matchAll(/["']([^"']*)["']/g)].map((x) => x[1]).sort() : null;
  };
  const client = grab(js, /const COPY_SKIP = new Set\(\[([^\]]*)\]\)/);
  const daemon = grab(py, /^PLUGIN_COPY_SKIP = \((.*)\)$/m);
  const packerSet = [...P.COPY_SKIP].sort();
  check('★★ 三端的跳过表逐字一致（漂开了就是「同步一直失败」且说不清原因）',
    JSON.stringify(client) === JSON.stringify(daemon)
    && JSON.stringify(daemon) === JSON.stringify(packerSet),
    `客户端 ${JSON.stringify(client)} / 守护进程 ${JSON.stringify(daemon)} / 打包器 ${JSON.stringify(packerSet)}`);
  check('★ 三份都真的抠出来了（有一个是 null 的话上面那条是假通过）',
    !!client && !!daemon && packerSet.length > 0);
}

// ==============================================================================
//  5. 坏包：两份 JS 实现必须给出**同一个**理由词
// ==============================================================================

section('5. 坏包 —— 与客户端那一份读方逐条对答案');

{
  const diff = [];
  for (const c of BAD.cases) {
    const bytes = unhex(c.hex);
    const a = P.parsePackage(bytes);
    const b = C.parsePackage(bytes);
    const ga = a.ok ? 'ok' : a.code;
    const gb = b.ok ? 'ok' : b.code;
    if (ga !== c.code) diff.push(`打包器 ${c.name}：期望 ${c.code}，得到 ${ga}`);
    if (gb !== c.code) diff.push(`客户端 ${c.name}：期望 ${c.code}，得到 ${gb}`);
  }
  check(`★★ ${BAD.cases.length} 条坏包，打包器与客户端给出同一个期望的理由词`,
    diff.length === 0, diff.join('；'));
  check('★ 两份实现读**好包**的结论也一致（否则上面那条可能是"两边都错得一样"）',
    (() => {
      const bytes = unhex(EXPECTED.package.hex);
      const a = P.parsePackage(bytes);
      const b = C.parsePackage(bytes);
      return a.ok && b.ok && a.digest === b.digest;
    })());
}

{
  // ★ 一次**变异验证**：把判据改坏一处，对应用例必须红。
  //   这里不是改源码（那要写文件、还要还原），而是直接对一个**已经解析好**的
  //   序列重算一个摘要 —— 它必须与真摘要不同，否则 §3.4 那个公式里的某一段
  //   其实没进哈希（比如 sha256 那一列被忘了拼）。
  const r = P.parsePackage(unhex(EXPECTED.package.hex));
  const tweaked = r.files.map((f, i) => (i === 0 ? { ...f, sha256: '00'.repeat(32) } : f));
  check('★ 改掉一份的 sha256 ⇒ 摘要必变（证明那一列真的进了哈希）',
    P.contentDigest(tweaked) !== r.digest);
  const reordered = [r.files[1], r.files[0], ...r.files.slice(2)];
  check('★ 换掉两条的次序 ⇒ 摘要**不变**（排序是摘要的一部分）',
    P.contentDigest(reordered) === r.digest);
  check('★ 而路径拼进摘要时用的是 UTF-8 字节而不是 UTF-16',
    P.contentDigest([{ path: '\u{1F600}', sha256: '00'.repeat(32) }])
    !== P.contentDigest([{ path: '�', sha256: '00'.repeat(32) }]));
}

// ==============================================================================
//  6. inspect / verify 的出口码
// ==============================================================================

section('6. 命令行出口码');

{
  const bytes = unhex(EXPECTED.package.hex);
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'slurmate-ins-')), 'x.splug');
  fs.writeFileSync(f, bytes);
  const ok = packer('verify', f);
  check('verify：好包 ⇒ 0', ok.code === 0, ok.err);
  const wrong = packer('verify', f, '--expect-digest', '00'.repeat(32));
  check('★ verify --expect-digest：摘要不对 ⇒ 非零（作者可以钉住"我发出去的是这一份"）',
    wrong.code !== 0 && /期望/.test(wrong.err), wrong.err);
  const signer = packer('verify', f, '--expect-signer', EXPECTED.signed.fingerprint);
  check('★ verify --expect-signer：没签名而期望某个签名者 ⇒ 非零',
    signer.code !== 0 && /没签名/.test(signer.err), signer.err);
  const signed = packer('verify', path.join(f, '..', 'y.splug'));
  check('★ 读不到文件 ⇒ 2（不是 1 —— "这个包不对"与"我没读到"要分得开）',
    signed.code === 2, String(signed.code));

  const sf = path.join(path.dirname(f), 's.splug');
  fs.writeFileSync(sf, unhex(EXPECTED.signed.hex));
  const sv = packer('verify', sf, '--expect-signer', EXPECTED.signed.fingerprint);
  check('★ verify：带签名的包验得过，签名者就是夹具里那一把', sv.code === 0, sv.err + sv.out);

  const ins = packer('inspect', f, '--json');
  const j = JSON.parse(ins.out);
  check('★ inspect --json 的输出与夹具一致（作者拿它对着规范逐行核对）',
    j.ok && j.digest === EXPECTED.digest && j.files.length === EXPECTED.files.length
    && j.manifest.id === '01M2JKHTZGQ7X8V4T5R6N7B8C9', ins.out.slice(0, 200));

  const badf = path.join(path.dirname(f), 'bad.splug');
  fs.writeFileSync(badf, unhex(BAD.cases.find((c) => c.code === 'format').hex));
  const bi = packer('inspect', badf);
  check('★ inspect 一个「太新」的包 ⇒ 非零，并说出 format',
    bi.code !== 0 && /format/.test(bi.err), bi.err);
}

// ==============================================================================

function walkTree(dir, prefix = '') {
  const out = [];
  for (const name of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    if (fs.statSync(full).isDirectory()) out.push(...walkTree(full, rel));
    else out.push([rel, fs.readFileSync(full)]);
  }
  return out;
}

for (const d of TMP) fs.rmSync(d, { recursive: true, force: true });

console.log(`\n${'='.repeat(60)}`);
console.log(`  通过 ${PASS}  失败 ${FAIL}`);
console.log(`${'='.repeat(60)}`);
process.exit(FAIL ? 1 : 0);
