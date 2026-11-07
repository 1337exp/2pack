import { make, type Codec, type Impl, type Reader, type Value, type Writer } from './codec.js';
import { fail, PackError } from './errors.js';

// Every codec below follows docs/spec.md. Writers validate and throw PackError; readers check every length
// against both the declared maximum and the bytes that remain before they touch or allocate anything.
// Все кодеки ниже следуют docs/spec.md. Запись проверяет значения и бросает PackError; чтение сверяет каждую
// длину и с объявленным максимумом, и с оставшимися байтами, прежде чем читать или выделять память.

const encoder = new TextEncoder();
// ignoreBOM: keep a leading U+FEFF so every string round-trips. Malformed UTF-8 becomes U+FFFD.
const decoder = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true });

// --- helpers --------------------------------------------------------------------------------------------------

function truncated(): never {
    return fail('truncated', 'input ended before the value did');
}

function badNumber(v: unknown, what: string): never {
    if (typeof v !== 'number') return fail('type', `expected a number for ${what}, got ${describe(v)}`);
    return fail('range', `${String(v)} is not a valid ${what}`);
}

function describe(v: unknown): string {
    if (v === null) return 'null';
    if (v === undefined) return 'undefined';
    return typeof v === 'object' ? (Array.isArray(v) ? 'array' : 'object') : typeof v;
}

function varLen(n: number): number {
    return n < 0x80 ? 1 : n < 0x4000 ? 2 : n < 0x200000 ? 3 : n < 0x10000000 ? 4 : 5;
}

/** Unsigned LEB128 of a value already known to be an integer in 0..2^32-1. */
function writeVar(w: Writer, value: number): void {
    const dv = w.dv;
    let p = w.pos;
    let v = value;
    while (v > 0x7f) {
        dv.setUint8(p++, (v & 0x7f) | 0x80);
        v >>>= 7;
    }
    dv.setUint8(p++, v);
    w.pos = p;
}

function readVar(r: Reader): number {
    const dv = r.dv;
    const end = r.end;
    let p = r.pos;
    let result = 0;
    for (let i = 0; i < 5; i++) {
        if (p >= end) truncated();
        const b = dv.getUint8(p++);
        if (i === 4 && b > 0x0f) fail('invalid', 'varint does not fit in 32 bits');
        result |= (b & 0x7f) << (7 * i);
        if ((b & 0x80) === 0) {
            if (i > 0 && b === 0) fail('invalid', 'overlong varint');
            r.pos = p;
            return result >>> 0;
        }
    }
    return fail('invalid', 'varint is longer than 5 bytes');
}

function checkLimit(max: number, what: string): void {
    if (!Number.isInteger(max) || max < 0 || max > 0xffffffff) {
        throw new TypeError(`${what}: max must be an integer from 0 to 4294967295, got ${String(max)}`);
    }
}

// --- fixed-size scalars ---------------------------------------------------------------------------------------

/** `true` / `false`, 1 byte. */
export const bool: Codec<boolean> = make<boolean>(
    1,
    1,
    (w, v) => {
        if (typeof v !== 'boolean') fail('type', `expected a boolean, got ${describe(v)}`);
        w.dv.setUint8(w.pos, v ? 1 : 0);
        w.pos += 1;
    },
    (r) => {
        if (r.pos + 1 > r.end) truncated();
        const b = r.dv.getUint8(r.pos);
        if (b > 1) fail('invalid', `a boolean must be 0 or 1, got ${b}`);
        r.pos += 1;
        return b === 1;
    },
);

/** Unsigned 8-bit integer. / Беззнаковое 8 бит. */
export const u8: Codec<number> = make<number>(
    1,
    1,
    (w, v) => {
        if (typeof v !== 'number' || (v & 0xff) !== v) badNumber(v, 'u8');
        w.dv.setUint8(w.pos, v);
        w.pos += 1;
    },
    (r) => {
        if (r.pos + 1 > r.end) truncated();
        const v = r.dv.getUint8(r.pos);
        r.pos += 1;
        return v;
    },
);

