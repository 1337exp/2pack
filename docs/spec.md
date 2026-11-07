# 2pack wire format, version 2

This is the byte-level contract. The TypeScript library is one implementation of it; anyone should be able to write another from this page and the test vectors (`tests/vectors.ts`).

There is **no schema on the wire**: no field names, no tags, no version byte, no padding. Both sides share the schema. A packet is the fields' encodings, back to back.

## Rules that apply everywhere

- **Byte order is little-endian**, on every host.
- **Fields are written in schema order** (the declaration order of `define({...})`). Appending a field to a schema changes the format for old data; see "Evolution" below.
- **Every variable-size value has a declared maximum.** The encoder rejects a value above it (it never truncates). The decoder rejects an encoded length above it. Because of this, every codec has a finite `min` and `max` size in bytes, so a buffer of `max` bytes always fits any value.
- **An encoder never writes outside the packet.** `packInto` touches exactly the bytes it reports, nothing before `offset` and nothing after the packet, and a buffer of exactly the packet's size is enough. A buffer that is detached, or was resized after use, is a `PackError`, never a raw `TypeError`.
- **A decoder never reads outside `[offset, end)`** and never trusts a length it has not checked against both its declared maximum and the bytes that remain.
- **Decoding is strict where the format is canonical** (booleans, enum indices, varints) and returns an error instead of guessing.
- **`unpack` consumes its range exactly.** Bytes left over after the value are an error (`invalid`); `unpackAt` allows them and returns where the value ended, for reading several values from one buffer. The one exception is a record declared `{ extensible: true }` (see "Evolution"), which owns the rest of its range.

## Types

| Type | Encoding | JS value |
|---|---|---|
| `bool` | 1 byte, `00` or `01` (anything else is an error) | `boolean` |
| `u8` `i8` | 1 byte | `number` |
| `u16` `i16` | 2 bytes, little-endian, two's complement for signed | `number` |
| `u32` `i32` | 4 bytes | `number` |
| `u64` `i64` | 8 bytes | `bigint` (a plain `number` is a `type` error: write `5n`) |
| `f32` `f64` | IEEE 754 binary32 / binary64, `NaN` and `±Infinity` preserved | `number` |
| `varuint` | unsigned LEB128, value in `0 … 2^32-1`, at most 5 bytes | `number` |
| `varint` | zigzag, then unsigned LEB128, value in `-2^31 … 2^31-1` | `number` |
| `str(max)` | `varuint` byte length `n` (`n <= max`), then `n` UTF-8 bytes | `string` |
| `bytes(max)` | `varuint` length `n` (`n <= max`), then `n` raw bytes | `Uint8Array` |
| `array(item, maxCount)` | `varuint` count (`<= maxCount`), then the items | `T[]` |
| `optional(item)` | 1 byte presence (`00` absent, `01` present), then the item if present | `T \| undefined` (an encoder also treats `null` as absent; inside `define` the field may be left out) |
| `enumOf(names)` | index of the name: 1 byte if there are at most 256 names, otherwise 2 bytes (`u16`) | one of the names |
| `quant(min, max, bits)` | `bits` is 8, 16 or 32; unsigned integer `q = round((v - min) / (max - min) * (2^bits - 1))` | `number` in `[min, max]` |
| `define({...})` | the fields' encodings in declaration order | object |
| `added(item, default)` | a field of a newer schema version, last in its record; same bytes as `item` | like `item` |

### Varints are canonical

A `varuint` uses the fewest bytes possible. The decoder rejects a longer ("overlong") encoding such as `80 00`, a fifth byte above `0x0f`, and more than five bytes. One value, one encoding: this keeps packets comparable byte for byte.

### Integers are checked, not wrapped

The encoder requires an integer inside the type's range and throws otherwise (`300` into `u8`, `1.5` into `u16`, `NaN` into `i32`). Silent wrap-around and silent `NaN → 0` were the worst habits of 1.x.

### Strings

- UTF-8, encoded as the platform's standard `TextEncoder`: a lone surrogate becomes U+FFFD (three bytes).
- The decoder does not strip a leading BOM (U+FEFF round-trips) and replaces malformed sequences with U+FFFD; it does not reject them.
- `max` counts **bytes**, not characters.

### Quantized numbers

`quant` is for values with a known range and a known acceptable error: positions, angles, `0..1` ratios. `round` is round-half-up (`Math.round`). The decoder returns `min + q / (2^bits - 1) * (max - min)`, and exactly `max` for the top step; so `0.5` in `quant(0, 1, 8)` is stored as `0x80` and decodes to `128 / 255`, not `0.5`. The decoded value is within `(max - min) / (2^bits - 1) / 2` of the original. By default the encoder throws for a value outside `[min, max]` or `NaN`; with `{ clamp: true }` it clamps to the range (it still throws for `NaN`). `min` and `max` must be finite and `max - min` must be finite too: `quant(-Number.MAX_VALUE, Number.MAX_VALUE, 8)` is refused when the schema is built.

## Evolution

A packet carries no field names or tags, so a reader needs the schema that wrote it. The format supports one kind of change for free: **appending fields at the end of a top-level record**.

```ts
// version 1, declared extensible from the start
const Player = define({ id: u32, name: str(16) }, { extensible: true });
// version 2: the new field goes LAST, wrapped in added(); the number is what an older packet decodes to.
// It is extensible too, so that it will read version 3 when that comes.
const Player = define({ id: u32, name: str(16), shield: added(u16, 0) }, { extensible: true });
```

Rules, all of them enforced:

- The writer always writes every field it knows. Nothing extra is stored: **zero bytes of overhead**.
- A reader knows where the packet ends (`end`, from the transport: a WebSocket message, a length prefix). **Reading an older packet**: after the last required field, every `added` field that starts exactly at `end` takes its default. A packet that ends in the middle of a field is `truncated`, not defaulted.
- **Strict by default.** A record rejects any byte after its last field (`invalid`, trailing bytes), `added` fields included. **Reading a newer packet**: only a record declared `{ extensible: true }` ignores the bytes after its last known field. `added` alone does not turn that on. **A reader built without it rejects such a packet**, so declare it from the first version of a message.
- `added` fields must be the last fields of the record.
- A record with `added` fields, or one declared extensible, depends on where its range ends, so it can only be the top-level codec: it cannot be an array item, an `optional` or a field of another record. `define`, `array`, `optional` and `added` refuse it at schema-build time.
- `unpackAt` on an extensible record returns the end of its range as the end offset.
- The default of `added` must be a valid value of the field's type (checked when the schema is built); object defaults are copied for every decode.

What it cannot do: remove, reorder or change the type of a field, or evolve a record nested inside another. The price of an extensible record is that extra bytes are no longer reported as an error. Anything beyond appending still goes through a version in a small header codec:

```ts
const Header = define({ type: u8, version: u8 });
// choose the payload codec by (type, version)
```

## Errors

Every failure is a `PackError` with a `code`, and a `path` such as `players[3].hp`:

| Code | Meaning |
|---|---|
| `type` | the value has the wrong JavaScript type (or a field is missing) |
| `range` | the value is outside the type's range, or longer than its declared maximum |
| `overflow` | `packInto` was given a buffer that is too small |
| `truncated` | the input ended before the value did |
| `invalid` | the input is not valid for the schema (bad boolean, enum index, varint, or a length above the declared maximum) |
| `usage` | the API was used wrongly (for example a re-entrant `pack`) |

Decoding hostile or corrupt bytes **only ever throws `PackError`**, never another error type, and never allocates more than the input can justify: an array count is checked against the bytes that remain before the array is allocated.
