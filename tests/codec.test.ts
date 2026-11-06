import { describe, expect, it } from 'vitest';
import { array, bool, bytes, define, enumOf, f32, f64, i16, i32, i64, i8, optional, PackError, quant, str, u16, u32, u64, u8, varint, varuint, type Codec } from '../src/index.js';
import { vectors } from './vectors.js';

const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const fromHex = (s: string): Uint8Array => Uint8Array.from(s.match(/../g) ?? [], (h) => parseInt(h, 16));

/** Run `fn`, return the PackError it threw (fails the test if it threw anything else or nothing). */
function packError(fn: () => unknown): PackError {
    try {
        fn();
    } catch (e) {
        expect(e).toBeInstanceOf(PackError);
        return e as PackError;
    }
    throw new Error('expected a PackError, nothing was thrown');
}

describe('spec vectors', () => {
    for (const v of vectors) {
        it(`${v.name}: pack gives the spec bytes`, () => {
            expect(hex(v.codec.pack(v.value))).toBe(v.hex);
        });
        it(`${v.name}: unpack reads the spec bytes`, () => {
            expect(v.codec.unpack(fromHex(v.hex))).toEqual('decoded' in v ? v.decoded : v.value);
        });
        it(`${v.name}: packInto and packShared agree with pack`, () => {
            const buf = new Uint8Array(v.codec.max + 3).fill(0xee);
            const n = v.codec.packInto(buf, v.value, 3);
            expect(hex(buf.subarray(3, 3 + n))).toBe(v.hex);
            expect(hex(v.codec.packShared(v.value))).toBe(v.hex);
            expect(buf.subarray(0, 3)).toEqual(new Uint8Array([0xee, 0xee, 0xee]));
            // nothing may be written AFTER the packet either
            expect(buf.subarray(3 + n).every((b) => b === 0xee)).toBe(true);
        });
        it(`${v.name}: a buffer of exactly the packet size is enough`, () => {
            const size = v.hex.length / 2;
            const buf = new Uint8Array(size + 4).fill(0xee);
            expect(v.codec.packInto(buf.subarray(0, size), v.value)).toBe(size);
            expect(hex(buf.subarray(0, size))).toBe(v.hex);
            expect(buf.subarray(size).every((b) => b === 0xee)).toBe(true);
        });
    }
});

describe('sizes', () => {
    it('min and max are exact for fixed types and bounded for variable ones', () => {
        expect([u8.min, u8.max, u16.max, u32.max, u64.max, f32.max, f64.max]).toEqual([1, 1, 2, 4, 8, 4, 8]);
        expect([varuint.min, varuint.max]).toEqual([1, 5]);
        expect([str(32).min, str(32).max]).toEqual([1, 33]);
        expect([str(300).min, str(300).max]).toEqual([1, 302]);
        expect([array(u16, 10).min, array(u16, 10).max]).toEqual([1, 21]);
        const rec = define({ a: u8, b: str(4), c: optional(u32) });
        expect([rec.min, rec.max]).toEqual([1 + 1 + 1, 1 + 5 + 5]);
    });

    it('a buffer of `max` bytes always fits the biggest value', () => {
        const codec = define({ s: str(3), xs: array(u8, 2), o: optional(i32) });
        const worst = { s: '☃', xs: [255, 255], o: -1 };
        const buf = new Uint8Array(codec.max);
        expect(codec.packInto(buf, worst)).toBeLessThanOrEqual(codec.max);
        expect(codec.unpack(buf.subarray(0, codec.packInto(buf, worst)))).toEqual(worst);
    });
});

