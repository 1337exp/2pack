import { array, bool, bytes, define, enumOf, f32, f64, i16, i32, i64, i8, optional, quant, str, u16, u32, u64, u8, varint, varuint, type Codec } from '../src/index.js';

// Byte-exact vectors for docs/spec.md, computed by hand from the spec (not by running the codec).
// Another implementation of the format must reproduce every line.
// Эталонные байты для docs/spec.md, посчитаны вручную по спецификации, а не запуском кодека.

export interface Vector {
    name: string;
    codec: Codec<any>;
    value: unknown;
    hex: string;
    /** What unpack returns, when it differs from `value` (lossy types only). */
    decoded?: unknown;
}

const rep = (hex: string, n: number): string => hex.repeat(n);

export const vectors: Vector[] = [
    { name: 'bool true', codec: bool, value: true, hex: '01' },
    { name: 'bool false', codec: bool, value: false, hex: '00' },
    { name: 'u8', codec: u8, value: 7, hex: '07' },
    { name: 'u8 max', codec: u8, value: 255, hex: 'ff' },
    { name: 'i8', codec: i8, value: -2, hex: 'fe' },
    { name: 'u16 little-endian', codec: u16, value: 0x1234, hex: '3412' },
    { name: 'i16', codec: i16, value: -2, hex: 'feff' },
    { name: 'u32', codec: u32, value: 0xdeadbeef, hex: 'efbeadde' },
    { name: 'i32', codec: i32, value: -2, hex: 'feffffff' },
    { name: 'u64', codec: u64, value: 1n, hex: '0100000000000000' },
    { name: 'u64 max', codec: u64, value: 0xffffffffffffffffn, hex: 'ffffffffffffffff' },
    { name: 'i64', codec: i64, value: -1n, hex: 'ffffffffffffffff' },
    { name: 'i64 min', codec: i64, value: -0x8000000000000000n, hex: '0000000000000080' },
    { name: 'f32', codec: f32, value: 1.5, hex: '0000c03f' },
    { name: 'f32 +Infinity', codec: f32, value: Infinity, hex: '0000807f' },
    { name: 'f64', codec: f64, value: 1.5, hex: '000000000000f83f' },
    { name: 'f64 -Infinity', codec: f64, value: -Infinity, hex: '000000000000f0ff' },

    { name: 'varuint 0', codec: varuint, value: 0, hex: '00' },
    { name: 'varuint 127', codec: varuint, value: 127, hex: '7f' },
    { name: 'varuint 128', codec: varuint, value: 128, hex: '8001' },
    { name: 'varuint 300', codec: varuint, value: 300, hex: 'ac02' },
    { name: 'varuint 16384', codec: varuint, value: 16384, hex: '808001' },
    { name: 'varuint max', codec: varuint, value: 4294967295, hex: 'ffffffff0f' },
    { name: 'varint 0', codec: varint, value: 0, hex: '00' },
    { name: 'varint -1', codec: varint, value: -1, hex: '01' },
    { name: 'varint 1', codec: varint, value: 1, hex: '02' },
    { name: 'varint -2', codec: varint, value: -2, hex: '03' },
    { name: 'varint 63', codec: varint, value: 63, hex: '7e' },
    { name: 'varint -64', codec: varint, value: -64, hex: '7f' },
    { name: 'varint 64', codec: varint, value: 64, hex: '8001' },
    { name: 'varint max', codec: varint, value: 2147483647, hex: 'feffffff0f' },
    { name: 'varint min', codec: varint, value: -2147483648, hex: 'ffffffff0f' },

    { name: 'str ascii', codec: str(16), value: 'hi', hex: '026869' },
    { name: 'str empty', codec: str(16), value: '', hex: '00' },
    { name: 'str 2-byte char', codec: str(16), value: 'é', hex: '02c3a9' },
    { name: 'str 3-byte char', codec: str(16), value: '☃', hex: '03e29883' },
    { name: 'str 4-byte char', codec: str(16), value: '😀', hex: '04f09f9880' },
    { name: 'str leading BOM is kept', codec: str(16), value: '﻿a', hex: '04efbbbf61' },
    { name: 'str with a 2-byte length prefix', codec: str(200), value: 'a'.repeat(130), hex: '8201' + rep('61', 130) },
    { name: 'str(1000) with a short value', codec: str(1000), value: 'ab', hex: '026162' },
    { name: 'bytes', codec: bytes(8), value: new Uint8Array([1, 2, 3]), hex: '03010203' },
    { name: 'bytes empty', codec: bytes(8), value: new Uint8Array(0), hex: '00' },

    { name: 'enum', codec: enumOf(['a', 'b', 'c']), value: 'c', hex: '02' },
    { name: 'optional absent', codec: optional(u8), value: undefined, hex: '00' },
    { name: 'optional present', codec: optional(u8), value: 5, hex: '0105' },
    { name: 'array', codec: array(u8, 4), value: [1, 2, 3], hex: '03010203' },
    { name: 'array empty', codec: array(u8, 4), value: [], hex: '00' },
    { name: 'quant 8 min', codec: quant(0, 1, 8), value: 0, hex: '00' },
    { name: 'quant 8 max', codec: quant(0, 1, 8), value: 1, hex: 'ff' },
    // 0.5 * 255 = 127.5 rounds up to 128 = 0x80; decoding gives min + 128 / 255 * span (spec formula)
    { name: 'quant 8 middle (ties round up)', codec: quant(0, 1, 8), value: 0.5, hex: '80', decoded: 128 / 255 },
    // (0 - -1) / 2 * 65535 = 32767.5 rounds up to 32768 = 0x8000
    { name: 'quant 16 symmetric', codec: quant(-1, 1, 16), value: 0, hex: '0080', decoded: -1 + (32768 / 65535) * 2 },

    {
        name: 'record',
        codec: define({ id: u16, name: str(8), alive: bool }),
        value: { id: 258, name: 'ab', alive: true },
        hex: '0201' + '026162' + '01',
    },
    {
        name: 'nested record in an array',
        codec: define({ items: array(define({ k: u8, v: i16 }), 3) }),
        value: { items: [{ k: 1, v: -2 }, { k: 3, v: 4 }] },
        hex: '02' + '01feff' + '030400',
    },
];