/** Signed 8-bit integer. / Знаковое 8 бит. */
export const i8: Codec<number> = make<number>(
    1,
    1,
    (w, v) => {
        if (typeof v !== 'number' || ((v << 24) >> 24) !== v) badNumber(v, 'i8');
        w.dv.setInt8(w.pos, v);
        w.pos += 1;
    },
    (r) => {
        if (r.pos + 1 > r.end) truncated();
        const v = r.dv.getInt8(r.pos);
        r.pos += 1;
        return v;
    },
);

/** Unsigned 16-bit integer, little-endian. / Беззнаковое 16 бит. */
export const u16: Codec<number> = make<number>(
    2,
    2,
    (w, v) => {
        if (typeof v !== 'number' || (v & 0xffff) !== v) badNumber(v, 'u16');
        w.dv.setUint16(w.pos, v, true);
        w.pos += 2;
    },
    (r) => {
        if (r.pos + 2 > r.end) truncated();
        const v = r.dv.getUint16(r.pos, true);
        r.pos += 2;
        return v;
    },
);

/** Signed 16-bit integer, little-endian. / Знаковое 16 бит. */
export const i16: Codec<number> = make<number>(
    2,
    2,
    (w, v) => {
        if (typeof v !== 'number' || ((v << 16) >> 16) !== v) badNumber(v, 'i16');
        w.dv.setInt16(w.pos, v, true);
        w.pos += 2;
    },
    (r) => {
        if (r.pos + 2 > r.end) truncated();
        const v = r.dv.getInt16(r.pos, true);
        r.pos += 2;
        return v;
    },
);

/** Unsigned 32-bit integer, little-endian. / Беззнаковое 32 бита. */
export const u32: Codec<number> = make<number>(
    4,
    4,
    (w, v) => {
        if (typeof v !== 'number' || v >>> 0 !== v) badNumber(v, 'u32');
        w.dv.setUint32(w.pos, v, true);
        w.pos += 4;
    },
    (r) => {
        if (r.pos + 4 > r.end) truncated();
        const v = r.dv.getUint32(r.pos, true);
        r.pos += 4;
        return v;
    },
);

/** Signed 32-bit integer, little-endian. / Знаковое 32 бита. */
export const i32: Codec<number> = make<number>(
    4,
    4,
    (w, v) => {
        if (typeof v !== 'number' || (v | 0) !== v) badNumber(v, 'i32');
        w.dv.setInt32(w.pos, v, true);
        w.pos += 4;
    },
    (r) => {
        if (r.pos + 4 > r.end) truncated();
        const v = r.dv.getInt32(r.pos, true);
        r.pos += 4;
        return v;
    },
);

const U64_MAX = 0xffffffffffffffffn;
const I64_MIN = -0x8000000000000000n;
const I64_MAX = 0x7fffffffffffffffn;

function wantBigInt(v: unknown, what: string): bigint {
    if (typeof v === 'bigint') return v;
    return fail('type', `expected a bigint for ${what} (write 5n, not 5), got ${describe(v)}`);
}

/** Unsigned 64-bit integer, always a `bigint`. / Беззнаковое 64 бита, всегда `bigint`. */
export const u64: Codec<bigint> = make<bigint>(
    8,
    8,
    (w, v) => {
        const b = wantBigInt(v, 'u64');
        if (b < 0n || b > U64_MAX) fail('range', `${b} is not a valid u64`);
        w.dv.setBigUint64(w.pos, b, true);
        w.pos += 8;
    },
    (r) => {
        if (r.pos + 8 > r.end) truncated();
        const v = r.dv.getBigUint64(r.pos, true);
        r.pos += 8;
        return v;
    },
);

