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

> **Before you send:** `packShared` is the fastest way to pack, but its bytes are overwritten by the next call, and `socket.write()` can hold on to them under backpressure. See [You own the buffer](#you-own-the-buffer).

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
| `added(item, default)` | a field added in a newer version, last in its record, see [Evolving a packet](#evolving-a-packet) |

Every variable-size type has a declared maximum, so every codec has a finite `min` and `max` size: `new Uint8Array(codec.max)` always fits.

`str(n)` counts **bytes** of UTF-8, not characters: `str(16)` holds 16 Latin letters but only 8 Cyrillic ones. A string that does not fit throws `PackError`; it is never truncated, because silent truncation hides bugs (two long names become one). Set the cap generously (at least 3 x the limit in `.length`) and check the real limit where the value enters your app, for example `name.length <= 32` with `str(255)`. The wire carries only the actual length, so a high cap costs no bytes.

The byte-level format is in [docs/spec.md](https://github.com/1337exp/2pack/blob/main/docs/spec.md), with test vectors in `tests/vectors.ts`.

## Evolving a packet

Packets are strict, and **strict is the default**: no names or tags on the wire, a reader needs the schema that wrote the packet, and any byte beyond the last field is an error. Flexibility is opt-in, per message, with `{ extensible: true }`. One kind of change is supported, and it costs nothing on the wire or in speed: **appending fields at the end**.

```ts
// version 1: declared extensible from the start, so it already ignores fields a later version appends
const Player = define({ id: u32, name: str(16) }, { extensible: true });

// version 2: the new field goes last, wrapped in added(); an older packet decodes with the default
const Player = define({ id: u32, name: str(16), shield: added(u16, 0) }, { extensible: true });
```

New server, old client and old server, new client both work: a new reader fills what an old packet lacks, an old reader skips what a new packet adds. The rules and what it cannot do (removing or reordering fields, nesting) are in [docs/spec.md](https://github.com/1337exp/2pack/blob/main/docs/spec.md#evolution). Two things to know: it relies on the transport telling you where the packet ends (a WebSocket message does), and an extensible record no longer reports extra bytes as an error (that is the price of opting in).

## You own the buffer

Three ways to pack, and a page explaining why:

| | allocation | the bytes |
|---|---|---|
| `pack(value)` | one per packet | yours forever (default, always safe) |
| `packInto(buf, value, offset?)` | none | in **your** buffer |
| `packShared(value)` | none | a view, overwritten by the next call |

Handing a `packShared` view to `socket.write()` is a real bug under backpressure: [Who owns the bytes](https://github.com/1337exp/2pack/blob/main/docs/buffer-ownership.md) shows it happening and explains it. `npm run backpressure` reproduces it on your machine.

## Safe by construction

- Nothing wraps and nothing is truncated: `300` into `u8`, `1.5` into `u16`, `NaN` into `i32` and a string over its limit are errors that say where (`players[3].hp`).
- Decoding never reads outside `[offset, end)` and checks every length against both its declared maximum and the bytes that remain. A count of a billion items in a ten-byte packet is rejected before anything is allocated.
- Hostile or corrupt bytes throw `PackError` and nothing else: checked by tests with truncation of every packet at every length and 40 000 random corruptions.
- Results are plain objects that own their data. `packInto` writes only the packet's bytes.
- The same checks run in a real browser: `npm run browser` serves a page that runs the spec vectors, the fuzzing and the resizable-buffer cases against the library and turns the tab title into PASS or FAIL (tried in Chromium; no dependencies).

## How much to trust it

A serializer sits on the network edge, so it should be tested like it. What this one has been through:

- **338 tests**, and the byte format is pinned by **53 hand-computed vectors** from the spec, each checked packing, unpacking, into an exactly sized buffer and with the surroundings untouched.
- **Seeded, reproducible fuzzing.** Thousands of random packets round-trip; every packet is truncated at every length; 40 000 random single-byte corruptions and 20 000 random buffers are fed to the decoders. The rule being tested: decoding hostile bytes throws `PackError` and nothing else, and never allocates for a length the input cannot back.
- **Mutation check** (`npm run mutate`): the code is broken in 35 deliberate ways, one at a time (drop a bounds check, flip a byte order, wrap instead of reject, ...), and the tests must notice every one. They do. The first run let 2 of 19 through, which exposed two weak tests, now fixed.
- **Independent adversarial review** by another AI model (Grok), which read the spec and wrote its own differential fuzzers against the library. It found 6 bugs, one of them serious (`packInto` wrote bytes after the end of the packet) and missed by our own tests. All fixed, each pinned by a regression test (`tests/regressions.test.ts`).
- **A real browser**: `npm run browser` runs 95 checks in the page (Chromium 152).

What it has **not** had: a human security audit, production traffic, Firefox or Safari, or a big-endian machine. Version 2 is a development build, so pin the exact version until it has been out for a while.

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

- **Removing or reordering fields.** Only appending is supported; anything else goes through a version in a small header codec (see the spec).
- **A second implementation.** The format is specified byte for byte so another language can implement it, but only the TypeScript one exists.
- **A CommonJS build.** ESM only; Node 22 can `require()` it.

## Commands

```bash
npm run typecheck
npm test
npm run build
npm run bench
npm run mutate
npm run backpressure
npm run browser
```

## License

MIT, see [LICENSE](LICENSE).

## Us

Homepage: [666.io](https://666.io). If you want to help, suggest an idea or just talk, come by.
