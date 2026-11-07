// In-browser check of 2pack: the spec vectors, ownership rules, bounds, hostile input and changing buffers,
// run against the real library in a real browser. Open it with `npm run browser`.
// Проверка 2pack в браузере: эталонные векторы, правила владения, границы, враждебный ввод и меняющиеся буферы.
// Запускается командой `npm run browser`. Results go to the page and to window.__result (for automation).
import { added, array, bool, bytes, define, enumOf, f32, f64, i16, i32, i64, optional, PackError, quant, str, u16, u32, u64, u8, varint, varuint } from './src/index.js';
import { vectors } from './tests/vectors.js';

const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const fromHex = (s) => Uint8Array.from(s.match(/../g) ?? [], (h) => parseInt(h, 16));
const eq = (a, b, msg) => {
    const same = typeof a === 'object' && a !== null ? JSON.stringify(a, (_, v) => (typeof v === 'bigint' ? `${v}n` : v instanceof Uint8Array ? [...v] : v)) === JSON.stringify(b, (_, v) => (typeof v === 'bigint' ? `${v}n` : v instanceof Uint8Array ? [...v] : v)) : Object.is(a, b);
    if (!same) throw new Error(`${msg ?? 'not equal'}: got ${String(JSON.stringify(a, (_, v) => (typeof v === 'bigint' ? `${v}n` : v)))} expected ${String(JSON.stringify(b, (_, v) => (typeof v === 'bigint' ? `${v}n` : v)))}`);
};
const ok = (cond, msg) => { if (!cond) throw new Error(msg); };
const code = (fn) => { try { fn(); } catch (e) { if (!(e instanceof PackError)) throw new Error(`non-PackError ${e?.constructor?.name}: ${e?.message}`); return e.code; } return 'none'; };

const results = [];
let currentGroup = '';
function group(name) { currentGroup = name; }
function test(name, fn) {
    try { fn(); results.push({ group: currentGroup, name, pass: true }); }
    catch (e) { results.push({ group: currentGroup, name, pass: false, error: String(e?.message ?? e) }); }
}

// --- environment --------------------------------------------------------------------------------------------------
group('environment');
test('no Node Buffer is present (this is a browser)', () => ok(typeof Buffer === 'undefined' && typeof process === 'undefined', 'Buffer/process exist'));
test('TextEncoder, TextDecoder, DataView, BigInt64 exist', () => ok(typeof TextEncoder === 'function' && typeof TextDecoder === 'function' && typeof DataView === 'function' && typeof BigInt64Array === 'function', 'missing'));
test('little-endian host', () => ok(new Uint8Array(new Uint16Array([1]).buffer)[0] === 1, 'big-endian host?'));

// --- spec vectors -------------------------------------------------------------------------------------------------
group('spec vectors');
for (const v of vectors) {
    test(`${v.name}`, () => {
        eq(hex(v.codec.pack(v.value)), v.hex, 'pack');
        eq(v.codec.unpack(fromHex(v.hex)), 'decoded' in v ? v.decoded : v.value, 'unpack');
        const size = v.hex.length / 2;
        const buf = new Uint8Array(size + 6).fill(0xee);
        eq(v.codec.packInto(buf.subarray(3, 3 + size), v.value), size, 'packInto exact size');
        eq(hex(buf.subarray(3, 3 + size)), v.hex, 'packInto bytes');
        ok(buf.subarray(0, 3).every((b) => b === 0xee) && buf.subarray(3 + size).every((b) => b === 0xee), 'wrote outside the packet');
        eq(hex(v.codec.packShared(v.value)), v.hex, 'packShared');
    });
}

// --- ownership ----------------------------------------------------------------------------------------------------
group('ownership');
test('pack() result is untouched by later packs', () => { const c = define({ a: u8, b: u8 }); const first = c.pack({ a: 1, b: 2 }); c.pack({ a: 9, b: 9 }); eq(hex(first), '0102'); });
test('packShared() view is overwritten by the next pack (documented)', () => { const c = define({ a: u8, b: u8 }); const first = c.packShared({ a: 1, b: 2 }); c.packShared({ a: 9, b: 9 }); eq(hex(first), '0909'); });
test('bytes(): copy by default, view on request', () => { const input = fromHex('03010203'); const copy = bytes(8).unpack(input); const view = bytes(8, { view: true }).unpack(input); input[1] = 0x99; eq([...copy], [1, 2, 3]); eq([...view], [0x99, 2, 3]); });
test('unpack accepts an ArrayBuffer and a subarray with a byte offset', () => {
    const c = define({ a: u16 }); const p = c.pack({ a: 513 });
    const backing = new Uint8Array(12); backing.set(p, 5);
    eq(c.unpack(backing.subarray(5, 7)), { a: 513 }); eq(c.unpack(p.buffer.slice(0, 2)), { a: 513 });
});