/** Signed 64-bit integer, always a `bigint`. / Знаковое 64 бита, всегда `bigint`. */
export const i64: Codec<bigint> = make<bigint>(
    8,
    8,
    (w, v) => {
        const b = wantBigInt(v, 'i64');
        if (b < I64_MIN || b > I64_MAX) fail('range', `${b} is not a valid i64`);
        w.dv.setBigInt64(w.pos, b, true);
        w.pos += 8;
    },
    (r) => {
        if (r.pos + 8 > r.end) truncated();
        const v = r.dv.getBigInt64(r.pos, true);
        r.pos += 8;
        return v;
    },
);

/** IEEE 754 single precision. `NaN` and `±Infinity` survive. / Одинарная точность. */
export const f32: Codec<number> = make<number>(
    4,
    4,
    (w, v) => {
        if (typeof v !== 'number') fail('type', `expected a number for f32, got ${describe(v)}`);
        w.dv.setFloat32(w.pos, v, true);
        w.pos += 4;
    },
    (r) => {
        if (r.pos + 4 > r.end) truncated();
        const v = r.dv.getFloat32(r.pos, true);
        r.pos += 4;
        return v;
    },
);

/** IEEE 754 double precision. `NaN` and `±Infinity` survive. / Двойная точность. */
export const f64: Codec<number> = make<number>(
    8,
    8,
    (w, v) => {
        if (typeof v !== 'number') fail('type', `expected a number for f64, got ${describe(v)}`);
        w.dv.setFloat64(w.pos, v, true);
        w.pos += 8;
    },
    (r) => {
        if (r.pos + 8 > r.end) truncated();
        const v = r.dv.getFloat64(r.pos, true);
        r.pos += 8;
        return v;
    },
);

// --- variable-size integers -----------------------------------------------------------------------------------

/** Unsigned LEB128, `0 … 2^32-1`, 1 to 5 bytes: small numbers cost one byte. / Малые числа занимают 1 байт. */
export const varuint: Codec<number> = make<number>(
    1,
    5,
    (w, v) => {
        if (typeof v !== 'number' || v >>> 0 !== v) badNumber(v, 'varuint');
        writeVar(w, v);
    },
    readVar,
);

/** Zigzag + LEB128, `-2^31 … 2^31-1`: small magnitudes cost one byte whatever the sign. */
export const varint: Codec<number> = make<number>(
    1,
    5,
    (w, v) => {
        if (typeof v !== 'number' || (v | 0) !== v) badNumber(v, 'varint');
        writeVar(w, ((v << 1) ^ (v >> 31)) >>> 0);
    },
    (r) => {
        const z = readVar(r);
        return (z >>> 1) ^ -(z & 1);
    },
);

// --- strings and bytes ----------------------------------------------------------------------------------------

function decodeUtf8(u8: Uint8Array, start: number, n: number): string {
    if (n === 0) return '';
    if (n <= 24) {
        // Short ASCII strings (names, ids) are the common case: skip TextDecoder.
        let s = '';
        let i = 0;
        for (; i < n; i++) {
            const c = u8[start + i]!;
            if (c > 127) break;
            s += String.fromCharCode(c);
        }
        if (i === n) return s;
    }
    return decoder.decode(u8.subarray(start, start + n));
}

/**
 * UTF-8 string of at most `maxBytes` **bytes** (not characters). A longer string is an error, never truncated.
 * Строка UTF-8 не длиннее `maxBytes` **байт** (не символов). Длиннее: ошибка, без обрезки.
 */
