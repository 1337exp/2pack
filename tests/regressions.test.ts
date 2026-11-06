import { describe, expect, expectTypeOf, it } from 'vitest';
import { array, define, enumOf, i64, optional, PackError, quant, str, u16, u32, u8, type Codec, type Infer } from '../src/index.js';

// Each block here is a bug found by an independent review (Grok, 2026-11-07, run against the first v2 commit)
// and reproduced before it was fixed.
// Каждый блок: баг, найденный независимым ревью и воспроизведённый до исправления.

const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

function packErrorCode(fn: () => unknown): string {
    try {
        fn();
    } catch (e) {
        expect(e).toBeInstanceOf(PackError);
        return (e as PackError).code;
    }
    return 'none';
}

describe('str: packInto writes nothing outside the packet', () => {
    // The length prefix is 1..5 bytes. The old code staged the body for the LARGEST prefix of the declared max
    // and then shifted it back, leaving stray bytes after the packet and demanding extra room.
    const chars: [string, string][] = [['a', 'ascii'], ['é', '2-byte'], ['☃', '3-byte'], ['😀', '4-byte']];
    const maxes = [0, 1, 2, 126, 127, 128, 129, 300, 16383, 16384, 16385, 70000];
    const counts = [0, 1, 2, 3, 60, 126, 127, 128, 129, 200];

    for (const [ch, label] of chars) {
        it(`${label}: exact-size buffer, untouched surroundings, same bytes as pack()`, () => {
            const encoded = new TextEncoder().encode(ch).length;
            for (const max of maxes) {
                const codec = str(max);
                for (const count of counts) {
                    if (count * encoded > max) continue;
                    const s = ch.repeat(count);
                    const want = codec.pack(s);
                    const buf = new Uint8Array(want.length + 12).fill(0x5a);
                    const n = codec.packInto(buf.subarray(4, 4 + want.length), s);
                    expect(n).toBe(want.length);
                    expect(hex(buf.subarray(4, 4 + n))).toBe(hex(want));
                    expect(buf.subarray(0, 4).every((b) => b === 0x5a)).toBe(true);
                    expect(buf.subarray(4 + n).every((b) => b === 0x5a)).toBe(true);
                }
            }
        });
    }

    it('the reviewer repro: str(16384) then a u8', () => {
        const c = define({ s: str(16384), t: u8 });
        const buf = new Uint8Array(16).fill(0x11);
        const n = c.packInto(buf, { s: 'Hi', t: 7 });
        expect(n).toBe(4);
        expect(hex(buf.subarray(0, 8))).toBe('0248690711111111');
    });

    it('str(128) fits exactly in 2 bytes for "A" (it used to throw overflow)', () => {
        expect(str(128).packInto(new Uint8Array(2), 'A')).toBe(2);
    });

    it('the prefix that grows for non-ASCII text is right (60 snowmen are 60 units but 180 bytes)', () => {
        const c = str(500);
        const s = '☃'.repeat(60);
        const out = c.pack(s);
        expect(hex(out.subarray(0, 2))).toBe('b401'); // 180 as varuint
        expect(c.unpack(out)).toBe(s);
    });

    it('a non-ASCII string over the max is `range`, and over the buffer is `overflow`', () => {
        expect(packErrorCode(() => str(5).pack('☃☃'))).toBe('range');
        expect(packErrorCode(() => str(100).packInto(new Uint8Array(4), '☃☃'))).toBe('overflow');
    });
});

describe('quant: a span that overflows to Infinity is refused when the schema is built', () => {
    it('quant(-MAX_VALUE, MAX_VALUE) throws instead of encoding every value as 0 and decoding NaN', () => {
        expect(() => quant(-Number.MAX_VALUE, Number.MAX_VALUE, 8)).toThrow(TypeError);
        expect(() => quant(0, Number.MAX_VALUE, 8)).not.toThrow();
    });
});

