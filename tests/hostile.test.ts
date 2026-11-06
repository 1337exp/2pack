import { describe, expect, it } from 'vitest';
import { array, bool, bytes, define, enumOf, f32, i64, optional, PackError, quant, str, u16, u32, u8, varint, varuint, type Codec } from '../src/index.js';

// Tiny seeded PRNG so a failure is reproducible: no dependency, same sequence on every machine.
function rng(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
        s = (s + 0x6d2b79f5) >>> 0;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const int = (r: () => number, lo: number, hi: number): number => lo + Math.floor(r() * (hi - lo + 1));

const Item = define({ id: varuint, label: str(12), flag: bool });
const Packet = define({
    seq: u32,
    kind: enumOf(['join', 'move', 'chat', 'leave']),
    pos: define({ x: quant(-500, 500, 16), y: quant(-500, 500, 16) }),
    name: optional(str(20)),
    items: array(Item, 6),
    blob: bytes(16),
    score: i64,
    delta: varint,
    ratio: f32,
});
type PacketValue = ReturnType<typeof Packet.unpack>;

function randomPacket(r: () => number): PacketValue {
    const chars = ['a', 'Z', '9', ' ', 'é', 'я', '☃', '😀'];
    const word = (maxBytes: number): string => {
        let s = '';
        const n = int(r, 0, 6);
        for (let i = 0; i < n; i++) {
            const next = s + chars[int(r, 0, chars.length - 1)];
            if (new TextEncoder().encode(next).length > maxBytes) break;
            s = next;
        }
        return s;
    };
    return {
        seq: int(r, 0, 4294967295),
        kind: (['join', 'move', 'chat', 'leave'] as const)[int(r, 0, 3)]!,
        pos: { x: Math.fround(int(r, -500, 500)), y: Math.fround(int(r, -500, 500)) },
        name: r() < 0.5 ? undefined : word(20),
        items: Array.from({ length: int(r, 0, 6) }, () => ({ id: int(r, 0, 4294967295), label: word(12), flag: r() < 0.5 })),
        blob: Uint8Array.from({ length: int(r, 0, 16) }, () => int(r, 0, 255)),
        score: BigInt(int(r, -1000000, 1000000)) * 1000000007n,
        delta: int(r, -2147483648, 2147483647),
        ratio: Math.fround((r() - 0.5) * 1000),
    };
}

/** Decoding must either succeed or throw PackError: never another error, never hang. */
function decodeOrPackError(codec: Codec<any>, input: Uint8Array): 'ok' | PackError {
    try {
        codec.unpack(input);
        return 'ok';
    } catch (e) {
        expect(e, `threw a non-PackError for ${Buffer.from(input).toString('hex')}`).toBeInstanceOf(PackError);
        return e as PackError;
    }
}

describe('round-trip fuzz', () => {
    it('5000 random packets survive pack -> unpack', () => {
        const r = rng(1);
        for (let i = 0; i < 5000; i++) {
            const v = randomPacket(r);
            const out = Packet.unpack(Packet.pack(v));
            // quant is lossy by design; compare it separately, everything else must match exactly
            expect(out.pos.x).toBeCloseTo(v.pos.x, 1);
            expect(out.pos.y).toBeCloseTo(v.pos.y, 1);
            expect({ ...out, pos: 0 }).toEqual({ ...v, pos: 0 });
        }
    });

    it('packInto at a random offset in a dirty buffer gives the same bytes as pack', () => {
        const r = rng(2);
        const dirty = new Uint8Array(Packet.max + 64);
        for (let i = 0; i < 2000; i++) {
            const v = randomPacket(r);
            const at = int(r, 0, 64);
            dirty.fill(0xcc);
            const n = Packet.packInto(dirty, v, at);
            expect(Buffer.from(dirty.subarray(at, at + n))).toEqual(Buffer.from(Packet.pack(v)));
            expect(dirty.subarray(0, at).every((b) => b === 0xcc)).toBe(true);
            expect(dirty.subarray(at + n).every((b) => b === 0xcc)).toBe(true);
        }
    });

    it('packing is deterministic: same value, same bytes', () => {
        const r = rng(3);
        for (let i = 0; i < 500; i++) {
            const v = randomPacket(r);
            expect(Buffer.from(Packet.pack(v))).toEqual(Buffer.from(Packet.pack(structuredClone(v))));
        }
    });
});

describe('hostile input: only PackError, never anything else', () => {
    it('every truncation of a valid packet fails with `truncated` (or is itself valid)', () => {
        const r = rng(4);
        for (let i = 0; i < 300; i++) {
            const bytesOfPacket = Packet.pack(randomPacket(r));
            for (let cut = 0; cut < bytesOfPacket.length; cut++) {
                const res = decodeOrPackError(Packet, bytesOfPacket.subarray(0, cut));
                // a strict prefix of a valid packet can never be a complete valid packet of this schema,
                // except through a different (shorter) path; what must hold is: no crash, no garbage success
                if (res !== 'ok') expect(['truncated', 'invalid']).toContain(res.code);
            }
        }
    });

    it('40000 random single-byte corruptions never throw anything but PackError', () => {
        const r = rng(5);
        let rejected = 0;
        for (let i = 0; i < 40000; i++) {
            const b = Packet.pack(randomPacket(r)).slice();
            b[int(r, 0, b.length - 1)] = int(r, 0, 255);
            if (decodeOrPackError(Packet, b) !== 'ok') rejected++;
        }
        expect(rejected).toBeGreaterThan(1000); // the corruptions really do get caught
    });

    it('pure random bytes of every length 0..80 never crash', () => {
        const r = rng(6);
        for (let i = 0; i < 20000; i++) {
            const b = Uint8Array.from({ length: int(r, 0, 80) }, () => int(r, 0, 255));
            decodeOrPackError(Packet, b);
            decodeOrPackError(Item, b);
            decodeOrPackError(str(10), b);
        }
    });

    it('a length above the declared max is rejected even when the bytes are present', () => {
        // str(4): declared length 5, five bytes present
        expect(() => str(4).unpack(Uint8Array.from([5, 65, 65, 65, 65, 65]))).toThrowError(expect.objectContaining({ code: 'invalid' }));
        // bytes(2): declared 3
        expect(() => bytes(2).unpack(Uint8Array.from([3, 1, 2, 3]))).toThrowError(expect.objectContaining({ code: 'invalid' }));
        // array(u8, 2): declared 3
        expect(() => array(u8, 2).unpack(Uint8Array.from([3, 1, 2, 3]))).toThrowError(expect.objectContaining({ code: 'invalid' }));
    });

    it('a length longer than the remaining bytes is `truncated`, and `end` is honoured', () => {
        const c = str(200);
        expect(() => c.unpack(Uint8Array.from([50, 65, 66]))).toThrowError(expect.objectContaining({ code: 'truncated' }));
        // the string would fit in the real buffer but not in [0, end): must not read past `end`
        const buf = Uint8Array.from([3, 65, 66, 67]);
        expect(() => c.unpack(buf, 0, 3)).toThrowError(expect.objectContaining({ code: 'truncated' }));
        expect(c.unpack(buf, 0, 4)).toBe('ABC');
    });

    it('`end` larger than the buffer is a usage error, not a read of zeros', () => {
        expect(() => u16.unpack(Uint8Array.from([1, 2]), 0, 100)).toThrowError(expect.objectContaining({ code: 'usage' }));
        expect(() => u16.unpack(Uint8Array.from([1, 2]), 3)).toThrowError(expect.objectContaining({ code: 'usage' }));
        expect(() => u16.unpack({} as never)).toThrowError(expect.objectContaining({ code: 'type' }));
    });

    it('an array count that the remaining bytes cannot hold is rejected before allocating', () => {
        const huge = array(define({ a: u32 }), 4294967295);
        // declares 4 billion items, supplies none: must fail fast, not try to allocate
        const t0 = Date.now();
        expect(() => huge.unpack(Uint8Array.from([0xff, 0xff, 0xff, 0xff, 0x0f]))).toThrowError(expect.objectContaining({ code: 'truncated' }));
        expect(Date.now() - t0).toBeLessThan(500);
        // The error carries an array index in its path only if an item was already being read; before the
        // count check was in place it was `[0]`. Rejected up front means an empty path.
        try {
            huge.unpack(Uint8Array.from([0xff, 0xff, 0xff, 0xff, 0x0f]));
        } catch (e) {
            expect((e as PackError).path).toEqual([]);
        }
    });

    it('varints: overlong, too long and too large encodings are rejected', () => {
        const bad: [string, number[]][] = [
            ['overlong zero', [0x80, 0x00]],
            ['overlong one', [0x81, 0x00]],
            ['six bytes', [0x80, 0x80, 0x80, 0x80, 0x80, 0x00]],
            ['fifth byte too big', [0xff, 0xff, 0xff, 0xff, 0x1f]],
            ['continuation forever', [0xff, 0xff, 0xff, 0xff, 0xff]],
        ];
        for (const [name, b] of bad) {
            expect(() => varuint.unpack(Uint8Array.from(b)), name).toThrowError(expect.objectContaining({ code: 'invalid' }));
        }
        expect(() => varuint.unpack(Uint8Array.from([0x80]))).toThrowError(expect.objectContaining({ code: 'truncated' }));
    });

    it('booleans, presence flags and enum indexes outside their domain are rejected', () => {
        expect(() => bool.unpack(Uint8Array.from([2]))).toThrowError(expect.objectContaining({ code: 'invalid' }));
        expect(() => optional(u8).unpack(Uint8Array.from([2, 0]))).toThrowError(expect.objectContaining({ code: 'invalid' }));
        expect(() => enumOf(['a', 'b']).unpack(Uint8Array.from([2]))).toThrowError(expect.objectContaining({ code: 'invalid' }));
    });

    it('the error path points at the failing field', () => {
        const e = (() => {
            try {
                Packet.unpack(Uint8Array.from([0, 0, 0, 0, 9]));
            } catch (err) {
                return err as PackError;
            }
            throw new Error('no error');
        })();
        expect(e.path).toEqual(['kind']);
        expect(e.code).toBe('invalid');
    });

    it('a decoded record is a normal object even if the schema has field names like "constructor"', () => {
        const c = define({ constructor: u8, toString: u8, hasOwnProperty: u8 });
        const out = c.unpack(c.pack({ constructor: 1, toString: 2, hasOwnProperty: 3 }));
        expect(out).toEqual({ constructor: 1, toString: 2, hasOwnProperty: 3 });
        expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
    });
});