// --- strings ------------------------------------------------------------------------------------------------------
group('strings');
test('every kind of character round-trips, including a leading BOM', () => { const c = str(64); for (const s of ['', 'a', 'Hello, мир', '(っ◕‿◕)っ ♥', '😀😀', 'é', '\0', '﻿', '﻿abc']) eq(c.unpack(c.pack(s)), s, JSON.stringify(s)); });
test('a lone surrogate becomes U+FFFD', () => eq(str(8).unpack(str(8).pack('a\ud800b')), 'a�b'));
test('byte limit at every boundary, exact buffers, nothing written outside', () => {
    for (const ch of ['a', 'é', '☃', '😀']) {
        const per = new TextEncoder().encode(ch).length;
        for (const max of [0, 1, 2, 126, 127, 128, 129, 300, 16383, 16384, 16385]) {
            const c = str(max);
            for (const count of [0, 1, 2, 3, 60, 126, 127, 128, 129, 200]) {
                const s = ch.repeat(count);
                if (count * per > max) { eq(code(() => c.pack(s)), 'range', `${ch}x${count} in str(${max})`); continue; }
                const want = c.pack(s);
                const buf = new Uint8Array(want.length + 8).fill(0x5a);
                const n = c.packInto(buf.subarray(4, 4 + want.length), s);
                eq(n, want.length, 'length'); eq(hex(buf.subarray(4, 4 + n)), hex(want), 'bytes');
                ok(buf.subarray(0, 4).every((b) => b === 0x5a) && buf.subarray(4 + n).every((b) => b === 0x5a), `wrote outside: ${ch}x${count} str(${max})`);
                eq(c.unpack(want), s, 'round trip');
            }
        }
    }
});

// --- bad values ---------------------------------------------------------------------------------------------------
group('rejects bad values');
for (const [name, c, v, want] of [
    ['u8 256', u8, 256, 'range'], ['u8 1.5', u8, 1.5, 'range'], ['u8 NaN', u8, NaN, 'range'], ['u8 "5"', u8, '5', 'type'], ['u8 5n', u8, 5n, 'type'],
    ['i32 Infinity', i32, Infinity, 'range'], ['u64 -1n', u64, -1n, 'range'], ['u64 5', u64, 5, 'type'], ['f64 undefined', f64, undefined, 'type'],
    ['str too long', str(3), 'abcd', 'range'], ['bytes string', bytes(8), 'abc', 'type'], ['array too long', array(u8, 2), [1, 2, 3], 'range'],
    ['enum unknown', enumOf(['a', 'b']), 'c', 'range'], ['quant over', quant(0, 1, 8), 2, 'range'], ['record missing field', define({ a: u8 }), {}, 'type'],
    ['record given an array', define({ length: u8 }), [1, 2], 'type'],
]) test(`${name} -> ${want}`, () => eq(code(() => c.pack(v)), want));
test('the error path names the field', () => { try { define({ p: array(define({ hp: u8 }), 3) }).pack({ p: [{ hp: 1 }, { hp: 999 }] }); } catch (e) { eq(e.path, ['p', 1, 'hp']); return; } throw new Error('no error'); });

