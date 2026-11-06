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
- **`unpack` consumes its range exactly.** Bytes left over after the value are an error (`invalid`); `unpackAt` allows them and returns where the value ended, for reading several values from one buffer.

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

Version 2.0 has **no schema evolution**: a packet is only decodable with exactly the schema that wrote it. Versioning is the application's job, and the intended pattern is a small header codec in front of the payload:

```ts
const Header = define({ type: u8, version: u8 });
// choose the payload codec by (type, version)
```

A field-level evolution rule (append-only fields with an "unknown tail is skipped" rule) is a candidate for a later minor version, not part of this format.

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
