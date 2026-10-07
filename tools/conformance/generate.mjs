#!/usr/bin/env node
/**
 * generate.mjs —— 生成 `expected.json` 与 `bad.json`。
 *
 * ── 为什么要有"生成"这一步 ──────────────────────────────────────────────────
 *
 * 三份实现（打包器 / 守护进程 / 客户端）要能对**同一批字节**得出同一个结论。
 * 那批字节必须逐字节相同，所以它只能是**常量** —— 于是两个文件里存的是十六进制。
 *
 * 但"一堆不透明的十六进制"本身是一句说不清的话。所以：
 *
 *   · **变异怎么造，只写在这一个文件里**（下面那些 op）。三端一个引擎都不用带，
 *     它们只做 `Buffer.from(hex, 'hex')` 然后解析。
 *   · `bad.json` 里每一条都带着一句 `change`，说**改了哪几个字节**。
 *   · 这个文件跑一次就是一次复核：**种进去的变换与期望的拒绝理由对不对得上**。
 *
 * ── 它做了什么 ──────────────────────────────────────────────────────────────
 *
 *   1. 把 `tree/` 复制进一个临时 git 仓库并提交（§3.5 要一个提交，不是工作树）；
 *   2. 调**真正的** `packer build` 打出包 —— 不是在这里再写一份组装代码，
 *      否则量出来的就不是那个工具的输出；
 *   3. 用一把**写死种子的、只属于夹具的** Ed25519 钥匙签一次（见 `FIXTURE_SEED`
 *      那段）。写死种子是为了重新生成时逐字节相同 —— 早先是每次现铸，于是每跑
 *      一次 `expected.json` 里的公钥与签名都换一遍，而那份 diff 一个字节都不意味
 *      着什么；
 *   4. 造一批坏包；
 *   5. 写 `expected.json` 与 `bad.json`。
 *
 * 用法：`node tools/conformance/generate.mjs`
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const TREE = path.join(HERE, 'tree');

// ==============================================================================
//  造一个临时的仓库、打出那个包
// ==============================================================================

function sh(cmd, args, opts) {
  return execFileSync(cmd, args, Object.assign({ maxBuffer: 1 << 28 }, opts || {}));
}

function buildPackageBytes() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'slurmate-conf-'));
  const plug = path.join(tmp, 'plug');
  // 不用 cp -a：源目录在 NAS 上有 ACL，`-a` 会因为它而失败。位我们自己设。
  fs.cpSync(TREE, plug, { recursive: true });
  fs.chmodSync(path.join(plug, 'job', 'start.sh'), 0o755);   // 树里那一份是 100755
  const git = (...a) => sh('git', ['-C', tmp, '-c', 'user.email=conf@example.com',
    '-c', 'user.name=conf', '-c', 'commit.gpgsign=false'].concat(a));
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-qm', 'conformance tree');
  const out = path.join(tmp, 'out.splug');
  // ★ `--home` 指向临时目录（而不是作者的家目录）：打包器会往那儿写一张发布表，
  //   而那张表会在"同一个 (id, 版本) 算出第二个摘要"时拒绝打包（§2.4）。
  //   夹具树**故意**会变，所以不隔开的话，第二次跑 `generate.mjs` 当场就会红。
  const text = sh(process.execPath, [path.join(ROOT, 'packer', 'slurmate-packer.js'),
    'build', plug, '--commit', 'HEAD', '--out', out, '--home', path.join(tmp, 'home')],
  { encoding: 'utf8' });
  const buf = fs.readFileSync(out);
  fs.rmSync(tmp, { recursive: true, force: true });
  return { buf, text };
}

// ==============================================================================
//  容器的拆与装（**只在这里**，三端只有读的那一半）
// ==============================================================================

const MAGIC = Buffer.from('splug\x1a\r\n', 'latin1');
const FORMAT = 2;
const SIG_ALG = 1;
/** 签名块的定长部分（A.3）：`alg|pubkey|sig|id|verlen|…|digestSite|digestClient`。 */
const SIG_MIN = 1 + 32 + 64 + 26 + 1 + 32 + 32;

// ── §3.1 / §4.2：把负载按侧分成两半 ────────────────────────────────────────
//
// ★ **这一份是独立实现**（不 import 打包器），与三份读方各写各的 —— 夹具的价值
//    正在于"三份实现各自算，答案必须相同"。判据是**顶层前缀**，按字节比。
const CLIENT_PREFIX = Buffer.from('client/', 'utf8');
const MANIFEST_B = Buffer.from('plugin.json', 'utf8');
const LINEAGE_B = Buffer.from('lineage.json', 'utf8');

function digestOfEntries(pairs) {
  const sorted = pairs.slice().sort((a, b) => Buffer.compare(a.p, b.p));
  const h = crypto.createHash('sha256');
  for (const x of sorted) {
    h.update(x.p);
    h.update(Buffer.from([0]));
    h.update(Buffer.from(x.sha, 'ascii'));
    h.update(Buffer.from([0x0a]));
  }
  return h.digest('hex');
}

/** 这一条路径在不在**客户端侧**。 */
function isClientSideBytes(pb) {
  return (pb.length >= CLIENT_PREFIX.length
          && pb.subarray(0, CLIENT_PREFIX.length).equals(CLIENT_PREFIX))
    || pb.equals(MANIFEST_B) || pb.equals(LINEAGE_B);
}

