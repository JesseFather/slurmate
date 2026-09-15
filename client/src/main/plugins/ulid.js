'use strict';
/**
 * plugins/ulid.js —— 插件的全球唯一标识符。
 *
 * ── 它是什么，不是什么 ──────────────────────────────────────────────────────
 *
 * 插件的 `id` **不是名字**，是**铸造出来的**标识符：一个插件诞生时生成一次，
 * 此后永不改变。名字（`name` / `displayName`）可以随时改，`id` 不行。
 *
 * 所以同一个插件被两个站点分发时，两边的 `id` 是同一个 —— 因为它们是同一个构件，
 * 而不是因为谁记得把名字拼对。反过来，两个站点各写一个 jupyter 是两个不同的
 * `id`，客户端让它们**并存**，各自标明来源站点。
 *
 * ── 为什么是 ULID ───────────────────────────────────────────────────────────
 *
 * 128 位 = 48 位毫秒时间戳 + 80 位密码学随机，编码成 26 个 Crockford base32 字符。
 *
 *   · **冲突概率可忽略**：80 位随机，每秒铸十亿个也要几千年才有一半概率撞一次。
 *     不需要注册表、不需要协调、不需要密钥 —— 这正是「生成即唯一」。
 *   · **按时间可排序**：字典序 = 铸造序。池里的目录列表天然按诞生先后排。
 *   · 26 个字符，字母表刻意去掉了 I / L / O / U —— 手抄或口头念给管理员听时
 *     不会和 1 / 0 混。
 *
 * ★ 「不可伪造」**不在这一层**。随机不等于密码学意义上的不可伪造：任何人都能
 *   随手编一个长得一样的字符串。防冒用是**站点签名**那一层的事（见计划里的
 *   四条护栏）。这里只保证「撞不上」，不保证「冒不了」。
 *
 * ★ 也不是 snowflake：那要每个作者配一个不重复的机器号，而作者可能就是一台
 *   笔记本 —— 配错就是**真的会撞**，而随机位本来已经够用。
 */

const crypto = require('crypto');

// Crockford base32：去掉了 I、L、O、U。
const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** 26 个字符，且只含字母表里那些。用于校验清单里的 `id`。 */
const ULID_RE = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/;

/** 毫秒时间戳占 48 位 → 10 个字符（50 位，头 2 位恒为 0）。 */
const TIME_CHARS = 10;
/** 随机部分占 80 位 → 正好 16 个字符。 */
const RANDOM_CHARS = 16;

/** 48 位时间戳的上限。超过了这个长度就编不进去了（公元 10889 年）。 */
const MAX_TIME = 2 ** 48 - 1;

function encodeTime(ms) {
  let s = '';
  let v = ms;
  for (let i = 0; i < TIME_CHARS; i++) {
    s = ENCODING[v % 32] + s;
    v = Math.floor(v / 32);
  }
  return s;
}

/**
 * 80 位随机 → 16 个字符，每字符 5 位。
 *
 * 5 位一组会跨字节边界，所以按**位偏移**取而不是按字节取。用 `(b[i] << 8) |
 * (b[i+1] || 0)` 拼出 16 位再右移到目标位置 —— 末尾那个字节不存在时按 0 补，
 * 而最后 5 位正好落在最后一个字节里，补进来的 0 不会被用到（`>> 8` 之后
 * 高位已经被移走了）。
 */
function encodeRandom() {
  const b = crypto.randomBytes(10);            // 10 字节 = 80 位
  let s = '';
  for (let i = 0; i < RANDOM_CHARS; i++) {
    const bit = i * 5;
    const byte = bit >> 3;
    const shift = bit & 7;
    const v = (((b[byte] << 8) | (b[byte + 1] || 0)) >> (11 - shift)) & 31;
    s += ENCODING[v];
  }
  return s;
}

/**
 * 铸一个新的 id。
 *
 * @param {number} [now] 毫秒时间戳。只给测试用 —— 生产代码永远不传，
 *   否则「同一个时间戳铸两个」就成了调用方的事，而我们想要的恰恰是
 *   「谁也不用操心」。
 */
function mint(now) {
  const ms = now === undefined ? Date.now() : now;
  if (!Number.isInteger(ms) || ms < 0 || ms > MAX_TIME) {
    throw new RangeError(`铸 id 失败：时间戳 ${ms} 超出 48 位能表示的范围`);
  }
  return encodeTime(ms) + encodeRandom();
}

/** 这个字符串像不像一个 id。清单校验与守护进程都用它。 */
function isId(s) {
  return typeof s === 'string' && ULID_RE.test(s);
}

/** 从 id 反解出铸造时间（调试与「池里按诞生排序」用）。解不出来返回 null。 */
function mintedAt(id) {
  if (!isId(id)) return null;
  let ms = 0;
  for (const ch of id.slice(0, TIME_CHARS)) ms = ms * 32 + ENCODING.indexOf(ch);
  return ms;
}

module.exports = { mint, isId, mintedAt, ULID_RE, ENCODING };
