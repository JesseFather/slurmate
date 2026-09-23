/**
 * atomic-write.test.mjs —— 框架里唯一那份原子写。
 *
 * 它取代了三份逐字不同的实现（`config.js` / `site-plugins.js` / `sshconfig.js`）。
 * 前两份删掉了，**第三份删不掉**：`plugins/sshd/client/sshconfig.js` 跑在池里，
 * require 不到客户端的源码（`plugins/README.md` 那条纪律）。所以本文件后半段是那条
 * 事实的**唯一防腐剂** —— 同一张场景表喂两份实现，只改一边就红。
 *
 * ★ 每条用例都要能回答"改坏了会红，而且报出来的是真正的原因"：
 *   · "不留临时文件"红 ⇒ 报告里会列出那个残留的名字；
 *   · "已存在的父目录权限没被动过"红 ⇒ 报告里会报出被改成了什么。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const A = require('../src/main/atomic-write.js');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'slurmate-aw-'));
}

/** 目录里剩下的东西（用来断言"没留下临时文件"）。 */
const leftovers = (dir) => fs.readdirSync(dir).filter((n) => n.startsWith('.')).sort();

// ── 成功那条路 ──────────────────────────────────────────────────────────────

test('写成功：内容与权限都对，且不留临时文件', () => {
  const d = tmpdir();
  const f = path.join(d, 'a.conf');
  const r = A.writeAtomic(f, 'hello', { mode: 0o600 });
  assert.deepEqual(r, { ok: true });
  assert.equal(fs.readFileSync(f, 'utf8'), 'hello');
  assert.equal(fs.statSync(f).mode & 0o777, 0o600, '文件必须是 0600');
  assert.deepEqual(leftovers(d), [], '临时文件必须已经被 rename 走了');
});

test('父目录不存在时自建（递归），权限 0700', () => {
  const d = tmpdir();
  const f = path.join(d, 'x', 'y', 'a.conf');
  const r = A.writeAtomic(f, 'hi', { mode: 0o600 });
  assert.deepEqual(r, { ok: true });
  assert.equal(fs.existsSync(f), true);
  assert.equal(fs.statSync(path.join(d, 'x')).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(d, 'x', 'y')).mode & 0o777, 0o700);
});

test('★ 已存在的父目录，权限一个 bit 都不许动', () => {
  // ★ 这一条守的是一个**真实存在过的行为**：被取代的那份 `config.js` 实现里有一句
  //   `try { fs.chmodSync(dir, mode); }` —— 于是每一次写配置都会把一个**已经存在**的
  //   目录 chmod 成 0700，而那个目录可能是 Electron 的 `userData`、可能是用户自己的
  //   目录。这不是它被要求做的事，而且**没有任何地方会报错**。
  const d = tmpdir();
  const sub = path.join(d, 'mine');
  fs.mkdirSync(sub, { mode: 0o755 });
  fs.chmodSync(sub, 0o755);                    // 显式设一遍，免得受 umask 影响
  const before = fs.statSync(sub).mode & 0o777;
  A.writeAtomic(path.join(sub, 'a.conf'), 'x', { mode: 0o600 });
  assert.equal(fs.statSync(sub).mode & 0o777, before,
    '写一个文件不该顺手改它所在目录的权限');
});

// ── 失败那条路：返回结构化结果，**不抛**，也不留残骸 ────────────────────────

test('★ 写失败：返回 {ok:false} 而不是抛，且不留临时文件', () => {
  const d = tmpdir();
  // `mkdir:false` 明确表示"父目录由我保证在" —— 而它不在。
  const f = path.join(d, 'nope', 'a.conf');
  const r = A.writeAtomic(f, 'x', { mode: 0o600, mkdir: false });
  assert.equal(r.ok, false);
  assert.equal(typeof r.error, 'string');
  assert.ok(r.error.length > 0);
  assert.equal(fs.existsSync(f), false);
});