export function str(maxBytes: number): Codec<string> {
    checkLimit(maxBytes, 'str');
    return make<string>(
        1,
        varLen(maxBytes) + maxBytes,
        (w, v) => {
            if (typeof v !== 'string') fail('type', `expected a string, got ${describe(v)}`);
            const len = v.length;
            // A UTF-8 string is never shorter in bytes than in UTF-16 units, so this rejects early and cheaply.
            if (len > maxBytes) fail('range', `string is longer than ${maxBytes} bytes`);
            const u8 = w.u8;
            // Stage the body exactly where it ends up if the string is pure ASCII (one byte per unit, so the
            // length prefix is varLen(len)). Nothing is ever written outside the final packet.
            const asciiPrefix = varLen(len);
            const body = w.pos + asciiPrefix;
            if (body + len > u8.length) fail('overflow', 'buffer too small for this string');

            let i = 0;
            for (; i < len; i++) {
                const c = v.charCodeAt(i);
                if (c > 127) break;
                u8[body + i] = c;
            }
            if (i === len) {
                writeVar(w, len);
                w.pos += len;
                return;
            }

            // Non-ASCII: the byte length n is only known after encoding, and n >= len, so the prefix can only
            // grow. If it does, move the body right, still inside the final packet.
            const room = Math.min(maxBytes, u8.length - body);
            const res = encoder.encodeInto(v, u8.subarray(body, body + room));
            if (res.read < len) {
                // Rare error path: find out which limit was hit.
                if (encoder.encode(v).length > maxBytes) fail('range', `string is longer than ${maxBytes} bytes`);
                fail('overflow', 'buffer too small for this string');
            }
            const n = res.written;
            const actual = varLen(n);
            if (actual !== asciiPrefix) {
                if (w.pos + actual + n > u8.length) fail('overflow', 'buffer too small for this string');
                u8.copyWithin(w.pos + actual, body, body + n);
            }
            writeVar(w, n);
            w.pos += n;
        },
        (r) => {
            const n = readVar(r);
            if (n > maxBytes) fail('invalid', `string length ${n} is above the maximum ${maxBytes}`);
            if (n > r.end - r.pos) truncated();
            const s = decodeUtf8(r.u8, r.pos, n);
            r.pos += n;
            return s;
        },
    );
}

export interface BytesOptions {
    /**
     * Return a view into the input instead of a copy. Zero-copy, but the result is only valid while the input
     * buffer is not reused: network libraries often reuse theirs.
     * Вернуть окно во входной буфер вместо копии. Без копирования, но результат живёт, пока вход не
     * переиспользован (сетевые библиотеки часто переиспользуют свои буферы).
     */
    view?: boolean;
}

/**
 * Raw bytes, at most `maxBytes`. Decoded as a copy by default.
 * Сырые байты, не больше `maxBytes`. По умолчанию при чтении копируются.
 */
export function bytes(maxBytes: number, options: BytesOptions = {}): Codec<Uint8Array> {
    checkLimit(maxBytes, 'bytes');
    const view = options.view === true;
    return make<Uint8Array>(
        1,
        varLen(maxBytes) + maxBytes,
        (w, v) => {
            if (!(v instanceof Uint8Array)) fail('type', `expected a Uint8Array, got ${describe(v)}`);
            const n = v.length;
            if (n > maxBytes) fail('range', `${n} bytes is above the maximum ${maxBytes}`);
            if (w.pos + varLen(n) + n > w.u8.length) fail('overflow', 'buffer too small for these bytes');
            writeVar(w, n);
            w.u8.set(v, w.pos);
            w.pos += n;
        },
        (r) => {
            const n = readVar(r);
            if (n > maxBytes) fail('invalid', `length ${n} is above the maximum ${maxBytes}`);
            if (n > r.end - r.pos) truncated();
            const out = view ? r.u8.subarray(r.pos, r.pos + n) : r.u8.slice(r.pos, r.pos + n);
            r.pos += n;
            return out;
        },
    );
}

// --- composites -----------------------------------------------------------------------------------------------

function impl<T>(c: Codec<T>): Impl<T> {
    const i = c as Impl<T>;
    if (typeof i.write !== 'function' || typeof i.read !== 'function') {
        throw new TypeError('expected a 2pack codec (u8, str(32), define({...}), …)');
    }
    return i;
}

/** An extensible record owns the rest of its range, so something placed after it could never be found. */
function nestable<T>(c: Codec<T>, where: string): Impl<T> {
    const i = impl(c);
    if (i.open) {
        throw new TypeError(`${where}: a record with added(...) fields can only be the top-level codec, it cannot be nested`);
    }
    return i;
}