describe('ownership of the bytes', () => {
    it('pack() returns a fresh array that later calls never touch', () => {
        const c = define({ a: u8, b: u8 });
        const first = c.pack({ a: 1, b: 2 });
        c.pack({ a: 9, b: 9 });
        c.pack({ a: 7, b: 7 });
        expect(hex(first)).toBe('0102');
    });

    it('packInto() writes only the bytes of the packet', () => {
        const c = define({ a: u8 });
        const buf = new Uint8Array(6).fill(0xaa);
        expect(c.packInto(buf, { a: 1 }, 2)).toBe(1);
        expect(hex(buf)).toBe('aaaa01aaaaaa');
    });

    it('packShared() is a view that the next pack overwrites (documented behaviour)', () => {
        const c = define({ a: u8, b: u8 });
        const first = c.packShared({ a: 1, b: 2 });
        expect(hex(first)).toBe('0102');
        c.packShared({ a: 9, b: 9 });
        expect(hex(first)).toBe('0909');
    });

    it('two codecs do not share scratch memory', () => {
        const a = define({ x: u8 });
        const b = define({ x: u8 });
        const va = a.packShared({ x: 1 });
        b.packShared({ x: 2 });
        expect(hex(va)).toBe('01');
    });

    it('bytes() copies by default and can return a view', () => {
        const input = fromHex('03010203');
        const copy = bytes(8).unpack(input);
        const view = bytes(8, { view: true }).unpack(input);
        input[1] = 0x99;
        expect(Array.from(copy)).toEqual([1, 2, 3]);
        expect(Array.from(view)).toEqual([0x99, 2, 3]);
    });

    it('unpack() results are plain objects that own their data', () => {
        const c = define({ a: u8, name: str(8) });
        const buf = c.pack({ a: 1, name: 'x' });
        const one = c.unpack(buf);
        const two = c.unpack(c.pack({ a: 2, name: 'y' }));
        expect(one).toEqual({ a: 1, name: 'x' });
        expect(two).toEqual({ a: 2, name: 'y' });
        expect(one).not.toBe(two);
        expect(Object.getPrototypeOf(one)).toBe(Object.prototype);
    });
});

describe('framing: several values in one buffer', () => {
    it('header + payload with packInto and unpackAt', () => {
        const Header = define({ type: u8, version: u8 });
        const Hello = define({ name: str(16), hp: i16 });
        const buf = new Uint8Array(Header.max + Hello.max);
        let n = Header.packInto(buf, { type: 3, version: 1 });
        n += Hello.packInto(buf, { name: 'D', hp: -13 }, n);

        const [header, at] = Header.unpackAt(buf, 0, n);
        expect(header).toEqual({ type: 3, version: 1 });
        expect(Hello.unpack(buf, at, n)).toEqual({ name: 'D', hp: -13 });
    });

    it('unpack() rejects trailing bytes, unpackAt() allows them', () => {
        const c = u16;
        const buf = fromHex('3412ff');
        expect(packError(() => c.unpack(buf)).code).toBe('invalid');
        expect(c.unpackAt(buf)).toEqual([0x1234, 2]);
        expect(c.unpack(buf, 0, 2)).toBe(0x1234);
    });

    it('works on a Buffer slice and on an ArrayBuffer', () => {
        const c = define({ a: u16 });
        const packed = c.pack({ a: 513 });
        const backing = new Uint8Array(10);
        backing.set(packed, 5);
        expect(c.unpack(backing.subarray(5, 7))).toEqual({ a: 513 });
        expect(c.unpack(Buffer.from(packed))).toEqual({ a: 513 });
        expect(c.unpack(packed.buffer.slice(packed.byteOffset, packed.byteOffset + packed.byteLength) as ArrayBuffer)).toEqual({ a: 513 });
    });
});

