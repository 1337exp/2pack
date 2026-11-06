# 2pack

**English** · [Русский](README.ru.md)

A tiny schema-first binary codec for Node and browsers. You describe a packet once, in TypeScript; the type is inferred, the bytes are small, and decoding hostile input can only ever throw one kind of error. No dependencies, no code generation, you own the buffers.

> Version 2 is a rewrite and **not compatible with 1.x**: the field order, the size prefixes and the whole API changed.

## Stack

TypeScript 6, ESM only, zero runtime dependencies, Node 18+ and any modern browser. Tests with vitest.

## Quick start

```ts
import { array, define, enumOf, i16, quant, str, u8, varuint, type Infer } from '@1337exp/2pack';

const Packet = define({
    kind: enumOf(['join', 'move', 'chat']),
    name: str(16), // at most 16 UTF-8 bytes; longer is an error, never truncated
    hp: i16,
    pos: define({ x: quant(-500, 500, 16), y: quant(-500, 500, 16) }), // 2 bytes each, error under 0.008
    items: array(define({ id: varuint, count: u8 }), 8),
});

type Packet = Infer<typeof Packet>; // { kind: 'join' | 'move' | 'chat'; name: string; hp: number; ... }

const bytes = Packet.pack({ kind: 'move', name: 'D', hp: -13, pos: { x: 12.5, y: -3 }, items: [{ id: 7, count: 2 }] });
const value = Packet.unpack(bytes); // typed, validated, or a PackError
```

Several packets in one buffer (a header, then a payload), with no allocation:

```ts
const Header = define({ type: u8, version: u8 });
const Hello = define({ name: str(16), hp: i16 });
const buf = new Uint8Array(Header.max + Hello.max);

let n = Header.packInto(buf, { type: 3, version: 1 });
n += Hello.packInto(buf, { name: 'D', hp: 100 }, n);

const [header, at] = Header.unpackAt(buf, 0, n);
const payload = Hello.unpack(buf, at, n);
```

## Types

| | |
|---|---|
| `bool` `u8` `i8` `u16` `i16` `u32` `i32` `f32` `f64` | fixed-size, little-endian |
| `u64` `i64` | 8 bytes, `bigint` |
| `varuint` `varint` | 1 to 5 bytes, small numbers cost one byte |
| `str(maxBytes)` `bytes(maxBytes)` | length-prefixed, the maximum is mandatory |
| `array(item, maxCount)` `optional(item)` `enumOf([...])` | |
| `quant(min, max, bits)` | a number in a known range stored in 8, 16 or 32 bits |
| `define({...})` | a record, fields in declaration order, names are not sent |

Every variable-size type has a declared maximum, so every codec has a finite `min` and `max` size: `new Uint8Array(codec.max)` always fits.

The byte-level format is in [docs/spec.md](docs/spec.md), with test vectors in `tests/vectors.ts`.

## You own the buffer

Three ways to pack, and a page explaining why:

| | allocation | the bytes |
|---|---|---|
| `pack(value)` | one per packet | yours forever (default, always safe) |
| `packInto(buf, value, offset?)` | none | in **your** buffer |
| `packShared(value)` | none | a view, overwritten by the next call |

Handing a `packShared` view to `socket.write()` is a real bug under backpressure: [Who owns the bytes](docs/buffer-ownership.md) shows it happening and explains it. `npm run backpressure` reproduces it on your machine.

## Safe by construction

- Nothing wraps and nothing is truncated: `300` into `u8`, `1.5` into `u16`, `NaN` into `i32` and a string over its limit are errors that say where (`players[3].hp`).
- Decoding never reads outside `[offset, end)` and checks every length against both its declared maximum and the bytes that remain. A count of a billion items in a ten-byte packet is rejected before anything is allocated.
- Hostile or corrupt bytes throw `PackError` and nothing else: checked by tests with truncation of every packet at every length and 40 000 random corruptions.
- Results are plain objects that own their data. `packInto` writes only the packet's bytes.

## Speed and size

One machine (Node 22, Windows), small objects, median of 5 runs. `npm run bench` reproduces it. Compared on the safe `pack`, which copies.

| | size | encode | decode |
|---|---|---|---|
| **2pack**, 24-byte game record | **24 B** | **108 ns** | **144 ns** |
| msgpackr | 57 B | 217 ns | 195 ns |
| cbor-x | 58 B | 205 ns | 334 ns |
| JSON (as bytes) | 70 B | 442 ns | 763 ns |
| **2pack**, snapshot of 20 units | **144 B** | **1246 ns** | **1265 ns** |
| msgpackr | 608 B | 2164 ns | 3607 ns |
| cbor-x | 634 B | 2554 ns | 3740 ns |
| JSON (as bytes) | 792 B | 3849 ns | 4767 ns |

The size win is the structural one: with a schema on both sides, names and type tags are not sent. If you cannot share a schema, use msgpackr or cbor-x; they are good.

## Not yet

- **Schema evolution.** A packet decodes only with the schema that wrote it. Put a version in a small header codec (see the spec).
- **A second implementation.** The format is specified byte for byte so another language can implement it, but only the TypeScript one exists.
- **A CommonJS build.** ESM only; Node 22 can `require()` it.

## Commands

```bash
npm run typecheck
npm test
npm run build
npm run bench
npm run backpressure
```

## License

MIT, see [LICENSE](LICENSE).

## Us

Homepage: [666.io](https://666.io). If you want to help, suggest an idea or just talk, come by.
