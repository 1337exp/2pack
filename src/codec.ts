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
     * see docs/buffer-ownership.md.
     * Упаковать во внутренний буфер кодека и вернуть **окно** на него. Данные не копируются, но следующий
     * `pack*` этого кодека перезапишет их. Нельзя отдавать окно в `socket.write()` / `ws.send()` и упаковывать
     * дальше в том же такте: см. docs/buffer-ownership.md.
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

// ---------------------------------------------------------------------------------------------------------------
// Internals / Внутреннее устройство
// ---------------------------------------------------------------------------------------------------------------

/** @internal Cursor over a buffer being written. */
export class Writer {
    u8: Uint8Array = new Uint8Array(0);
    dv: DataView = new DataView(this.u8.buffer);
    pos = 0;
}

/** @internal Cursor over a buffer being read; `end` is exclusive. */
export class Reader {
    u8: Uint8Array = new Uint8Array(0);
    dv: DataView = new DataView(this.u8.buffer);
    pos = 0;
    end = 0;
}

/** @internal A codec plus the two functions that composite codecs call. */
export interface Impl<T> extends Codec<T> {
    write(w: Writer, v: T): void;
    read(r: Reader): T;
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
export function make<T>(min: number, max: number, write: (w: Writer, v: T) => void, read: (r: Reader) => T): Impl<T> {
    let scratch: Uint8Array | null = null;
    let lastLen = 0;

    function packIntoImpl(buf: Uint8Array, data: T, offset: number): number {
        if (!(buf instanceof Uint8Array)) fail('type', 'packInto: buf must be a Uint8Array');
        if (!Number.isInteger(offset) || offset < 0 || offset > buf.length) {
            fail('usage', `packInto: offset ${offset} is outside the buffer (length ${buf.length})`);
        }
        if (writing) fail('usage', 'pack called while another pack is running (from a getter?)');

        const w = writer;
        if (w.u8 !== buf) {
            w.u8 = buf;
            w.dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
        }
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
            const buf = scratch && scratch.length >= size ? scratch : new Uint8Array(size);
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
        if (r.u8 !== buf) {
            r.u8 = buf;
            r.dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
        }
        r.pos = offset;
        r.end = stop;
        return stop;
    }

    const codec: Impl<T> = {
        min,
        max,
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
            if (reader.pos !== stop) fail('invalid', `${stop - reader.pos} trailing byte(s) after the value`);
            return value;
        },

        unpackAt(input, offset = 0, end) {
            unpackAtImpl(input, offset, end);
            const value = read(reader);
            return [value, reader.pos];
        },
    };
    return codec;
}