/**
 * 一个已解析的容器 → 两半的路径/摘要对。`which` ∈ 'site' | 'client'。
 *
 * ★★ **两侧不是互补的**：`plugin.json` 与 `lineage.json` **两侧都在**，所以
 *    站点侧不是"客户端侧的补集"，而是"**不以 `client/` 开头的那些**"。
 *    ★ 这一条自己就错过一次（写成 `!isClientSideBytes()`，于是两个元数据文件从
 *      站点侧掉了出去），而抓住它的是下面那次 `packer verify` 自检 —— 三份读方
 *      各自算出来的 `digestSite` 只有一个，抄错一处当场就响。
 */
function sidePairs(parts, which) {
  const pairs = parts.recs.map((r) => ({ p: r.pathBytes, sha: r.sha256.toString('hex') }));
  if (which === 'client') return pairs.filter((x) => isClientSideBytes(x.p));
  return pairs.filter((x) => !(x.p.length >= CLIENT_PREFIX.length
    && x.p.subarray(0, CLIENT_PREFIX.length).equals(CLIENT_PREFIX)));
}

/** A.3 的被签消息。 */
function sigMessage(id, version, ds, dc) {
  return Buffer.concat([Buffer.from(id, 'ascii'), Buffer.from([0]),
    Buffer.from(version, 'utf8'), Buffer.from([0]),
    Buffer.from(ds, 'hex'), Buffer.from(dc, 'hex')]);
}

/** A.3 的签名块。 */
function sigBlockBytes(id, version, pub, sig, ds, dc) {
  const ib = Buffer.from(id, 'ascii');
  const vb = Buffer.from(version, 'utf8');
  const out = Buffer.alloc(SIG_MIN + vb.length);
  out[0] = SIG_ALG;
  pub.copy(out, 1);
  sig.copy(out, 33);
  ib.copy(out, 97);
  out[123] = vb.length;
  vb.copy(out, 124);
  Buffer.from(ds, 'hex').copy(out, 124 + vb.length);
  Buffer.from(dc, 'hex').copy(out, 156 + vb.length);
  return out;
}

function split(buf) {
  const fileCount = buf.readUInt32BE(12);
  const sigLen = buf.readUInt32BE(16);
  let off = 20;
  const recs = [];
  for (let i = 0; i < fileCount; i++) {
    const pathlen = buf.readUInt16BE(off);
    const pathBytes = buf.subarray(off + 2, off + 2 + pathlen);
    const size = buf.readBigUInt64BE(off + 2 + pathlen);
    const sha256 = buf.subarray(off + 2 + pathlen + 8, off + 2 + pathlen + 40);
    recs.push({ pathlen, pathBytes, size, sha256, recStart: off });
    off += 2 + pathlen + 40;
  }
  const sig = buf.subarray(off, off + sigLen);
  const payload = buf.subarray(off + sigLen);
  let p = 0;
  for (const r of recs) {
    const n = Number(r.size);
    r.data = payload.subarray(p, p + n);
    p += n;
  }
  return { format: buf.readUInt32BE(8), recs, sig, payload, tableEnd: off };
}

function join(parts) {
  const { format = FORMAT, recs, sig, payload } = parts;
  const head = Buffer.alloc(20);
  MAGIC.copy(head, 0);
  head.writeUInt32BE(format, 8);
  head.writeUInt32BE(recs.length, 12);
  head.writeUInt32BE(sig.length, 16);
  const table = [];
  for (const r of recs) {
    const h = Buffer.alloc(2);
    h.writeUInt16BE((r.pathBytes || Buffer.from(r.path, 'utf8')).length, 0);
    const s = Buffer.alloc(8);
    s.writeBigUInt64BE(r.size, 0);
    table.push(h, r.pathBytes || Buffer.from(r.path, 'utf8'), s, r.sha256);
  }
  return Buffer.concat([head, ...table, sig, payload]);
}

/** 拆开再装回去 —— 对一个没被改过的包来说，这一步必须**逐字节还原**。 */
function roundTrip(buf) {
  const s = split(buf);
  return join({ format: s.format, recs: s.recs, sig: s.sig, payload: s.payload });
}

// ==============================================================================
//  变异
// ==============================================================================

const rec = (i) => (s) => s.recs[i];