/**
 * A list of `item`s, at most `maxCount` of them.
 * Список из `item`, не больше `maxCount` штук.
 */
export function array<T>(item: Codec<T>, maxCount: number): Codec<T[]> {
    checkLimit(maxCount, 'array');
    const it = nestable(item, 'array');
    if (it.max === 0) throw new TypeError('array: the item type is empty (zero bytes), an array of it is meaningless');
    return make<T[]>(
        1,
        varLen(maxCount) + maxCount * it.max,
        (w, v) => {
            if (!Array.isArray(v)) fail('type', `expected an array, got ${describe(v)}`);
            const n = v.length;
            if (n > maxCount) fail('range', `array has ${n} items, the maximum is ${maxCount}`);
            writeVar(w, n);
            let i = 0;
            try {
                for (; i < n; i++) it.write(w, v[i] as T);
            } catch (e) {
                if (e instanceof PackError) e.addPath(i);
                throw e;
            }
        },
        (r) => {
            const n = readVar(r);
            if (n > maxCount) fail('invalid', `array count ${n} is above the maximum ${maxCount}`);
            // Reject a count the remaining bytes cannot possibly hold *before* allocating anything for it.
            if (n * it.min > r.end - r.pos) truncated();
            const out = new Array<T>(n);
            let i = 0;
            try {
                for (; i < n; i++) out[i] = it.read(r);
            } catch (e) {
                if (e instanceof PackError) e.addPath(i);
                throw e;
            }
            return out;
        },
    );
}

/**
 * A value that may be absent: `undefined` (typed) or `null` (accepted at runtime, so JSON-shaped data works) when
 * packing, `undefined` when unpacking. In `define`, the field may be left out. Costs 1 byte.
 * Значение, которого может не быть: при упаковке `undefined` (по типам) или `null` (принимается в рантайме, чтобы
 * данные из JSON не ломались), при чтении `undefined`. В `define` поле можно не указывать. Стоит 1 байт.
 */
export function optional<T>(item: Codec<T>): Codec<T | undefined> {
    const it = nestable(item, 'optional');
    return make<T | undefined>(
        1,
        1 + it.max,
        (w, v) => {
            if (v === undefined || v === null) {
                w.dv.setUint8(w.pos, 0);
                w.pos += 1;
                return;
            }
            w.dv.setUint8(w.pos, 1);
            w.pos += 1;
            it.write(w, v);
        },
        (r) => {
            if (r.pos + 1 > r.end) truncated();
            const flag = r.dv.getUint8(r.pos);
            if (flag > 1) fail('invalid', `a presence flag must be 0 or 1, got ${flag}`);
            r.pos += 1;
            return flag === 1 ? it.read(r) : undefined;
        },
    );
}

/**
 * One of a fixed list of names, stored as its index (1 byte for up to 256 names, else 2).
 * Одно из имён фиксированного списка; хранится индексом (1 байт до 256 имён, иначе 2).
 */
export function enumOf<const N extends readonly string[]>(names: N): Codec<N[number]> {
    if (!Array.isArray(names) || names.length === 0 || names.length > 65536) {
        throw new TypeError('enumOf: expected 1 to 65536 names');
    }
    const index = new Map<string, number>();
    names.forEach((name, i) => {
        if (typeof name !== 'string') throw new TypeError('enumOf: names must be strings');
        if (index.has(name)) throw new TypeError(`enumOf: duplicate name "${name}"`);
        index.set(name, i);
    });
    const wide = names.length > 256;
    const size = wide ? 2 : 1;
    return make<N[number]>(
        size,
        size,
        (w, v) => {
            if (typeof v !== 'string') fail('type', `expected one of the enum names, got ${describe(v)}`);
            const i = index.get(v);
            if (i === undefined) fail('range', `"${v}" is not one of the enum names`);
            if (wide) w.dv.setUint16(w.pos, i, true);
            else w.dv.setUint8(w.pos, i);
            w.pos += size;
        },
        (r) => {
            if (r.pos + size > r.end) truncated();
            const i = wide ? r.dv.getUint16(r.pos, true) : r.dv.getUint8(r.pos);
            if (i >= names.length) fail('invalid', `enum index ${i} is out of range (${names.length} names)`);
            r.pos += size;
            return names[i] as N[number];
        },
    );
}