// --- hostile input ------------------------------------------------------------------------------------------------
group('hostile input');
function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const int = (r, lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
const Item = define({ id: varuint, label: str(12), flag: bool });
const Packet = define({ seq: u32, kind: enumOf(['join', 'move', 'chat']), pos: define({ x: quant(-500, 500, 16), y: quant(-500, 500, 16) }), name: optional(str(300)), items: array(Item, 6), blob: bytes(16), score: i64, delta: varint, ratio: f32 });
const chars = ['a', 'Z', ' ', 'é', 'я', '☃', '😀'];
const word = (r, max) => { let s = ''; for (let i = int(r, 0, 6); i > 0; i--) { const n = s + chars[int(r, 0, chars.length - 1)]; if (new TextEncoder().encode(n).length > max) break; s = n; } return s; };
const randomPacket = (r) => ({ seq: int(r, 0, 4294967295), kind: ['join', 'move', 'chat'][int(r, 0, 2)], pos: { x: Math.fround(int(r, -500, 500)), y: Math.fround(int(r, -500, 500)) }, name: r() < 0.5 ? undefined : word(r, 20), items: Array.from({ length: int(r, 0, 6) }, () => ({ id: int(r, 0, 4294967295), label: word(r, 12), flag: r() < 0.5 })), blob: Uint8Array.from({ length: int(r, 0, 16) }, () => int(r, 0, 255)), score: BigInt(int(r, -1000000, 1000000)) * 1000000007n, delta: int(r, -2147483648, 2147483647), ratio: Math.fround((r() - 0.5) * 1000) });
test('3000 random packets round-trip (quant compared with tolerance)', () => {
    const r = rng(1);
    for (let i = 0; i < 3000; i++) { const v = randomPacket(r); const o = Packet.unpack(Packet.pack(v)); ok(Math.abs(o.pos.x - v.pos.x) < 0.01 && Math.abs(o.pos.y - v.pos.y) < 0.01, 'quant'); eq({ ...o, pos: 0 }, { ...v, pos: 0 }, `packet ${i}`); }
});
test('packInto into an exactly sized buffer: fits, nothing outside', () => {
    const r = rng(7);
    for (let i = 0; i < 1500; i++) { const v = randomPacket(r); const size = Packet.pack(v).length; const buf = new Uint8Array(size + 16).fill(0xab); eq(Packet.packInto(buf.subarray(8, 8 + size), v), size); ok(buf.subarray(0, 8).every((b) => b === 0xab) && buf.subarray(8 + size).every((b) => b === 0xab), `spill at ${i}`); }
});
test('every truncation of 200 packets: only PackError', () => {
    const r = rng(4);
    for (let i = 0; i < 200; i++) { const b = Packet.pack(randomPacket(r)); for (let cut = 0; cut < b.length; cut++) code(() => Packet.unpack(b.subarray(0, cut))); }
});
test('20000 random single-byte corruptions: only PackError, and many are caught', () => {
    const r = rng(5); let rejected = 0;
    for (let i = 0; i < 20000; i++) { const b = Packet.pack(randomPacket(r)).slice(); b[int(r, 0, b.length - 1)] = int(r, 0, 255); if (code(() => Packet.unpack(b)) !== 'none') rejected++; }
    ok(rejected > 500, `only ${rejected} corruptions rejected`);
});
test('random bytes of every length: only PackError', () => { const r = rng(6); for (let i = 0; i < 10000; i++) { const b = Uint8Array.from({ length: int(r, 0, 80) }, () => int(r, 0, 255)); code(() => Packet.unpack(b)); code(() => Item.unpack(b)); code(() => str(10).unpack(b)); } });
test('a count of 4 billion in a 5-byte packet is rejected fast and without an index in the path', () => {
    const huge = array(define({ a: u32 }), 4294967295); const t0 = performance.now();
    try { huge.unpack(Uint8Array.from([0xff, 0xff, 0xff, 0xff, 0x0f])); } catch (e) { ok(e instanceof PackError && e.code === 'truncated' && e.path.length === 0, `code ${e.code} path ${JSON.stringify(e.path)}`); ok(performance.now() - t0 < 500, 'too slow'); return; }
    throw new Error('no error');
});
test('varints: overlong / too long / too large rejected', () => { for (const b of [[0x80, 0x00], [0x81, 0x00], [0x80, 0x80, 0x80, 0x80, 0x80, 0x00], [0xff, 0xff, 0xff, 0xff, 0x1f]]) eq(code(() => varuint.unpack(Uint8Array.from(b))), 'invalid', JSON.stringify(b)); });
test('end beyond the buffer is a usage error', () => eq(code(() => u16.unpack(Uint8Array.from([1, 2]), 0, 100)), 'usage'));

// --- changing buffers ---------------------------------------------------------------------------------------------
group('resizable and detached buffers');
test('resizable buffer that grows', () => { const ab = new ArrayBuffer(8, { maxByteLength: 64 }); const u = new Uint8Array(ab); u32.packInto(u, 1); ab.resize(32); eq(u32.packInto(u, 0xdeadbeef, 16), 4); eq(u32.unpack(u, 16, 20), 0xdeadbeef); });
test('resizable buffer that shrinks', () => { const ab = new ArrayBuffer(16, { maxByteLength: 64 }); const u = new Uint8Array(ab); u8.packInto(u, 1); ab.resize(4); eq(u8.packInto(u, 2), 1); eq(code(() => u32.packInto(u, 1, 2)), 'overflow'); });
test('transferred (detached) buffer is a PackError and codecs keep working', () => { const ab = new ArrayBuffer(8); const u = new Uint8Array(ab); u8.packInto(u, 1); ab.transfer(); ok(code(() => u8.packInto(u, 2)) !== 'none'); ok(code(() => u8.unpack(u)) !== 'none'); eq(hex(u16.pack(0x0102)), '0201'); });

// --- schema evolution ---------------------------------------------------------------------------------------------
group('schema evolution');
const V1 = define({ id: u8, name: str(8) }, { extensible: true });
const V2 = define({ id: u8, name: str(8), hp: added(u16, 100) }, { extensible: true });
const V3 = define({ id: u8, name: str(8), hp: added(u16, 100), tag: added(str(4), 'none') }, { extensible: true });
test('3 x 3: every generation reads every other generation', () => {
    const packets = [V1.pack({ id: 1, name: 'a' }), V2.pack({ id: 1, name: 'a', hp: 1 }), V3.pack({ id: 1, name: 'a', hp: 1, tag: 't' })];
    for (const p of packets) for (const reader of [V1, V2, V3]) { const g = reader.unpack(p); eq(g.id, 1); eq(g.name, 'a'); }
});
test('a new reader defaults what an old writer did not send; an old reader ignores the new tail', () => {
    eq(V3.unpack(V1.pack({ id: 2, name: 'zz' })), { id: 2, name: 'zz', hp: 100, tag: 'none' });
    eq(V1.unpack(V3.pack({ id: 3, name: 'q', hp: 9, tag: 'abcd' })), { id: 3, name: 'q' });
});
test('a packet cut in the middle of an added field is truncated, not defaulted', () => {
    const full = V3.pack({ id: 1, name: 'ab', hp: 0x0102, tag: 'abc' });
    eq(hex(V2.pack({ id: 1, name: 'ab', hp: 0x0203 })), '010261620302', 'wire bytes');
    eq(code(() => V3.unpack(full.subarray(0, 5))), 'truncated', 'cut inside hp');
    eq(code(() => V3.unpack(full.subarray(0, 6))), 'none', 'cut on a boundary');
});
test('an extensible record cannot be nested; a closed record rejects a newer tail', () => {
    let refused = 0;
    for (const f of [() => array(V1, 2), () => optional(V1), () => define({ inner: V1 })]) { try { f(); } catch (e) { if (e instanceof TypeError) refused++; } }
    eq(refused, 3, 'nesting refusals');
    eq(code(() => define({ id: u8, name: str(8) }).unpack(V2.pack({ id: 1, name: 'a', hp: 1 }))), 'invalid');
    const StrictV2 = define({ id: u8, name: str(8), hp: added(u16, 100) }); // added() alone is still strict
    eq(StrictV2.unpack(V1.pack({ id: 1, name: 'a' })).hp, 100, 'default for an older packet');
    eq(code(() => StrictV2.unpack(V3.pack({ id: 1, name: 'a', hp: 9, tag: 'abcd' }))), 'invalid', 'a newer packet is rejected');
});

// --- speed (informational) ----------------------------------------------------------------------------------------
const hero = { name: 'Hero_123456', lvl: 42, hp: 1337, gm: 3, x: 300.9, y: -300.52 };
const Hero = define({ name: str(32), lvl: u8, hp: u16, gm: u8, x: f32, y: f32 });
function ns(fn, n) { for (let i = 0; i < 20000; i++) fn(); const runs = []; for (let r = 0; r < 5; r++) { const t = performance.now(); for (let i = 0; i < n; i++) fn(); runs.push(((performance.now() - t) * 1e6) / n); } return Math.round(runs.sort((a, b) => a - b)[2]); }
const own = Hero.pack(hero); const buf = new Uint8Array(Hero.max); const json = JSON.stringify(hero); const jsonBytes = new TextEncoder().encode(json); let sink;
const speed = {
    sizeBytes: { '2pack': own.length, JSON: jsonBytes.length },
    ns: {
        '2pack pack': ns(() => { sink = Hero.pack(hero); }, 300000), '2pack packInto': ns(() => { sink = Hero.packInto(buf, hero); }, 300000), '2pack unpack': ns(() => { sink = Hero.unpack(own); }, 300000),
        'JSON.stringify+TextEncoder': ns(() => { sink = new TextEncoder().encode(JSON.stringify(hero)); }, 300000), 'JSON.parse(TextDecoder)': ns(() => { sink = JSON.parse(new TextDecoder().decode(jsonBytes)); }, 300000),
    },
};
void sink;

// --- report -------------------------------------------------------------------------------------------------------
const failed = results.filter((r) => !r.pass);
const byGroup = {};
for (const r of results) { byGroup[r.group] ??= { pass: 0, fail: 0 }; byGroup[r.group][r.pass ? 'pass' : 'fail']++; }
window.__result = { userAgent: navigator.userAgent, total: results.length, passed: results.length - failed.length, failed: failed.length, byGroup, failures: failed, speed };
const out = document.getElementById('out');
out.textContent = `${window.__result.passed}/${window.__result.total} passed in ${navigator.userAgent}\n\n` + Object.entries(byGroup).map(([g, c]) => `${c.fail ? 'FAIL' : 'ok  '} ${g}: ${c.pass}/${c.pass + c.fail}`).join('\n') + (failed.length ? '\n\nFAILURES:\n' + failed.map((f) => `- [${f.group}] ${f.name}: ${f.error}`).join('\n') : '') + `\n\nspeed (this browser, informational):\n` + JSON.stringify(speed, null, 1);
document.title = failed.length ? `FAIL ${failed.length}` : `PASS ${results.length}`;