const CASES = [
  {
    name: '魔数不对',
    code: 'magic',
    change: '文件的头 8 个字节从 `splug\\x1a\\r\\n` 改成 8 个 0x00',
    why: '魔数是"这是一个 .splug"的全部判据。没有它，收包方会把一个随便什么文件当包解析。',
    apply: (b) => { const o = Buffer.from(b); o.fill(0, 0, 8); return o; },
  },
  {
    name: 'format 是 3（比本实现新）',
    code: 'format',
    change: '头里偏移 8 的 format 从 00000002 改成 00000003',
    why: '★ 这一条就是客户端「站点太新」那一态的来源：认不得的 format 要**拒绝**，'
      + '不是"按 2 理解"。按 2 理解的后果是拿一个未知布局的字节当已知布局读。',
    apply: (b) => { const o = Buffer.from(b); o.writeUInt32BE(3, 8); return o; },
  },
  {
    name: 'format 是 1（v0.13 之前的容器）',
    code: 'format',
    change: '头里偏移 8 的 format 从 00000002 改成 00000001',
    why: '★ **一条实打实的兼容性判据**：v1 的签名块是定长 97 字节、只盖一个整树摘要，'
      + '而 v2 的盖的是四元组、长度还随版本号变。把 v1 的字节按 v2 读，签名块那一段'
      + '会整体错位 —— 所以零容忍，一个字节都不试着往下读（`0.y` 不考虑兼容性）。',
    apply: (b) => { const o = Buffer.from(b); o.writeUInt32BE(1, 8); return o; },
  },
  {
    name: '尾随一个字节',
    code: 'length',
    change: '文件末尾追加一个 0x00',
    why: '★ 信封不进摘要 —— 所以信封里任何一个"被忽略的字节"都是**无认证的夹带面**，'
      + '与 §3.6 直接冲突。长度必须**精确**。',
    apply: (b) => Buffer.concat([b, Buffer.from([0])]),
  },
  {
    name: '末尾被截掉一个字节',
    code: 'length',
    change: '砍掉文件的最后一个字节',
    why: '负载少了一个字节。报告成功而内容不是那一份，正是 §6.1 禁止的那一类。',
    apply: (b) => b.subarray(0, b.length - 1),
  },
  {
    name: 'sig_len 说 188 但签名块不在',
    code: 'length',
    change: '头里偏移 16 的 sig_len 从 0 改成 000000bc（188，签名块**最短**的长度）',
    why: '★ 长度等式在**签名块之前**判 —— 所以这一条拿到的是 `length` 而不是 `signature`。'
      + '次序是规范的一部分（附录 A.4）：一个包同时犯两条时，先判哪条决定了理由词。',
    apply: (b) => { const o = Buffer.from(b); o.writeUInt32BE(188, 16); return o; },
  },
  {
    name: '记录说的字节数比负载多一个',
    code: 'length',
    change: '第 0 条记录的 size 加一',
    why: 'Σsize 与负载长度不符。',
    apply: (b) => {
      const s = split(b);
      s.recs[0].size = s.recs[0].size + 1n;
      return join(s);
    },
  },
  {
    name: '两段负载被对调',
    code: 'content',
    change: '把输入树里那两份都是 6 字节的文件（`cases/zeros.bin` 与 `cases/😀.txt`）的负载字节互换',
    why: '★ 长度、路径、记录表全都对得上，只有字节与记录里的 sha256 不符。'
      + '这是"信封自洽但内容被换过"的形状 —— 逐份校字节是唯一能抓住它的检查。',
    apply: (b) => {
      const s = split(b);
      // 必须找**等长**的两份：长度不等的话 `length` 会先响，量的就不是这一条了。
      // （输入树里 `cases/zeros.bin` 与 `cases/😀.txt` 都是 6 字节，就是为这个留的。）
      let i = -1;
      let j = -1;
      for (let a = 0; a < s.recs.length && i < 0; a++) {
        for (let c = a + 1; c < s.recs.length; c++) {
          if (s.recs[a].size === s.recs[c].size && !s.recs[a].sha256.equals(s.recs[c].sha256)) {
            i = a; j = c; break;
          }
        }
      }
      if (i < 0) throw new Error('输入树里没有两份等长而内容不同的文件 —— 这一条造不出来');
      const t = s.recs[i].data;
      s.recs[i].data = s.recs[j].data;
      s.recs[j].data = t;
      s.payload = Buffer.concat(s.recs.map((r) => r.data));
      return join(s);
    },
  },
  {
    name: '记录里的 sha256 被改',
    code: 'content',
    change: '第 0 条记录的 sha256 那 32 字节清零',
    why: '记录与字节对不上。',
    apply: (b) => {
      const s = split(b);
      s.recs[0].sha256 = Buffer.alloc(32);
      return join(s);
    },
  },
  {
    name: '路径里有反斜杠',
    code: 'path',
    change: '第 0 条记录的路径改成 `plugin\\json`',
    why: '§3.3：**禁止**把 `\\` 翻译成 `/` —— 一侧翻译而另一侧不翻译就是歧义的来源。',
    apply: (b) => patchPath(b, 0, Buffer.from('plugin\\json', 'utf8')),
  },
  {
    name: '路径是绝对的',
    code: 'path',
    change: '第 0 条记录的路径改成 `/plugin.json`',
    why: '§3.3：负载里每一条路径必须是**相对**路径。绝对路径解出来能写到树的任何地方。',
    apply: (b) => patchPath(b, 0, Buffer.from('/plugin.json', 'utf8')),
  },
  {
    name: '路径里有 ..',
    code: 'path',
    change: '第 0 条记录的路径改成 `../plugin.json`',
    why: '★ `..` 是"解包会写到负载根之外"的唯一表达形式。',
    apply: (b) => patchPath(b, 0, Buffer.from('../plugin.json', 'utf8')),
  },
  {
    name: '路径落在跳过集合里',
    code: 'path',
    change: '第 0 条记录的路径改成 `.gitignore`',
    why: '§3.3 的禁止路径。★ 打包器**排除**它们、读方**拒绝**含它们的包 —— '
      + '同一份名单的两个方向。',
    apply: (b) => patchPath(b, 0, Buffer.from('.gitignore', 'utf8')),
  },
  {
    name: '路径是 Windows 保留名',
    code: 'path',
    change: '第 0 条记录的路径改成 `CON`',
    why: '§3.3：`CON`/`PRN`/`NUL` 那一类名字在 Windows 上指的是设备，不是文件 ——'
      + '解出来的树在那台机器上是另一种东西。',
    apply: (b) => patchPath(b, 0, Buffer.from('CON', 'utf8')),
  },
  {
    name: '路径不是合法的 UTF-8',
    code: 'path',
    change: '第 0 条记录的路径字节改成 `\\xff\\xfe`',
    why: '★ 不合法的 UTF-8 会被 `toString("utf8")` **悄悄换成 U+FFFD** —— 摘要把那个'
      + '替换字符算进去，于是两端算的不是同一份东西。所以要在解码**之前**判。',
    apply: (b) => patchPath(b, 0, Buffer.from([0xff, 0xfe])),
  },
  {
    name: '记录表里 pathlen 越界',
    code: 'record',
    change: '第 0 条记录的 pathlen 改成 65535',
    why: '记录表本身读不下来。',
    apply: (b) => {
      const o = Buffer.from(b);
      o.writeUInt16BE(0xffff, 20);
      return o;
    },
  },
  {
    name: 'file_count 比真实的条数多 1',
    code: 'record',
    // ★ 相对量，不是写死的 12：夹具树**加一份文件**是常有的事（比如给老插件补一张
    //   血统表），而写死的话那一次改动会**悄悄把这一条变成合法包** —— 于是这个
    //   用例从此什么都不验，而输出里看不出来（它仍然"通过"，只是不再是一条坏包）。
    change: '头里偏移 12 的 file_count 加一',
    why: '★ 多出来的那一条会从**负载**里读表 —— 于是路径是几 KB 的二进制乱码。'
      + '这一条钉住"记录表读不读得完"必须先于别的一切判。',
    apply: (b) => { const o = Buffer.from(b); o.writeUInt32BE(o.readUInt32BE(12) + 1, 12); return o; },
  },
  {
    name: '空负载',
    code: 'manifest',
    change: '记录表清空、负载清空、file_count 改成 0',
    why: '§3.1/附录 A.4：空负载 ⇒ 一定没有 `plugin.json` ⇒ 拒绝。',
    apply: () => join({ recs: [], sig: Buffer.alloc(0), payload: Buffer.alloc(0) }),
  },
  {
    name: '完全重复的一条记录',
    code: 'duplicate',
    change: '把第 0 条记录（连同它的负载）原样再插一遍',
    why: '★ §3.3 只禁了"只差大小写"，**没禁完全相同的两条** —— 而两条同路径'
      + '不同内容时，摘要有定义而**解出来的树是歧义的**。',
    apply: (b) => dup(b, 0, false),
  },
  {
    name: '只差大小写的两条',
    code: 'duplicate',
    change: '同上，但把复制出来那一条的路径改成全大写（`plugin.json` → `PLUGIN.JSON`）',
    why: '★ 坑在**落盘之后**：macOS / Windows 的文件系统不区分大小写，两条会互相覆盖，'
      + '而摘要按写入之后的磁盘算 —— 于是"用户同意的"与"实际装上的"可以不是同一棵树。',
    apply: (b) => dup(b, 0, true),
  },
  {
    name: '负载里没有 plugin.json',
    code: 'manifest',
    change: '把 `plugin.json` 那条记录的路径改成等长的 `plugin.jsoN`',
    why: '★ 它的字节与记录仍然相符（逐份校验过得去），只是**没有一份叫 plugin.json**。'
      + '一个没有清单的负载不是插件。',
    apply: (b) => {
      const s = split(b);
      const i = s.recs.findIndex((r) => r.pathBytes.toString('utf8') === 'plugin.json');
      s.recs[i].pathBytes = Buffer.from('plugin.jsoN', 'utf8');
      return join(s);
    },
  },
  // ── 下面三条作用在**带签名**的那一份上 ────────────────────────────────────
  {
    name: '签名块被改了一个字节',
    base: 'signed',
    code: 'signature',
    needs: 'verify',
    change: '签名块的最后一个字节取反',
    why: '签名必须盖住内容摘要（§4.2），改一个字节就验不过。',
    apply: (b, ctx) => {
      const o = Buffer.from(b);
      o[ctx.sigAt + 97 - 1] = o[ctx.sigAt + 97 - 1] ^ 0xff;
      return o;
    },
  },
  {
    name: '签名块里的算法认不得',
    base: 'signed',
    code: 'signature',
    change: '签名块的第一个字节（alg）从 1 改成 2',
    why: '★ 认不得的**算法**要拒绝，不是"忽略签名继续装" —— 后者等于给"我不认识的签名"'
      + '开一个免检的口子。',
    apply: (b, ctx) => {
      const o = Buffer.from(b);
      o[ctx.sigAt] = 2;
      return o;
    },
  },
  {
    name: '签名者换了',
    base: 'signed',
    code: 'signature',
    needs: 'verify',
    change: '签名块里的公钥换成**另一把合法**的 Ed25519 公钥',
    why: '★ 形状合法、字节合法，只有签名验不过。这一条钉住"验签真的在验"，'
      + '而不是"签名块看起来像个签名块"。',
    apply: (b, ctx) => {
      const o = Buffer.from(b);
      ctx.otherPub.copy(o, ctx.sigAt + 1);
      return o;
    },
  },
  // ── v0.13 新加的四条：钉住四元组（A.3）的**每一个成员都在起作用** ──────────
  {
    name: '签名块里的 digestSite 被改了一位',
    base: 'signed',
    code: 'signature',
    change: '签名块里 digestSite 那 32 字节的第一个字节取反',
    why: '★ 站点侧摘要进了**被签消息**，所以它改一位就验不过；而且这一份实现与'
      + '守护进程读方**都在签名之前**先比一次"重算的摘要 vs 块里写的"（A.4 第 10 步③）'
      + '—— 所以它连密码学都不必等到。这一条钉住"站点侧那 32 字节真的被绑住了"。',
    apply: (b, ctx) => {
      const o = Buffer.from(b);
      o[ctx.sigAt + 188 + Buffer.byteLength(ctx.sigVer, 'utf8') - 64] ^= 0xff;
      return o;
    },
  },
  {
    name: '签名块里的 digestClient 被改了一位',
    base: 'signed',
    code: 'signature',
    change: '签名块里 digestClient 那 32 字节的第一个字节取反',
    why: '★ 与上一条同源，只是换到客户端侧 —— 而客户端侧那半**只有客户端手里有**，'
      + '所以它是"站点单独发一半"那条路上唯一的判据（§4.2）。',
    apply: (b, ctx) => {
      const o = Buffer.from(b);
      o[ctx.sigAt + 188 + Buffer.byteLength(ctx.sigVer, 'utf8') - 32] ^= 0xff;
      return o;
    },
  },
  {
    name: '签名块里的 id 换成另一个合法 ULID（清单没跟着改）',
    base: 'signed',
    code: 'manifest',
    change: '签名块里那 26 个 ASCII 字节的 id 换成另一个合法 ULID',
    why: '★ 只改一处时它连**密码学都不必等到**：A.4 第 10 步② 要求块里的 '
      + '`id`/`version` 与清单**逐字**相同 —— 同一个包里两处说了两个身份。'
      + '报 `manifest` 而不是 `signature`，因为"这个包是什么"比"签名对不对"更靠前。',
    apply: (b, ctx) => {
      const o = Buffer.from(b);
      Buffer.from('01M2JKHTZGQ7X8V4T5R6N7B8CA', 'ascii').copy(o, ctx.sigAt + 97);
      return o;
    },
  },
  {
    name: 'verlen 与实际版本号长度不符',
    base: 'signed',
    code: 'signature',
    change: '签名块里那个 verlen 字节从 5（`1.0.0`）改成 4',
    why: '★ 签名块的长度**必须**等于 `188 + verlen`。改这一个字节会让长度等式对不上，'
      + '而那时**不许**"按最长的读"或者"截掉多余的那一段" —— 长度是这一块的形状。',
    apply: (b, ctx) => {
      const o = Buffer.from(b);
      o[ctx.sigAt + 123] = 4;
      return o;
    },
  },
  {
    name: 'id 在信封与清单里一起换掉（记录表那一行也补上）',
    base: 'signed',
    code: 'signature',
    needs: 'verify',
    change: '把 id 换成另一个合法 ULID —— **三处一起改**：签名块里那 26 字节、'
      + '负载里 `plugin.json` 那一条、以及记录表里 `plugin.json` 那一行的 sha256；'
      + '再把两个侧摘要重算后写回签名块',
    why: '★★ **这一条钉的是 A.3 里"被签消息含 id"。** 少了那一项，一份构件可以被'
      + '**改名**成另一个插件而签名照样成立 —— 两个包配错对，而客户端钉住的公钥'
      + '还是同一把，于是 §5.4 一个字都不会响。'
      + '★ 它被造得**尽量像自洽**：长度、逐份 sha256、清单、两侧摘要（③）全都过得去，'
      + '只有验签（④）拦得住 —— 这正是"只有会验签的那一端才拒得了它"的意思。',
    apply: (b, ctx) => {
      const NEWID = '01M2JKHTZGQ7X8V4T5R6N7B8CA';
      const s = split(b);
      // ① 负载里 plugin.json 那一份里的 id（**等长**替换，所以 size 不变）
      const i = s.recs.findIndex((r) => r.pathBytes.equals(MANIFEST_B));
      if (i < 0) throw new Error('夹具树里没有 plugin.json —— 这一条造不出来');
      const mf = Buffer.from(s.recs[i].data);
      const at = mf.indexOf(Buffer.from(ctx.sigId, 'ascii'));
      if (at < 0) throw new Error('plugin.json 里找不到那个 id —— 这一条造不出来');
      Buffer.from(NEWID, 'ascii').copy(mf, at);
      s.recs[i].data = mf;
      // ② 摘要跟着走：`join()` 会把 `recs[i].sha256` 原样写进记录表那一行
      s.recs[i].sha256 = crypto.createHash('sha256').update(mf).digest();
      s.payload = Buffer.concat(s.recs.map((r) => r.data));
      // ③ 两个侧摘要重算，**写回签名块**（而不是重签 —— 那正是这一条要测的）
      const verlen = Buffer.byteLength(ctx.sigVer, 'utf8');
      s.sig = Buffer.from(s.sig);
      Buffer.from(NEWID, 'ascii').copy(s.sig, 97);
      Buffer.from(digestOfEntries(sidePairs(s, 'site')), 'hex').copy(s.sig, 124 + verlen);
      Buffer.from(digestOfEntries(sidePairs(s, 'client')), 'hex').copy(s.sig, 156 + verlen);
      return join(s);
    },
  },
];