test('★ rename 失败：同样返回 {ok:false}，且临时文件被清掉', () => {
  // 让 rename 失败的最省事的办法：目标是**一个已经存在的目录**（POSIX 上 rename
  // 文件到目录会 EISDIR）。
  const d = tmpdir();
  const target = path.join(d, 'iam-a-dir');
  fs.mkdirSync(target);
  const r = A.writeAtomic(target, 'x', { mode: 0o600 });
  assert.equal(r.ok, false, '写不进去必须如实说');
  assert.deepEqual(leftovers(d), [],
    '失败路径上留下的那个临时文件，会在用户的目录里一直躺到天荒地老');
});

test('writeAtomicOrThrow：同一条失败路径变成长出异常（给"写不下去就该炸"的调用方）', () => {
  const d = tmpdir();
  const target = path.join(d, 'iam-a-dir');
  fs.mkdirSync(target);
  assert.throws(() => A.writeAtomicOrThrow(target, 'x', { mode: 0o600 }), /失败/);
  // ★ 成功时它返回 undefined（没有第二个返回值要维护）—— 钉住这一点，免得有人
  //   以为它像 writeAtomic 那样返回结果，然后在调用点写 `if (!r.ok)` 而 r 是 undefined。
  assert.equal(A.writeAtomicOrThrow(path.join(d, 'ok.conf'), 'x', { mode: 0o600 }),
    undefined);
});

test('writeJsonAtomic：两格缩进（这些文件是给人看的）', () => {
  const d = tmpdir();
  const f = path.join(d, 'r.json');
  assert.deepEqual(A.writeJsonAtomic(f, { a: 1 }), { ok: true });
  assert.equal(fs.readFileSync(f, 'utf8'), '{\n  "a": 1\n}');
});

// ── 符号链接：默认**不跟随**，显式才跟随 ────────────────────────────────────

test('★ 默认 refuse：目标是符号链接时，链接本身被换成普通文件', () => {
  // ★ 把"默认不跟随"**显式钉住**，理由只有一个：只有钉住了，"有人把默认改成
  //   follow"才会红。默认跟随会让框架自己那七个状态文件（config.json、.sites.json…）
  //   全都开始跟着链接跑到别处去 —— 那是"用一个只对一处成立的规则去改另外七处"。
  const d = tmpdir();
  const real = path.join(d, 'real.conf');
  const link = path.join(d, 'link.conf');
  fs.writeFileSync(real, 'old');
  fs.symlinkSync(real, link);

  assert.deepEqual(A.writeAtomic(link, 'new', { mode: 0o600 }), { ok: true });
  assert.equal(fs.lstatSync(link).isSymbolicLink(), false, '默认不跟随：链接被换成普通文件');
  assert.equal(fs.readFileSync(real, 'utf8'), 'old', '链接指向的那个文件一个字没动');
  assert.equal(fs.readFileSync(link, 'utf8'), 'new');
});

test('★ link:follow：链接留着，内容写进它指向的那个文件（dotfiles 工作流）', () => {
  // 用 dotfiles 管理 ssh 配置的人：`~/.ssh/config -> ~/dotfiles/config`。rename(2)
  // 不跟随目标上的符号链接，直接 rename 上去会把链接换成普通文件 —— 于是他改
  // `~/dotfiles/config` 不再影响 ssh，两边从此各说各话，而**没有任何地方会报错**。
  const d = tmpdir();
  const real = path.join(d, 'dotfiles-config');
  const link = path.join(d, 'config');
  fs.writeFileSync(real, 'old');
  fs.symlinkSync(real, link);

  assert.deepEqual(A.writeAtomic(link, 'new', { mode: 0o600, link: 'follow' }), { ok: true });
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true, '链接必须还在（dotfiles 工作流）');
  assert.equal(fs.readFileSync(real, 'utf8'), 'new', '内容要进它指向的那个文件');
  assert.deepEqual(leftovers(d), [], '★ 临时文件必须建在**解析后**的目录里，否则跨文件系统');
});