describe('packing rejects bad values (nothing wraps, nothing is truncated)', () => {
    const cases: [string, Codec<any>, unknown, string][] = [
        ['u8 above range', u8, 256, 'range'],
        ['u8 negative', u8, -1, 'range'],
        ['u8 fraction', u8, 1.5, 'range'],
        ['u8 NaN', u8, NaN, 'range'],
        ['u8 string', u8, '5', 'type'],
        ['u8 bigint', u8, 5n, 'type'],
        ['i8 below range', i8, -129, 'range'],
        ['i16 above range', i16, 32768, 'range'],
        ['u16 above range', u16, 65536, 'range'],
        ['u32 above range', u32, 4294967296, 'range'],
        ['i32 below range', i32, -2147483649, 'range'],
        ['i32 Infinity', i32, Infinity, 'range'],
        ['u64 negative', u64, -1n, 'range'],
        ['u64 above range', u64, 1n << 64n, 'range'],
        ['u64 plain number', u64, 5, 'type'],
        ['i64 plain number', i64, -5, 'type'],
        ['i64 above range', i64, 1n << 63n, 'range'],
        ['i64 string', i64, '5', 'type'],
        ['f32 string', f32, '1.5', 'type'],
        ['f64 missing', f64, undefined, 'type'],
        ['f64 null', f64, null, 'type'],
        ['bool 1', bool, 1, 'type'],
        ['varuint negative', varuint, -1, 'range'],
        ['varint above range', varint, 2147483648, 'range'],
        ['str number', str(8), 0, 'type'],
        ['str too long (bytes, not characters)', str(4), '☃☃', 'range'],
        ['str too long (ascii)', str(3), 'abcd', 'range'],
        ['bytes string', bytes(8), 'abc', 'type'],
        ['bytes too long', bytes(2), new Uint8Array(3), 'range'],
        ['array too long', array(u8, 2), [1, 2, 3], 'range'],
        ['array not an array', array(u8, 2), 'ab', 'type'],
        ['enum unknown name', enumOf(['a', 'b']), 'c', 'range'],
        ['enum number', enumOf(['a', 'b']), 0, 'type'],
        ['quant above max', quant(0, 1, 8), 1.0001, 'range'],
        ['quant NaN', quant(0, 1, 8), NaN, 'range'],
        ['record not an object', define({ a: u8 }), 5, 'type'],
        ['record missing field', define({ a: u8 }), {}, 'type'],
    ];
    for (const [name, codec, value, code] of cases) {
        it(`${name} -> ${code}`, () => {
            expect(packError(() => codec.pack(value)).code).toBe(code);
            expect(packError(() => codec.packInto(new Uint8Array(64), value)).code).toBe(code);
        });
    }

    it('quant with clamp clamps instead of throwing, but still rejects NaN', () => {
        const c = quant(0, 1, 8, { clamp: true });
        expect(c.unpack(c.pack(5))).toBe(1);
        expect(c.unpack(c.pack(-5))).toBe(0);
        expect(packError(() => c.pack(NaN)).code).toBe('range');
    });

    it('the error says where: players[1].hp', () => {
        const c = define({ players: array(define({ name: str(8), hp: u8 }), 4) });
        const e = packError(() => c.pack({ players: [{ name: 'a', hp: 1 }, { name: 'b', hp: 999 }] }));
        expect(e.path).toEqual(['players', 1, 'hp']);
        expect(e.message).toContain('players[1].hp');
        expect(e.message).toContain('u8');
    });

    it('a failed pack leaves the codec usable', () => {
        const c = define({ a: u8 });
        expect(packError(() => c.pack({ a: 999 })).code).toBe('range');
        expect(hex(c.pack({ a: 5 }))).toBe('05');
    });

    it('a getter that packs again is refused instead of corrupting the buffer', () => {
        const c = define({ a: u8, b: u8 });
        const evil = { a: 1, get b(): number { return c.pack({ a: 0, b: 0 })[0]!; } };
        expect(packError(() => c.pack(evil)).code).toBe('usage');
        expect(hex(c.pack({ a: 1, b: 2 }))).toBe('0102');
    });
});