function patchPath(b, i, bytes) {
  const s = split(b);
  s.recs[i].pathBytes = bytes;
  return join(s);
}

function dup(b, i, recase) {
  const s = split(b);
  const src = s.recs[i];
  const copy = {
    pathBytes: recase ? Buffer.from(src.pathBytes.toString('latin1').toUpperCase(), 'latin1')
      : Buffer.from(src.pathBytes),
    size: src.size,
    sha256: Buffer.from(src.sha256),
    data: Buffer.from(src.data),
  };
  s.recs.splice(i + 1, 0, copy);
  s.payload = Buffer.concat(s.recs.map((r) => r.data));
  return join(s);
}

// ==============================================================================
//  生成
// ==============================================================================

/** 十六进制按 96 字符一行切开 —— 让 `expected.json` 读起来像一份 hex dump，
 *  而不是一行四十万字符。三端用 `join('')` 拼回去。 */
function hexLines(buf) {
  const h = buf.toString('hex');
  const out = [];
  for (let i = 0; i < h.length; i += 96) out.push(h.slice(i, i + 96));
  return out;
}

function serializableBytes(buf) {
  return {
    bytes: buf.length,
    sha256: crypto.createHash('sha256').update(buf).digest('hex'),
    hex: hexLines(buf),
  };
}