export interface QuantOptions {
    /** Clamp out-of-range values into `[min, max]` instead of throwing. `NaN` always throws. */
    clamp?: boolean;
}

/**
 * A number in `[min, max]` stored as an unsigned `bits`-bit integer (8, 16 or 32): the error is at most half a
 * step, `(max - min) / (2^bits - 1) / 2`. Positions, angles, ratios.
 * Число из `[min, max]`, хранится беззнаковым целым в `bits` бит (8, 16 или 32): ошибка не больше полушага.
 * Координаты, углы, доли.
 */
export function quant(min: number, max: number, bits: 8 | 16 | 32, options: QuantOptions = {}): Codec<number> {
    if (!Number.isFinite(min) || !Number.isFinite(max) || !(min < max) || !Number.isFinite(max - min)) {
        // The last test catches (-MAX_VALUE, MAX_VALUE): both finite, but the span overflows to Infinity.
        throw new TypeError('quant: min and max must be finite numbers with min < max and a finite span');
    }
    if (bits !== 8 && bits !== 16 && bits !== 32) throw new TypeError('quant: bits must be 8, 16 or 32');
    const size = bits / 8;
    const levels = 2 ** bits - 1;
    const span = max - min;
    const clamp = options.clamp === true;
    return make<number>(
        size,
        size,
        (w, v) => {
            if (typeof v !== 'number' || Number.isNaN(v)) badNumber(v, 'quantized number');
            let x = v;
            if (x < min || x > max) {
                if (!clamp) fail('range', `${String(v)} is outside [${min}, ${max}]`);
                x = x < min ? min : max;
            }
            const q = Math.round(((x - min) / span) * levels);
            if (bits === 8) w.dv.setUint8(w.pos, q);
            else if (bits === 16) w.dv.setUint16(w.pos, q, true);
            else w.dv.setUint32(w.pos, q, true);
            w.pos += size;
        },
        (r) => {
            if (r.pos + size > r.end) truncated();
            const q = bits === 8 ? r.dv.getUint8(r.pos) : bits === 16 ? r.dv.getUint16(r.pos, true) : r.dv.getUint32(r.pos, true);
            r.pos += size;
            return q === levels ? max : min + (q / levels) * span;
        },
    );
}

/** The shape passed to `define`: field name to codec. / Описание для `define`: имя поля, кодек. */
export type Shape = Record<string, Codec<any>>;

/**
 * Mark a field of a record as added in a newer version of the schema. A packet written by an older writer ends
 * before this field; then the reader fills it with `fallback`. The writer always writes it. Added fields must be
 * the LAST fields of the record, and a record that has any can only be the top-level codec. See docs/spec.md,
 * "Evolution".
 * Пометить поле записи как добавленное в новой версии схемы. Пакет старого писателя кончается до этого поля,
 * тогда читатель подставляет `fallback`. Писатель пишет его всегда. Добавленные поля должны идти ПОСЛЕДНИМИ,
 * а запись с такими полями может быть только верхнего уровня. См. docs/spec.md, «Evolution».
 */
export function added<T>(item: Codec<T>, fallback: T): Codec<T> {
    const it = nestable(item, 'added');
    try {
        it.pack(fallback);
    } catch (e) {
        throw new TypeError(`added: the default is not a valid value for this type (${e instanceof Error ? e.message : String(e)})`);
    }
    const marked: Impl<T> = { ...it, isAdded: true, fallback };
    return marked;
}

