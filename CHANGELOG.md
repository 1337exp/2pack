# Changelog

## 2.0.0-dev.0

A rewrite from scratch; not compatible with 1.x.

- Schema as TypeScript values (`define({ hp: i16 })`), types inferred from the schema.
- Byte format specified in `docs/spec.md`, with test vectors. Fields are written in schema order, little-endian, varint lengths.
- Three ways to pack with explicit ownership: `pack` (fresh copy), `packInto` (your buffer), `packShared` (view of the codec's buffer).
- Declared maximum for every string, byte array and list; values over it are errors, never truncated. Integers are checked, not wrapped.
- Decoding is bounds-checked and throws only `PackError`, with a `code` and a `path`.
- New types: `bool`, `varuint`, `varint`, `optional`, `array`, `enumOf`, `quant`, nested `define`.
- Zero dependencies, ESM only, no code generation, no build step beyond `tsc`.
- Removed: runtime string schemas, the `offset` setter, `json<N>`, the browser Buffer polyfill, the UMD bundle.
