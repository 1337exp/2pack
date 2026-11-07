# Changelog

## 2.0.0-dev.0

A rewrite from scratch; not compatible with 1.x.

- Schema as TypeScript values (`define({ hp: i16 })`), types inferred from the schema.
- Byte format specified in `docs/spec.md`, with test vectors. Fields are written in schema order, little-endian, varint lengths.
- Three ways to pack with explicit ownership: `pack` (fresh copy), `packInto` (your buffer), `packShared` (view of the codec's buffer).
- Declared maximum for every string, byte array and list; values over it are errors, never truncated. Integers are checked, not wrapped.
- Decoding is bounds-checked and throws only `PackError`, with a `code` and a `path`.
- New types: `bool`, `varuint`, `varint`, `optional`, `array`, `enumOf`, `quant`, nested `define`.
- Schema evolution by appending: `added(type, default)` fields at the end of a top-level record, and `define(shape, { extensible: true })` so that a first version already ignores what a later one appends. Zero bytes on the wire, no measurable speed cost, rules in `docs/spec.md`.
- Zero dependencies, ESM only, no code generation, no build step beyond `tsc`.
- Removed: runtime string schemas, the `offset` setter, `json<N>`, the browser Buffer polyfill, the UMD bundle.

Fixed before the first release, after an independent review of the first commit (each has a regression test in `tests/regressions.test.ts`):

- `packInto` of a short string whose declared maximum was 128 or more wrote 1 to 4 stray bytes after the packet, and refused a buffer of exactly the packet's size. The body is now written where it ends up.
- A resizable, growable or detached buffer reused through the same `Uint8Array` object read or wrote through a stale view (wrong `overflow`, raw `RangeError` / `TypeError`). The view is rebuilt when the length or offset changes, and an unusable buffer is a `PackError`.
- `quant(-Number.MAX_VALUE, Number.MAX_VALUE, bits)` encoded everything as 0 and decoded `NaN`: the span overflowed to `Infinity`. Now refused when the schema is built.
- An array was accepted as a record (`define({ length: u8 }).pack([1, 2, 3, 4])`).
- `define` made optional fields required in the TypeScript type; they can now be left out.
- A value too big to allocate a scratch buffer for threw a raw `RangeError`; it is a `PackError` now.

`npm run browser` runs 95 checks (spec vectors, ownership, bounds, hostile input, resizable and detached buffers) in a real browser; passed in Chromium 152.

`npm run mutate` breaks the code in 25 deliberate ways, one at a time, and checks that the tests notice every one.