/**
 * 夹具用的那把钥匙，**从一个写死的种子派生**。
 *
 * ★ 它是一把**公开的、只属于夹具的**钥匙，任何人都能拿它签名。这在这里是安全的，
 *   因为签名在这套东西里只表达一件事：**与上一次是同一把钥匙**（§5.4 的钉表）。
 *   没有任何证书颁发机构、没有注册表，一把谁都知道的钥匙签出来的东西，第一次见
 *   它的客户端本来就会"首次即信任"—— 也就是说它冒充不了任何**已经**被钉住的 id。
 *
 * ★ 写死种子而不是每次现铸（早先是那样），是为了**重新生成时逐字节相同**：
 *   否则每跑一次 `generate.mjs`，`expected.json` 里的公钥、签名、指纹都会换一遍，
 *   而那份 diff 里没有一个字节是有意义的。
 */
const FIXTURE_SEED = Buffer.from(
  '736c75726d6174652d636f6e666f726d616e63652d666978747572652d6b65792d30303031', 'hex');
const OTHER_SEED = Buffer.from(
  '736c75726d6174652d636f6e666f726d616e63652d6f746865722d6b65792d303030303031', 'hex');
/** PKCS#8 里包一个 Ed25519 裸种子（RFC 8410）—— 12 + 2 + 32 字节。 */
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