describe('packInto: buffer too small', () => {
    const codec = define({ n: u32, s: str(10), xs: array(u16, 3) });
    const value = { n: 1, s: 'héllo', xs: [1, 2, 3] };
    const size = codec.pack(value).length;

    it('throws overflow for every size below the packet, and never writes past the buffer', () => {
        for (let len = 0; len < size; len++) {
            const buf = new Uint8Array(len + 4).fill(0x55);
            const view = buf.subarray(0, len);
            expect(packError(() => codec.packInto(view, value)).code).toBe('overflow');
            expect(Array.from(buf.subarray(len))).toEqual([0x55, 0x55, 0x55, 0x55]);
        }
    });

    it('fits when the buffer is exactly the packet size', () => {
        expect(codec.packInto(new Uint8Array(size), value)).toBe(size);
    });

    it('bad offsets are usage errors', () => {
        expect(packError(() => codec.packInto(new Uint8Array(32), value, -1)).code).toBe('usage');
        expect(packError(() => codec.packInto(new Uint8Array(32), value, 33)).code).toBe('usage');
        expect(packError(() => codec.packInto(new Uint8Array(32), value, 1.5)).code).toBe('usage');
    });
});

describe('numbers', () => {
    it('f32 and f64 keep NaN, Infinity and -0', () => {
        expect(Number.isNaN(f64.unpack(f64.pack(NaN)))).toBe(true);
        expect(f64.unpack(f64.pack(Infinity))).toBe(Infinity);
        expect(Object.is(f64.unpack(f64.pack(-0)), -0)).toBe(true);
        expect(Number.isNaN(f32.unpack(f32.pack(NaN)))).toBe(true);
        expect(f32.unpack(f32.pack(1.1))).toBeCloseTo(1.1, 6);
    });

    it('64-bit integers are bigint both ways', () => {
        expect(u64.unpack(u64.pack(5n))).toBe(5n);
        expect(i64.unpack(i64.pack(-5n))).toBe(-5n);
    });

    it('varuint and varint round-trip across the whole range', () => {
        const edges = [0, 1, 63, 64, 127, 128, 255, 16383, 16384, 2097151, 2097152, 268435455, 268435456, 4294967295];
        for (const v of edges) expect(varuint.unpack(varuint.pack(v))).toBe(v);
        const signed = [0, 1, -1, 63, -64, 64, -65, 8191, -8192, 2147483647, -2147483648];
        for (const v of signed) expect(varint.unpack(varint.pack(v))).toBe(v);
    });

    it('quant error stays within half a step', () => {
        for (const bits of [8, 16, 32] as const) {
            const c = quant(-100, 100, bits);
            const half = 200 / (2 ** bits - 1) / 2;
            for (let i = 0; i <= 1000; i++) {
                const v = -100 + (200 * i) / 1000;
                expect(Math.abs(c.unpack(c.pack(v)) - v)).toBeLessThanOrEqual(half * 1.000001);
            }
            expect(c.unpack(c.pack(100))).toBe(100);
            expect(c.unpack(c.pack(-100))).toBe(-100);
        }
    });

    it('quant decodes the top step as exactly max, even where min + (max - min) is not max in floating point', () => {
        // 0.2 + (0.9 - 0.2) = 0.8999999999999999; -1.1 + (0.3 - -1.1) = 0.30000000000000004
        for (const [lo, hi] of [[0.2, 0.9], [-1.1, 0.3], [-0.7, 0.1]] as const) {
            const c = quant(lo, hi, 16);
            expect(c.unpack(c.pack(hi))).toBe(hi);
            expect(c.unpack(c.pack(lo))).toBe(lo);
        }
    });
});

