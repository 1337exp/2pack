import { fail, PackError } from './errors.js';

/**
 * A codec for values of type `T`: one object that knows how to write `T` to bytes and read it back.
 * Every codec has a finite `min` and `max` size in bytes, so `new Uint8Array(codec.max)` always fits any value.
 *
 * Кодек значений типа `T`: умеет писать `T` в байты и читать обратно. У любого кодека конечные `min` и `max`
 * (в байтах), поэтому `new Uint8Array(codec.max)` вмещает любое значение.
 */
export interface Codec<T> {
    /** Smallest possible encoded size in bytes. / Минимальный размер в байтах. */
    readonly min: number;
    /** Largest possible encoded size in bytes. / Максимальный размер в байтах. */
    readonly max: number;

    /**
     * Encode into a **new** array that you own. Safe to keep, queue or send later. One allocation.
     * Упаковать в **новый** массив, он ваш: его можно хранить, ставить в очередь, отправлять позже.
     */
    pack(data: T): Uint8Array;

    /**
     * Encode into **your** buffer starting at `offset`; returns the number of bytes written.
     * No allocation, and nothing else touches your bytes. Throws `overflow` if the buffer is too small.
     * Упаковать в **ваш** буфер с `offset`; возвращает число записанных байт. Без аллокаций, чужого
     * кода в ваших байтах нет. Если буфера мало, `overflow`.
     */
    packInto(buf: Uint8Array, data: T, offset?: number): number;

    /**
     * Encode into this codec's internal scratch buffer and return a **view** of it. Zero data allocation, but the
     * bytes are overwritten by the next `pack` or `packShared` on this codec: copy them or finish sending
     * before then. Do NOT hand the view to `socket.write()` / `ws.send()` and encode again in the same tick:
     * see https://github.com/1337exp/2pack/blob/main/docs/buffer-ownership.md.
     * Упаковать во внутренний буфер кодека и вернуть **окно** на него. Данные не копируются, но следующий
     * `pack*` этого кодека перезапишет их. Нельзя отдавать окно в `socket.write()` / `ws.send()` и упаковывать
     * дальше в том же такте: см. https://github.com/1337exp/2pack/blob/main/docs/buffer-ownership.ru.md.
     */
    packShared(data: T): Uint8Array;

    /**
     * Decode one value from `buf[offset, end)`. The value must fill that range exactly, otherwise `invalid`
     * (trailing bytes) or `truncated`. Throws only `PackError`.
     * Прочитать одно значение из `buf[offset, end)`. Оно должно занять диапазон ровно, иначе `invalid`
     * (лишние байты) или `truncated`. Бросает только `PackError`.
     */
    unpack(buf: Uint8Array | ArrayBuffer, offset?: number, end?: number): T;

    /**
     * Like `unpack`, but extra bytes after the value are allowed; returns the value and the offset after it.
     * Use it to read several values from one buffer.
     * Как `unpack`, но лишние байты после значения допустимы; возвращает значение и смещение за ним.
     */
    unpackAt(buf: Uint8Array | ArrayBuffer, offset?: number, end?: number): [value: T, end: number];
}

/** The TypeScript type a codec encodes. / TypeScript-тип, который кодирует кодек. */
export type Infer<C> = C extends Codec<infer T> ? T : never;

/** Field names whose value may be `undefined` (they come from `optional(...)`). */
type OptionalKeys<S extends Record<string, Codec<any>>> = {
    [K in keyof S]: undefined extends Infer<S[K]> ? K : never;
}[keyof S];

type Simplify<T> = { [K in keyof T]: T[K] } & {};

/**
 * The value type of `define(shape)`: fields from `optional(...)` may be left out.
 * Тип значения для `define(shape)`: поля из `optional(...)` можно не указывать.
 */
export type Value<S extends Record<string, Codec<any>>> = Simplify<
    { [K in Exclude<keyof S, OptionalKeys<S>>]: Infer<S[K]> } & { [K in OptionalKeys<S>]?: Infer<S[K]> }
>;

// ---------------------------------------------------------------------------------------------------------------
// Internals / Внутреннее устройство
// ---------------------------------------------------------------------------------------------------------------

/** @internal Cursor over a buffer being written. */
export class Writer {
    u8: Uint8Array = new Uint8Array(0);
    dv: DataView = new DataView(this.u8.buffer);
    pos = 0;
    /** What `dv` was built for; see `bind`. */
    boundLen = -1;
    boundOff = -1;
}

/** @internal Cursor over a buffer being read; `end` is exclusive. */
export class Reader {
    u8: Uint8Array = new Uint8Array(0);
    dv: DataView = new DataView(this.u8.buffer);
    pos = 0;
    end = 0;
    boundLen = -1;
    boundOff = -1;
}

/**
 * Point a cursor at `buf`. The DataView is rebuilt unless it was built for this very array with the same length
 * and offset: a resizable or growable buffer changes length under the same Uint8Array object, and a transferred
 * (detached) one must not be used through a stale view. A zero-length array is always rebuilt, because a
 * detached buffer also reports length 0.
 * Привязать курсор к `buf`. DataView пересоздаётся, если это не тот же массив с той же длиной и смещением
 * (изменяемый буфер меняет длину, отвязанный нельзя использовать через старое окно).
 */