function ed25519FromSeed(seed) {
  const priv = crypto.createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: 'der', type: 'pkcs8',
  });
  return { priv, raw: crypto.createPublicKey(priv).export({ format: 'der', type: 'spki' }).subarray(12) };
}

function main() {
  const { buf, text } = buildPackageBytes();

  const { priv, raw: rawPub } = ed25519FromSeed(FIXTURE_SEED);
  const digest = digestOf(buf);
  // ★★ v0.13：签的是**四元组**（A.3）—— `{id, 版本, 站点侧摘要, 客户端侧摘要}`。
  //    这里两个侧摘要由**本文件自己**那份实现算（`sidePairs`/`digestOfEntries`），
  //    与三份读方各写各的 —— 夹具的价值正在于"各自算、答案必须相同"。
  const parts = split(buf);
  const MF = JSON.parse(parts.recs.find((r) => r.pathBytes.equals(MANIFEST_B)).data.toString('utf8'));
  const SIG_ID = MF.id;
  const SIG_VER = MF.version;
  const dsSite = digestOfEntries(sidePairs(parts, 'site'));
  const dsClient = digestOfEntries(sidePairs(parts, 'client'));
  const signature = crypto.sign(null, sigMessage(SIG_ID, SIG_VER, dsSite, dsClient), priv);
  const sigBlock = sigBlockBytes(SIG_ID, SIG_VER, rawPub, signature, dsSite, dsClient);
  // ★ 签名块在**记录表之后、负载之前**（附录 A.2）—— 不是追加到文件末尾。
  //   追加到末尾会让负载整体错位，而那会以 `content` 的形式响，不是 `signature`。
  const tableEnd = split(buf).tableEnd;
  const signed = Buffer.concat([
    buf.subarray(0, tableEnd), sigBlock, buf.subarray(tableEnd),
  ]);
  signed.writeUInt32BE(sigBlock.length, 16);            // 头里的 sig_len 那一格
  // ★ 加一块签名，只该动头里 sig_len 那 4 个字节，别的一个都不许动 ——
  //   这正是 §4.2 那句"签名不覆盖信封"的可观测形式，也是下面那条断言的用处。
  if (!signed.subarray(0, 16).equals(buf.subarray(0, 16))
      || !signed.subarray(20, tableEnd).equals(buf.subarray(20, tableEnd))
      || !signed.subarray(tableEnd + sigBlock.length).equals(buf.subarray(tableEnd))) {
    throw new Error('加签名块时改到了不该改的字节');
  }

  const other = ed25519FromSeed(OTHER_SEED).raw;

  // ==========================================================================
  //  ★★ 站点**分发出去**的那一份：只含客户端侧（v0.13 阶段 4）
  // ==========================================================================
  //
  //  做法与真守护进程逐字同构（`slurmate-sessiond` 的 `plugin_rebuild`）：签名块
  //  **原样搬过去**，只把客户端侧那几份负载装进去。它成立靠的是 §4.2 那条
  //  「禁止签名覆盖信封字节」—— 包小了，而 `digestClient` 覆盖的那几份一个字节没变。
  //
  //  ★ **这一处故意 import 真的打包器**（上面 `sidePairs` 那一段则刻意不 import）。
  //    两件事要的东西相反：分侧摘要要的是"三份实现各自算、答案必须相同"；而这一份
  //    字节要的**就是打包器的输出** —— 它是守护进程那份 Python 实现（第四份）重打
  //    时要**逐字节**对齐的参照物（`tools/conformance/README.md` 与集群用例）。
  const PACKER = require(path.join(ROOT, 'packer', 'slurmate-packer.js'));
  const clientOnlyFiles = parts.recs.filter((r) => isClientSideBytes(r.pathBytes))
    .map((r) => ({ path: r.pathBytes.toString('utf8'), data: r.data,
                   sha256: r.sha256.toString('hex') }));
  if (!clientOnlyFiles.length || clientOnlyFiles.length === parts.recs.length) {
    throw new Error('夹具树必须**两侧都有** —— 只有一侧的话，"只发客户端侧"这件事'
      + '在这里就没有可测的东西了');
  }
  const clientOnly = PACKER.buildPackage(clientOnlyFiles, sigBlock);
  {
    // ★ 自检（与上面那一处同源）：让**真的**打包器读一遍这一份只含客户端侧的包。
    //   它必须**收下** —— "两侧都在"的包合法，"只有客户端侧"的包**同样**合法
    //   （A.4 第 10 步③只核**包里在的那几侧**）。这一条同时钉住了那个"哪一侧在手里"
    //   的判据：写反了的话，这一份会被报成"站点侧摘要对不上"。
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'slurmate-confcli-'));
    const cf = path.join(tmp, 'client.splug');
    fs.writeFileSync(cf, clientOnly);
    const fp = crypto.createHash('sha256').update(rawPub).digest('hex');
    let ok = true;
    let out = '';
    try {
      out = sh(process.execPath, [path.join(ROOT, 'packer', 'slurmate-packer.js'),
        'verify', cf, '--expect-signer', fp], { encoding: 'utf8' });
    } catch (e) {
      ok = false;
      out = String((e.stdout || '') + (e.stderr || '') + (e.message || ''));
    }
    fs.rmSync(tmp, { recursive: true, force: true });
    if (!ok) {
      throw new Error('只含客户端侧的那一份包，打包器自己读不过 —— "哪一侧在手里"'
        + `那条判据与实现的其余部分对不上：\n${out}`);
    }
  }

  const ctx = { sigAt: tableEnd, otherPub: other, sigId: SIG_ID, sigVer: SIG_VER,
                dsSite, dsClient, priv, rawPub };

  // ★★ **自检：让真的那个读方读一遍。** 上面那块签名块是**本文件手拼的**
  //    （`sigBlockBytes` —— 与三份读方各写各的，夹具的价值正在于此），所以
  //    "拼出来的偏移对不对"必须有一处**不依赖本文件**的东西来判。
  //    打包器的 `verify` 就是那一处：它解析、验签、还要核对血统表与签名者对得上。
  //    ★ 少了这一步，`sigBlockBytes` 里写错一个偏移会让**整批坏包**的期望理由词
  //      一起漂 —— 而那时红的是三端的用例，看起来像"三份实现同时坏了"。
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'slurmate-confsig-'));
    const sf = path.join(tmp, 'signed.splug');
    fs.writeFileSync(sf, signed);
    const fp = crypto.createHash('sha256').update(rawPub).digest('hex');
    let ok = true;
    let out = '';
    try {
      out = sh(process.execPath, [path.join(ROOT, 'packer', 'slurmate-packer.js'),
        'verify', sf, '--expect-signer', fp], { encoding: 'utf8' });
    } catch (e) {
      ok = false;
      out = String((e.stdout || '') + (e.stderr || '') + (e.message || ''));
    }
    fs.rmSync(tmp, { recursive: true, force: true });
    if (!ok) {
      throw new Error('夹具里那份带签名的包，打包器自己读不过 —— 手拼的签名块与实现'
        + `对不上（见 generate.mjs 的 sigBlockBytes）：\n${out}`);
    }
  }

  const expected = {
    _: '由 tools/conformance/generate.mjs 生成，**不要手改**。'
      + '它钉住"三份实现对同一批字节得出同一个答案"，手改等于把夹具挪到实现那边去。',
    tree: 'tools/conformance/tree',
    builtBy: 'packer build（见 generate.mjs —— 它调的是真的那个工具，不是一份抄本）',
    digest,
    files: split(buf).recs.map((r) => ({
      path: r.pathBytes.toString('utf8'),
      size: Number(r.size),
      sha256: r.sha256.toString('hex'),
    })),
    // ★ v0.13：**按侧**分两半（A.3 的四元组要这两个数）。两侧**会重叠** ——
    //   `plugin.json` 与 `lineage.json` 逐字节相同地进两次摘要。
    sides: {
      _: '客户端侧 = `client/**` + `plugin.json` + `lineage.json`；站点侧 = 其余全部。',
      site: {
        digest: dsSite,
        files: sidePairs(parts, 'site').map((x) => x.p.toString('utf8')),
      },
      client: {
        digest: dsClient,
        files: sidePairs(parts, 'client').map((x) => x.p.toString('utf8')),
      },
    },
    package: serializableBytes(buf),
    signed: {
      _: '同一棵树、同一个内容摘要，只是多了一块签名。★ v1 盖的是"整棵树一个摘要"，'
        + 'v2 盖的是 {id, 版本, 站点侧摘要, 客户端侧摘要} 四元组（A.3）—— '
        + '下面那四个字段**就是**被签的那串字节里的东西。'
        + '★ 被签的那把**私钥当场丢掉了** —— 夹具只需要公钥与签名，而验签不需要私钥。',
      alg: 'Ed25519',
      id: SIG_ID,
      version: SIG_VER,
      digestSite: dsSite,
      digestClient: dsClient,
      publicKeyHex: rawPub.toString('hex'),
      fingerprint: crypto.createHash('sha256').update(rawPub).digest('hex'),
      signatureHex: signature.toString('hex'),
      otherPublicKeyHex: other.toString('hex'),
      ...serializableBytes(signed),
    },
    // ★★ v0.13 阶段 4：**站点→客户端那一段真正发出去的那一份** —— 只含客户端侧。
    //
    //  它是「第四份实现」（守护进程那份 Python 的 `package_build(side="client")`）
    //  唯一的**字节级**对账点：同一条记录表、同一块签名（逐字照搬，§4.2），两份
    //  实现打出来的必须逐字节相同。★ 少了它，第四份实现在"装哪几份"这一步上与
    //  另外三份分家时，症状只会是"客户端报摘要对不上"—— 指向钥匙，不指向这里。
    clientSide: {
      _: '只含客户端侧的包（`client/**` + `plugin.json` + `lineage.json`）：站点发给'
        + '客户端的就是它。签名块**逐字**照搬上面那一块 —— 包小了而签名不动，'
        + '这正是 §4.2「禁止签名覆盖信封字节」的用处。'
        + '★ 由**真的打包器**的 buildPackage 打的（见 generate.mjs）。',
      files: sidePairs(parts, 'client').map((x) => x.p.toString('utf8')),
      digest: dsClient,
      ...serializableBytes(clientOnly),
    },
  };

  const bad = {
    _: '一批**坏包**。它们是常量而不是文件（三端拿到的字节必须逐字节相同），'
      + '而"改了什么"写在每一条的 change 里。变异只由 generate.mjs 造，'
      + '三端一个引擎都不用带 —— 它们只解析。',
    _order: '期望的理由词次序见 docs/PLUGIN-SPEC.md 附录 A.4：一个包同时犯两条时，'
      + '先判哪条决定了理由词。',
    _needs: '`needs: "verify"` 的意思是：**只有会验签的那一端才拒得了它**。'
      + '守护进程那个**包解析器**不验签（A.4 第 10 步④它不做，①②③ 它都做），'
      + '所以这几条在那一端**预期会被收下**，而守护进程的用例据此断言"它确实没拒"'
      + '—— 把一条被省掉的检查写成一个有断言的事实，而不是让它悄悄躺在那里。'
      + '★ 站点**真的**验签是在另一个地方（`plugin_reconcile`：启动对账与每次分发前），'
      + '那里问的是另一个问题，别把这两句话读成同一句。',
    cases: CASES.map((c) => {
      const base = c.base === 'signed' ? signed : buf;
      const bytes = c.apply(Buffer.from(base), ctx);
      return Object.assign({
        name: c.name,
        base: c.base || 'unsigned',
        change: c.change,
        why: c.why,
        code: c.code,
        bytes: bytes.length,
        hex: hexLines(bytes),
      }, c.needs ? { needs: c.needs } : {});
    }),
  };

  // 收尾自检：没被改过的包必须原样还原，否则"变异"与"组装"有一边是错的
  if (!roundTrip(buf).equals(buf)) throw new Error('split/join 不能逐字节还原 —— 变异的基础是错的');
  for (const c of bad.cases) {
    if (Buffer.from(c.hex.join(''), 'hex').length !== c.bytes) {
      throw new Error(`${c.name} 的十六进制长度与 bytes 对不上`);
    }
  }

  fs.writeFileSync(path.join(HERE, 'expected.json'), `${JSON.stringify(expected, null, 2)}\n`);
  fs.writeFileSync(path.join(HERE, 'bad.json'), `${JSON.stringify(bad, null, 2)}\n`);
  process.stdout.write(text);
  console.log(`\n写好了：expected.json（${buf.length} B，摘要 ${digest}）、`
    + `bad.json（${bad.cases.length} 条坏包）`);
}

function digestOf(buf) {
  const s = split(buf);
  return digestOfEntries(s.recs.map((r) => ({ p: r.pathBytes, sha: r.sha256.toString('hex') })));
}

main();
