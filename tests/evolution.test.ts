import { describe, expect, it } from 'vitest';
import { added, array, bytes, define, optional, PackError, str, u16, u32, u8 } from '../src/index.js';

const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const fromHex = (s: string): Uint8Array => Uint8Array.from(s.match(/../g) ?? [], (h) => parseInt(h, 16));

function codeOf(fn: () => unknown): string {
    try {
        fn();
    } catch (e) {
        expect(e).toBeInstanceOf(PackError);
        return (e as PackError).code;
    }
    return 'none';
}

// Three generations of the same message. Each one only appends fields, and each is declared extensible so that it
// also reads packets from generations newer than itself.
// The FIRST version is declared extensible, so that it already ignores fields a later version appends.
const V1 = define({ id: u8, name: str(8) }, { extensible: true });
const V2 = define({ id: u8, name: str(8), hp: added(u16, 100) }, { extensible: true });
const V3 = define({ id: u8, name: str(8), hp: added(u16, 100), tag: added(str(4), 'none'), flags: added(u8, 7) }, { extensible: true });

describe('schema evolution: appending fields', () => {
    it('wire bytes of the hand-computed example', () => {
        // V1: id, name           -> 01 026162
        // V2: ... + hp u16 LE    -> 01 026162 0302 (0x0203, little-endian)
        expect(hex(V1.pack({ id: 1, name: 'ab' }))).toBe('01026162');
        expect(hex(V2.pack({ id: 1, name: 'ab', hp: 0x0203 }))).toBe('010261620302');
    });

    it('a new reader fills the fields an old writer did not know with their defaults', () => {
        const fromV1 = fromHex('01026162');
        expect(V2.unpack(fromV1)).toEqual({ id: 1, name: 'ab', hp: 100 });
        expect(V3.unpack(fromV1)).toEqual({ id: 1, name: 'ab', hp: 100, tag: 'none', flags: 7 });
        const fromV2 = V2.pack({ id: 2, name: 'x', hp: 55 });
        expect(V3.unpack(fromV2)).toEqual({ id: 2, name: 'x', hp: 55, tag: 'none', flags: 7 });
    });

    it('an old reader ignores the fields a newer writer appended', () => {
        const fromV3 = V3.pack({ id: 3, name: 'zz', hp: 9, tag: 'abcd', flags: 1 });
        expect(V1.unpack(fromV3)).toEqual({ id: 3, name: 'zz' });
        expect(V2.unpack(fromV3)).toEqual({ id: 3, name: 'zz', hp: 9 });
    });

    it('every generation reads every other generation (3 x 3 matrix)', () => {
        const writers = [
            V1.pack({ id: 1, name: 'a' }),
            V2.pack({ id: 1, name: 'a', hp: 1 }),
            V3.pack({ id: 1, name: 'a', hp: 1, tag: 't', flags: 2 }),
        ];
        for (const bytesOf of writers) {
            for (const reader of [V1, V2, V3]) {
                const got = reader.unpack(bytesOf) as { id: number; name: string };
                expect(got.id).toBe(1);
                expect(got.name).toBe('a');
            }
        }
    });

    it('a packet that stops in the middle of an added field is truncated, not defaulted', () => {
        const full = V3.pack({ id: 1, name: 'ab', hp: 0x0102, tag: 'abc', flags: 9 });
        const boundaries = new Set([4, 6, 10, 11]); // after name, hp, tag, flags
        for (let cut = 0; cut < full.length; cut++) {
            const code = codeOf(() => V3.unpack(full.subarray(0, cut)));
            if (cut < 4) expect(code, `cut ${cut}`).toBe('truncated'); // inside a REQUIRED field
            else if (boundaries.has(cut)) expect(code, `cut ${cut}`).toBe('none');
            else expect(code, `cut ${cut}`).toBe('truncated');
        }
    });

    it('unpackAt on an extensible record consumes its whole range', () => {
        const packet = V3.pack({ id: 1, name: 'ab', hp: 5, tag: 'q', flags: 1 });
        const buf = new Uint8Array(packet.length + 3);
        buf.set(packet, 0);
        const [value, end] = V1.unpackAt(buf, 0, packet.length);
        expect(value).toEqual({ id: 1, name: 'ab' });
        expect(end).toBe(packet.length);
    });

    it('a record that was NOT declared extensible rejects what a newer writer appended', () => {
        const fromV2 = V2.pack({ id: 1, name: 'a', hp: 1 });
        const Closed = define({ id: u8, name: str(8) });
        expect(codeOf(() => Closed.unpack(fromV2))).toBe('invalid');
    });

    it('strict is the default: added() alone fills defaults but still rejects a newer packet', () => {
        const StrictV2 = define({ id: u8, name: str(8), hp: added(u16, 100) });
        // reads older packets (the default is used) and exactly-matching packets...
        expect(StrictV2.unpack(V1.pack({ id: 1, name: 'a' }))).toEqual({ id: 1, name: 'a', hp: 100 });
        expect(StrictV2.unpack(V2.pack({ id: 1, name: 'a', hp: 9 }))).toEqual({ id: 1, name: 'a', hp: 9 });
        // ...but a packet from a newer generation is an error, not silently half-read
        const fromV3 = V3.pack({ id: 1, name: 'a', hp: 9, tag: 'abcd', flags: 1 });
        expect(codeOf(() => StrictV2.unpack(fromV3))).toBe('invalid');
        // and one stray byte after a complete packet is caught too
        const stray = new Uint8Array([...V2.pack({ id: 1, name: 'a', hp: 9 }), 0]);
        expect(codeOf(() => StrictV2.unpack(stray))).toBe('invalid');
        expect(StrictV2.unpackAt(stray)[1]).toBe(stray.length - 1);
    });

    it('a plain define() is strict, and { extensible: false } is the same as leaving it out', () => {
        const plain = define({ a: u8 });
        const off = define({ a: u8 }, { extensible: false });
        for (const c of [plain, off]) expect(codeOf(() => c.unpack(Uint8Array.of(1, 2)))).toBe('invalid');
    });

    it('extensible with no added fields is allowed and nests nowhere', () => {
        const open = define({ a: u8 }, { extensible: true });
        expect(open.unpack(Uint8Array.of(1, 2, 3))).toEqual({ a: 1 });
        expect(() => array(open, 2)).toThrow(TypeError);
    });

    it('min size counts only the required fields, max counts all', () => {
        expect([V1.min, V1.max]).toEqual([2, 10]);
        expect([V2.min, V2.max]).toEqual([2, 12]);
        expect([V3.min, V3.max]).toEqual([2, 12 + 5 + 1]);
    });

    it('the writer always writes every field, and packInto/pack agree', () => {
        const v = { id: 1, name: 'ab', hp: 7, tag: 'zz', flags: 3 };
        const buf = new Uint8Array(V3.max + 2).fill(0xee);
        const n = V3.packInto(buf, v, 1);
        expect(hex(buf.subarray(1, 1 + n))).toBe(hex(V3.pack(v)));
        expect(buf[0]).toBe(0xee);
        expect(buf.subarray(1 + n).every((b) => b === 0xee)).toBe(true);
        expect(codeOf(() => V3.pack({ id: 1, name: 'ab', hp: 7, tag: 'zz' } as never))).toBe('type');
    });

    it('object defaults are copied for every decode, never shared', () => {
        const Vx = define({ id: u8, blob: added(bytes(4), new Uint8Array([1, 2])), list: added(array(u8, 4), [9]) });
        const a = Vx.unpack(Uint8Array.of(1));
        (a.blob as Uint8Array)[0] = 99;
        (a.list as number[]).push(5);
        const b = Vx.unpack(Uint8Array.of(1));
        expect(Array.from(b.blob)).toEqual([1, 2]);
        expect(b.list).toEqual([9]);
    });

    it('errors in an added field carry its name', () => {
        try {
            V3.pack({ id: 1, name: 'a', hp: 70000, tag: 'x', flags: 1 });
        } catch (e) {
            expect((e as PackError).path).toEqual(['hp']);
            return;
        }
        throw new Error('no error');
    });
});