function bind(c: Writer | Reader, buf: Uint8Array): void {
    const len = buf.byteLength;
    const off = buf.byteOffset;
    if (c.u8 === buf && c.boundLen === len && c.boundOff === off && len !== 0) return;
    let dv: DataView;
    try {
        dv = new DataView(buf.buffer, off, len);
    } catch {
        return fail('usage', 'the buffer is detached or cannot be used (was it transferred or resized?)');
    }
    c.u8 = buf;
    c.dv = dv;
    c.boundLen = len;
    c.boundOff = off;
}

/** @internal A codec plus the two functions that composite codecs call. */
export interface Impl<T> extends Codec<T> {
    write(w: Writer, v: T): void;
    read(r: Reader): T;
    /**
     * The record depends on where its range ends (it has `added` fields or is `extensible`), so it must be the
     * top-level codec: something placed after it could never be found.
     */
    readonly open: boolean;
    /** Set by `added(...)`: the field may be missing from older packets and then takes `fallback`. */
    readonly isAdded?: boolean;
    readonly fallback?: unknown;
}

// One cursor per direction, reused by every call. JS runs one thread of user code at a time and neither
// direction calls back into user code except through property getters on the data being packed, which the
// `writing` flag guards. Rebinding the DataView only when the buffer changes keeps repeated calls on the
// same buffer allocation-free.
// Один курсор на направление, общий для всех вызовов. DataView пересоздаётся, только когда сменился буфер.
const writer = new Writer();
const reader = new Reader();
let writing = false;

/** Scratch buffers above this size are not kept between calls. / Буферы больше этого размера не хранятся. */
const SCRATCH_KEEP = 1 << 20;

/** @internal */
export function make<T>(
    min: number,
    max: number,
    write: (w: Writer, v: T) => void,
    read: (r: Reader) => T,
    open = false,
    lenient = false,
): Impl<T> {
    let scratch: Uint8Array | null = null;
    let lastLen = 0;

    function packIntoImpl(buf: Uint8Array, data: T, offset: number): number {
        if (!(buf instanceof Uint8Array)) fail('type', 'packInto: buf must be a Uint8Array');
        if (!Number.isInteger(offset) || offset < 0 || offset > buf.length) {
            fail('usage', `packInto: offset ${offset} is outside the buffer (length ${buf.length})`);
        }
        if (writing) fail('usage', 'pack called while another pack is running (from a getter?)');

        const w = writer;
        bind(w, buf);
        w.pos = offset;
        writing = true;
        try {
            write(w, data);
        } catch (e) {
            // A DataView store past the end throws RangeError; that is exactly "buffer too small".
            if (e instanceof RangeError && !(e instanceof PackError)) {
                throw new PackError('overflow', `buffer too small: ${buf.length - offset} bytes available after offset ${offset}`);
            }
            throw e;
        } finally {
            writing = false;
        }
        return w.pos - offset;
    }

    /** Encode into the scratch buffer (growing it if `max` is large); result length is left in `lastLen`. */
    function encodeScratch(data: T): Uint8Array {
        let size = scratch ? scratch.length : Math.min(max, SCRATCH_KEEP);
        for (;;) {
            let buf: Uint8Array;
            if (scratch && scratch.length >= size) {
                buf = scratch;
            } else {
                try {
                    buf = new Uint8Array(size);
                } catch {
                    // Growing x4 can ask for more than the process can allocate for a value that would have fit.
                    throw new PackError('range', `this value needs a buffer of up to ${size} bytes, which cannot be allocated`);
                }
            }
            try {
                lastLen = packIntoImpl(buf, data, 0);
            } catch (e) {
                if (e instanceof PackError && e.code === 'overflow' && size < max) {
                    size = Math.min(max, size * 4);
                    continue;
                }
                throw e;
            }
            if (buf.length <= SCRATCH_KEEP) scratch = buf;
            return buf;
        }
    }

    function unpackAtImpl(input: Uint8Array | ArrayBuffer, offset: number, end: number | undefined): number {
        const buf = input instanceof ArrayBuffer ? new Uint8Array(input) : input;
        if (!(buf instanceof Uint8Array)) fail('type', 'unpack: buf must be a Uint8Array or an ArrayBuffer');
        const stop = end === undefined ? buf.length : end;
        if (!Number.isInteger(offset) || !Number.isInteger(stop) || offset < 0 || stop < offset || stop > buf.length) {
            fail('usage', `unpack: range [${offset}, ${stop}) is outside the buffer (length ${buf.length})`);
        }
        const r = reader;
        bind(r, buf);
        r.pos = offset;
        r.end = stop;
        return stop;
    }

    const codec: Impl<T> = {
        min,
        max,
        open,
        write,
        read,

        pack(data) {
            const buf = encodeScratch(data);
            return buf.slice(0, lastLen);
        },

        packInto(buf, data, offset = 0) {
            return packIntoImpl(buf, data, offset);
        },

        packShared(data) {
            const buf = encodeScratch(data);
            return buf.subarray(0, lastLen);
        },

        unpack(input, offset = 0, end) {
            const stop = unpackAtImpl(input, offset, end);
            const value = read(reader);
            // Strict by default: every byte must belong to the value. Only a record explicitly declared
            // `extensible` accepts bytes after its last known field (fields a newer writer appended).
            if (!lenient && reader.pos !== stop) fail('invalid', `${stop - reader.pos} trailing byte(s) after the value`);
            return value;
        },

        unpackAt(input, offset = 0, end) {
            const stop = unpackAtImpl(input, offset, end);
            const value = read(reader);
            return [value, lenient ? stop : reader.pos];
        },
    };
    return codec;
}