describe('buffers that change under the same Uint8Array object', () => {
    it('a resizable buffer that grows can be written and read at the new offsets', () => {
        const ab = new ArrayBuffer(8, { maxByteLength: 64 });
        const u = new Uint8Array(ab);
        u32.packInto(u, 1);
        u32.unpack(u, 0, 4);
        ab.resize(32);
        expect(u32.packInto(u, 0xdeadbeef, 16)).toBe(4);
        expect(u32.unpack(u, 16, 20)).toBe(0xdeadbeef);
    });

    it('a resizable buffer that shrinks is a usage error or a clean overflow, never a raw TypeError', () => {
        const ab = new ArrayBuffer(16, { maxByteLength: 64 });
        const u = new Uint8Array(ab);
        u8.packInto(u, 1);
        ab.resize(4);
        expect(u8.packInto(u, 2)).toBe(1);
        expect(u8.unpack(u, 0, 1)).toBe(2);
        expect(packErrorCode(() => u32.packInto(u, 1, 2))).toBe('overflow');
        expect(packErrorCode(() => u8.unpack(u, 0, 9))).toBe('usage');
    });

    it('a transferred (detached) buffer is a PackError, and the codecs keep working afterwards', () => {
        const ab = new ArrayBuffer(8);
        const u = new Uint8Array(ab);
        u8.packInto(u, 1);
        u8.unpack(u, 0, 1);
        ab.transfer();
        expect(packErrorCode(() => u8.packInto(u, 2))).not.toBe('none');
        expect(packErrorCode(() => u8.unpack(u))).not.toBe('none');
        expect(hex(u16.pack(0x0102))).toBe('0201');
        expect(u8.unpack(Uint8Array.of(9))).toBe(9);
    });

    it('a detached zero-length array is still caught', () => {
        const ab = new ArrayBuffer(8);
        const empty = new Uint8Array(ab, 0, 0);
        define({}).packInto(empty, {});
        ab.transfer();
        expect(packErrorCode(() => define({}).packInto(empty, {}))).not.toBe('none');
    });

    it('a growable SharedArrayBuffer is handled like a resizable ArrayBuffer', () => {
        const sab = new SharedArrayBuffer(8, { maxByteLength: 32 });
        const u = new Uint8Array(sab);
        u32.packInto(u, 1);
        sab.grow(24);
        expect(u32.packInto(u, 7, 16)).toBe(4);
        expect(u32.unpack(u, 16, 20)).toBe(7);
    });
});

describe('a value too big to allocate a buffer for', () => {
    it('is a PackError, not a raw RangeError from the allocator', () => {
        // Simulate an allocator that refuses more than 4 MiB, instead of really exhausting memory.
        const Real = globalThis.Uint8Array;
        const Limited = new Proxy(Real, {
            construct(target, args, newTarget) {
                if (typeof args[0] === 'number' && args[0] > 2 ** 22) throw new RangeError('Array buffer allocation failed');
                return Reflect.construct(target, args, newTarget);
            },
        });
        const c = define({ big: str(2 ** 30) });
        const value = { big: 'x'.repeat(5_000_000) };
        globalThis.Uint8Array = Limited;
        try {
            expect(packErrorCode(() => c.pack(value))).toBe('range');
        } finally {
            globalThis.Uint8Array = Real;
        }
        // and the codec still works once memory is available again
        expect(c.unpack(c.pack(value)).big.length).toBe(5_000_000);
    });
});

describe('records', () => {
    it('an array is not accepted as a record', () => {
        expect(packErrorCode(() => define({ length: u8 }).pack([1, 2, 3, 4] as never))).toBe('type');
    });

    it('optional fields can be left out, and null counts as absent at runtime', () => {
        const c = define({ id: u8, tag: optional(str(8)) });
        expect(c.unpack(c.pack({ id: 1 }))).toEqual({ id: 1, tag: undefined });
        expect(c.unpack(c.pack({ id: 1, tag: null } as never))).toEqual({ id: 1, tag: undefined });
        expect(c.unpack(c.pack({ id: 1, tag: 'x' }))).toEqual({ id: 1, tag: 'x' });
    });

    it('optional elements of an array: holes and null are absent', () => {
        const c = array(optional(u8), 4);
        expect(c.unpack(c.pack([undefined, 2, null as never, 4]))).toEqual([undefined, 2, undefined, 4]);
    });
});

describe('TypeScript types', () => {
    const Rec = define({
        id: u8,
        name: str(8),
        tag: optional(str(4)),
        kind: enumOf(['a', 'b']),
        big: i64,
        list: array(define({ x: u16, note: optional(u8) }), 3),
    });

    it('infers required, optional and nested fields', () => {
        type R = Infer<typeof Rec>;
        expectTypeOf<R['id']>().toEqualTypeOf<number>();
        expectTypeOf<R['name']>().toEqualTypeOf<string>();
        expectTypeOf<R['tag']>().toEqualTypeOf<string | undefined>();
        expectTypeOf<R['kind']>().toEqualTypeOf<'a' | 'b'>();
        expectTypeOf<R['big']>().toEqualTypeOf<bigint>();
        expectTypeOf<R['list']>().toEqualTypeOf<{ x: number; note?: number | undefined }[]>();
        // an optional field may be omitted, a required one may not
        expectTypeOf<{ id: number; name: string; kind: 'a'; big: bigint; list: [] }>().toExtend<R>();
        expectTypeOf<{ name: string; kind: 'a'; big: bigint; list: [] }>().not.toExtend<R>();
    });

    it('rejects wrong values at compile time', () => {
        // Never called: only the compiler checks these lines (each @ts-expect-error fails the typecheck if the
        // line below it stops being an error). Calling them would just throw at runtime.
        const compileTimeOnly = (): void => {
            // @ts-expect-error a number is not a bigint
            i64.pack(1);
            // @ts-expect-error 'c' is not one of the names
            enumOf(['a', 'b']).pack('c');
            // @ts-expect-error a string is not a number
            u8.pack('1');
            // @ts-expect-error unknown field
            define({ a: u8 }).pack({ a: 1, b: 2 });
        };
        expect(typeof compileTimeOnly).toBe('function');
        const asCodec: Codec<{ a: number }> = define({ a: u8 });
        expect(asCodec.max).toBe(1);
    });
});