describe('rules that keep evolution safe', () => {
    it('added fields must be last', () => {
        expect(() => define({ a: u8, b: added(u8, 0), c: u8 })).toThrow(TypeError);
        expect(() => define({ a: u8, b: added(u8, 0), c: added(u8, 0) })).not.toThrow();
    });

    it('an extensible record cannot be nested (nothing could follow it)', () => {
        const open = define({ a: u8, b: added(u8, 0) });
        expect(() => array(open, 3)).toThrow(TypeError);
        expect(() => optional(open)).toThrow(TypeError);
        expect(() => define({ inner: open })).toThrow(TypeError);
        expect(() => added(open, { a: 1, b: 1 })).toThrow(TypeError);
        // a record with added() but without extensible is also top-level only: it depends on where its range ends
        expect(() => array(define({ a: u8, b: added(u8, 0) }), 3)).toThrow(TypeError);
        // a plain record may be nested, and may sit inside an extensible one
        const plain = define({ a: u8 });
        expect(() => define({ x: u8, p: added(plain, { a: 1 }) })).not.toThrow();
        expect(() => array(plain, 3)).not.toThrow();
    });

    it('an invalid default is refused when the schema is built', () => {
        expect(() => added(u8, 300)).toThrow(TypeError);
        expect(() => added(str(2), 'abc')).toThrow(TypeError);
        expect(() => added(u8, undefined as never)).toThrow(TypeError);
    });

    it('an added field can itself be a plain record or an array', () => {
        const V = define({ id: u8, pos: added(define({ x: u16, y: u16 }), { x: 0, y: 0 }), items: added(array(u32, 3), []) });
        const old = Uint8Array.of(5);
        expect(V.unpack(old)).toEqual({ id: 5, pos: { x: 0, y: 0 }, items: [] });
        const full = V.pack({ id: 5, pos: { x: 1, y: 2 }, items: [7, 8] });
        expect(V.unpack(full)).toEqual({ id: 5, pos: { x: 1, y: 2 }, items: [7, 8] });
        // stops in the middle of the added record: truncated
        expect(codeOf(() => V.unpack(full.subarray(0, 3)))).toBe('truncated');
    });
});

describe('extensible records and hostile input', () => {
    it('random bytes and truncations only ever throw PackError', () => {
        let s = 12345;
        const next = (): number => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
        for (let i = 0; i < 20000; i++) {
            const b = Uint8Array.from({ length: Math.floor(next() * 40) }, () => Math.floor(next() * 256));
            codeOf(() => V3.unpack(b));
        }
        const full = V3.pack({ id: 1, name: 'abcdefgh', hp: 1, tag: 'abcd', flags: 1 });
        for (let i = 0; i < 20000; i++) {
            const m = full.slice();
            m[Math.floor(next() * m.length)] = Math.floor(next() * 256);
            codeOf(() => V3.unpack(m));
        }
    });

    it('a huge unknown tail is simply ignored, with no allocation for it', () => {
        const tail = new Uint8Array(1_000_000).fill(0x77);
        const packet = V1.pack({ id: 1, name: 'ab' });
        const buf = new Uint8Array(packet.length + tail.length);
        buf.set(packet, 0);
        buf.set(tail, packet.length);
        expect(V1.unpack(buf)).toEqual({ id: 1, name: 'ab' });
    });
});
