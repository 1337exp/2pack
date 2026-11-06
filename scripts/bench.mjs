// Honest micro-benchmark: 2pack v2 against JSON, msgpackr and cbor-x on three payload shapes.
// Run after `npm run build`:  npm run bench
//
// What this does and does not show: all numbers are ns per operation on THIS machine, median of 5 runs after a
// warm-up, one thread, small objects. `pack` (safe copy) is the number to compare with the others; `packShared`
// and `packInto` skip the copy and are listed separately because they come with ownership rules
// (docs/buffer-ownership.md). The decoders build the same plain objects the others build.

import { array, define, f32, quant, str, u16, u8, varuint } from '../dist/index.js';
import { Packr, pack as mpPack, unpack as mpUnpack } from 'msgpackr';
import * as cbor from 'cbor-x';

const records = new Packr({ useRecords: true });

// --- payloads -------------------------------------------------------------------------------------------------------

const hero = { name: 'Hero_123456', lvl: 42, hp: 1337, gm: 3, x: 300.9, y: -300.52 };
const Hero = define({ name: str(32), lvl: u8, hp: u16, gm: u8, x: f32, y: f32 });

const move = { id: 70001, x: 123.5, y: -77.25, dir: 3 };
const Move = define({ id: varuint, x: quant(-500, 500, 16), y: quant(-500, 500, 16), dir: u8 });

const snapshot = {
    tick: 123456,
    units: Array.from({ length: 20 }, (_, i) => ({ id: 1000 + i, x: i * 12.5 - 100, y: 200 - i * 7.25, hp: 100 - i })),
};
const Snapshot = define({
    tick: varuint,
    units: array(define({ id: varuint, x: quant(-500, 500, 16), y: quant(-500, 500, 16), hp: u8 }), 64),
});

// --- harness ------------------------------------------------------------------------------------------------------

function ns(fn, iterations) {
    for (let i = 0; i < Math.min(iterations, 50_000); i++) fn();
    const runs = [];
    for (let r = 0; r < 5; r++) {
        const t = process.hrtime.bigint();
        for (let i = 0; i < iterations; i++) fn();
        runs.push(Number(process.hrtime.bigint() - t) / iterations);
    }
    return runs.sort((a, b) => a - b)[2];
}

let sink;
function scenario(title, value, codec, iterations) {
    const json = JSON.stringify(value);
    const jsonBytes = Buffer.from(json);
    const mp = mpPack(value);
    const rec = records.pack(value);
    const cb = cbor.encode(value);
    const own = codec.pack(value);
    const buf = new Uint8Array(codec.max);

    console.log(`\n${title}`);
    console.log(`  size in bytes: 2pack ${own.length} | msgpackr ${mp.length} (records ${rec.length}) | cbor-x ${cb.length} | JSON ${jsonBytes.length}`);
    const rows = [
        ['encode', '2pack pack (safe copy)', () => { sink = codec.pack(value); }],
        ['encode', '2pack packShared (view)', () => { sink = codec.packShared(value); }],
        ['encode', '2pack packInto (your buffer)', () => { sink = codec.packInto(buf, value); }],
        ['encode', 'msgpackr', () => { sink = mpPack(value); }],
        ['encode', 'msgpackr records', () => { sink = records.pack(value); }],
        ['encode', 'cbor-x', () => { sink = cbor.encode(value); }],
        ['encode', 'JSON.stringify -> bytes', () => { sink = Buffer.from(JSON.stringify(value)); }],
        ['decode', '2pack unpack', () => { sink = codec.unpack(own); }],
        ['decode', 'msgpackr', () => { sink = mpUnpack(mp); }],
        ['decode', 'msgpackr records', () => { sink = records.unpack(rec); }],
        ['decode', 'cbor-x', () => { sink = cbor.decode(cb); }],
        ['decode', 'JSON.parse(bytes)', () => { sink = JSON.parse(jsonBytes); }],
    ];
    let last = '';
    for (const [kind, name, fn] of rows) {
        if (kind !== last) console.log(`  ${kind}:`);
        last = kind;
        console.log(`    ${name.padEnd(30)} ${ns(fn, iterations).toFixed(0).padStart(6)} ns`);
    }
}

console.log(`node ${process.version}, ${process.platform} ${process.arch}`);
scenario('A. game record (name + 5 numbers)', hero, Hero, 1_000_000);
scenario('B. movement command (id, x, y, dir)', move, Move, 1_000_000);
scenario('C. snapshot of 20 units', snapshot, Snapshot, 200_000);
void sink;