describe('strings', () => {
    it('round-trips every kind of character, including the lone-surrogate replacement', () => {
        const c = str(64);
        for (const s of ['', 'a', 'Hello, мир', '(っ◕‿◕)っ ♥', '😀😀', 'é', '\0', '﻿', '﻿abc']) {
            expect(c.unpack(c.pack(s))).toBe(s);
        }
        expect(c.unpack(c.pack('a\ud800b'))).toBe('a�b');
    });

    it('the limit is in bytes, checked at every boundary', () => {
        for (const ch of ['a', 'é', '☃', '😀']) {
            const bytesPerChar = new TextEncoder().encode(ch).length;
            for (let max = 0; max <= 9; max++) {
                const c = str(max);
                for (let count = 0; count <= 4; count++) {
                    const s = ch.repeat(count);
                    const fits = count * bytesPerChar <= max;
                    if (fits) expect(c.unpack(c.pack(s))).toBe(s);
                    else expect(packError(() => c.pack(s)).code).toBe('range');
                }
            }
        }
    });

    it('long strings with multi-byte length prefixes round-trip', () => {
        const c = str(70000);
        for (const len of [127, 128, 300, 16383, 16384, 20000]) {
            const s = 'ab☃'.repeat(Math.ceil(len / 3)).slice(0, len);
            const bytesLen = new TextEncoder().encode(s).length;
            if (bytesLen <= 70000) expect(c.unpack(c.pack(s))).toBe(s);
        }
    });

    it('malformed UTF-8 decodes to U+FFFD and does not throw', () => {
        expect(str(8).unpack(fromHex('02c328'))).toBe('�(');
    });

    it('a field after a string is not disturbed by the shortened prefix', () => {
        const c = define({ s: str(1000), tail: u16 });
        const v = { s: 'ab', tail: 0xbeef };
        expect(hex(c.pack(v))).toBe('026162efbe');
        expect(c.unpack(c.pack(v))).toEqual(v);
    });
});

describe('definitions', () => {
    it('reject names JavaScript would reorder or that poison the prototype', () => {
        expect(() => define({ '1': u8 })).toThrow(TypeError);
        expect(() => define(JSON.parse('{"__proto__": 1}'))).toThrow(TypeError);
    });

    it('reject values that are not codecs and bad limits', () => {
        expect(() => define({ a: 'u8' } as never)).toThrow(TypeError);
        expect(() => str(-1)).toThrow(TypeError);
        expect(() => str(1.5)).toThrow(TypeError);
        expect(() => str(2 ** 32)).toThrow(TypeError);
        expect(() => array(define({}), 5)).toThrow(TypeError);
        expect(() => enumOf([])).toThrow(TypeError);
        expect(() => enumOf(['a', 'a'])).toThrow(TypeError);
        expect(() => quant(1, 1, 8)).toThrow(TypeError);
        expect(() => quant(0, 1, 12 as never)).toThrow(TypeError);
    });

    it('an enum with more than 256 names uses two bytes', () => {
        const names = Array.from({ length: 300 }, (_, i) => `n${i}`);
        const c = enumOf(names);
        expect(c.max).toBe(2);
        expect(hex(c.pack('n299'))).toBe('2b01');
        expect(c.unpack(fromHex('2b01'))).toBe('n299');
    });

    it('an empty record is a valid, zero-byte packet', () => {
        const c = define({});
        expect(c.pack({}).length).toBe(0);
        expect(c.unpack(new Uint8Array(0))).toEqual({});
    });

    it('optional and nested optional fields', () => {
        const c = define({ a: optional(u8), b: optional(define({ x: u8 })) });
        for (const v of [{ a: 1, b: { x: 2 } }, { a: undefined, b: undefined }, { a: 3, b: undefined }]) {
            expect(c.unpack(c.pack(v))).toEqual(v);
        }
        expect(hex(c.pack({ a: null, b: null } as never))).toBe('0000');
    });
});

describe('a big max does not make pack() reserve that much', () => {
    it('pack() works for a codec whose max is huge', () => {
        const c = define({ big: str(2 ** 30), n: u8 });
        expect(c.max).toBeGreaterThan(2 ** 30);
        const v = { big: 'x'.repeat(5_000_000), n: 1 };
        expect(c.unpack(c.pack(v))).toEqual(v);
        expect(c.unpack(c.pack({ big: 'small', n: 2 }))).toEqual({ big: 'small', n: 2 });
    });
});