export interface DefineOptions {
    /**
     * Off by default: a record is STRICT and any byte after its last field is an error. Turn this on to let the
     * record's readers ignore bytes after the last field they know (fields a NEWER writer appended). Declare it
     * from the first version of a message: a reader built without it rejects such packets. `added(...)` does not
     * turn it on. Costs nothing on the wire; the price is that extra bytes are no longer reported as an error.
     * Top-level codec only.
     * По умолчанию выключено: запись СТРОГАЯ, любой байт после последнего поля это ошибка. Включите, чтобы
     * читатели записи игнорировали байты после последнего известного поля (поля, дописанные БОЛЕЕ НОВЫМ
     * писателем). Объявляйте с первой версии сообщения: читатель без этой опции такие пакеты отвергает.
     * `added(...)` её не включает. На проводе бесплатно, но лишние байты больше не ошибка.
     */
    extensible?: boolean;
}

/**
 * A record with named fields, written in declaration order. Names are not stored in the packet.
 * Fields wrapped in `added(...)` (at the end) make it evolvable: see `added`.
 * Запись с именованными полями, пишется в порядке объявления. Имена в пакет не попадают.
 * Поля в `added(...)` (в конце) делают запись развиваемой: см. `added`.
 */
export function define<S extends Shape>(shape: S, options: DefineOptions = {}): Codec<Value<S>> {
    const names = Object.keys(shape);
    const codecs: Impl<unknown>[] = [];
    let min = 0;
    let max = 0;
    let required = names.length; // how many leading fields are not `added`
    for (const [index, name] of names.entries()) {
        // Integer-like keys would be reordered by JS (`{ b: …, 1: … }` iterates 1 first) and `__proto__` would
        // change the prototype of every decoded object.
        if (name === '__proto__' || /^(0|[1-9]\d*)$/.test(name)) {
            throw new TypeError(`define: "${name}" is not allowed as a field name`);
        }
        const c = nestable(shape[name]!, `define: field "${name}"`);
        if (c.isAdded) {
            if (required === names.length) required = index;
        } else {
            if (required < names.length) throw new TypeError(`define: field "${name}" comes after an added(...) field; added fields must be last`);
            min += c.min;
        }
        codecs.push(c);
        max += c.max;
    }
    const n = names.length;
    // `open`: the record depends on where its range ends (added fields or extensible), so it cannot be nested.
    // `lenient`: only an explicit `extensible: true` accepts bytes after the last known field; `added` alone
    // fills in defaults for an older packet but still rejects a newer one.
    const lenient = options.extensible === true;
    const open = lenient || required < n;
    const fallbacks = codecs.map((c) => c.fallback);
    return make<Value<S>>(
        min,
        max,
        (w, v) => {
            if (typeof v !== 'object' || v === null || Array.isArray(v)) fail('type', `expected an object, got ${describe(v)}`);
            const src = v as Record<string, unknown>;
            let i = 0;
            try {
                for (; i < n; i++) codecs[i]!.write(w, src[names[i]!]);
            } catch (e) {
                if (e instanceof PackError) e.addPath(names[i]!);
                throw e;
            }
        },
        (r) => {
            const out: Record<string, unknown> = {};
            let i = 0;
            try {
                for (; i < required; i++) out[names[i]!] = codecs[i]!.read(r);
                // Added fields: if the packet already ended exactly on a field boundary, it came from an older
                // writer and the field takes its default. A packet that ends in the middle of one is truncated.
                for (; i < n; i++) {
                    if (r.pos >= r.end) {
                        const f = fallbacks[i];
                        out[names[i]!] = typeof f === 'object' && f !== null ? structuredClone(f) : f;
                    } else {
                        out[names[i]!] = codecs[i]!.read(r);
                    }
                }
            } catch (e) {
                if (e instanceof PackError) e.addPath(names[i]!);
                throw e;
            }
            return out as Value<S>;
        },
        open,
        lenient,
    );
}
