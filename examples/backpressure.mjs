// Why 2pack gives you three ways to pack, and why the "fast" one has a warning label.
// Почему в 2pack три способа упаковки и почему у «быстрого» предупреждение.
//
// Run:  npm run backpressure
//
// The scenario is a game server that sends a stream of small packets to a client that reads slowly
// (a phone on a bad connection, a busy browser tab). That is normal life for a network stack, not an edge case.
// Сценарий: игровой сервер шлёт поток мелких пакетов клиенту, который читает медленно (телефон на плохой связи,
// занятая вкладка). Для сетевого стека это обычная жизнь, а не редкий случай.

import net from 'node:net';
import { define, str, u32 } from '../dist/index.js';

const COUNT = 300_000;
const Packet = define({ seq: u32, text: str(16) });

// --- the three ways to send --------------------------------------------------------------------------------------

/**
 * 1. packShared: zero allocation, returns a VIEW of the codec's internal buffer.
 *    The next packShared overwrites the very same memory.
 */
function sendShared(socket) {
    for (let seq = 0; seq < COUNT; seq++) {
        socket.write(Packet.packShared({ seq, text: `msg-${seq}` }));
    }
}

/** 2. pack: one small allocation per packet, the bytes are yours forever. Always safe. */
function sendCopy(socket) {
    for (let seq = 0; seq < COUNT; seq++) {
        socket.write(Packet.pack({ seq, text: `msg-${seq}` }));
    }
}

/**
 * 3. packInto + a pool: you own the buffers. Pack many packets into one buffer, hand it to the socket once,
 *    and give it back to the pool only when the socket says it is done with it (the write callback).
 *    Almost no allocation, and nothing can overwrite bytes the socket still needs.
 */
function sendPooled(socket) {
    const ARENA = 64 * 1024;
    const pool = [];
    let arena = Buffer.allocUnsafe(ARENA);
    let used = 0;

    const flush = () => {
        if (used === 0) return;
        const chunk = arena.subarray(0, used);
        const owned = arena;
        socket.write(chunk, () => pool.push(owned)); // reuse only after the socket is finished with it
        arena = pool.pop() ?? Buffer.allocUnsafe(ARENA);
        used = 0;
    };

    for (let seq = 0; seq < COUNT; seq++) {
        if (used + Packet.max > ARENA) flush();
        used += Packet.packInto(arena, { seq, text: `msg-${seq}` }, used);
    }
    flush();
}

// --- the experiment ----------------------------------------------------------------------------------------------

function run(name, send) {
    return new Promise((resolve) => {
        const server = net.createServer((conn) => {
            const chunks = [];
            conn.pause(); // the slow reader: do not read for a while, so the sender's writes pile up
            setTimeout(() => conn.resume(), 300);
            conn.on('data', (c) => chunks.push(c));
            conn.on('end', () => {
                server.close();
                resolve(report(name, Buffer.concat(chunks)));
            });
        });
        server.listen(0, '127.0.0.1', () => {
            const socket = net.connect(server.address().port, '127.0.0.1');
            // Wait for the connection first: data written earlier is also queued by reference, which would
            // hide the point of this demo. The burst is then written in one tick, like a game loop sending a frame.
            socket.on('connect', () => {
                send(socket);
                socket.end();
            });
        });
    });
}

function report(name, received) {
    let offset = 0;
    let good = 0;
    let firstBad = -1;
    while (offset < received.length) {
        let seq;
        try {
            const [packet, end] = Packet.unpackAt(received, offset);
            if (packet.seq !== good || packet.text !== `msg-${good}`) throw new Error('wrong content');
            seq = good;
            offset = end;
        } catch {
            firstBad = good;
            break;
        }
        good = seq + 1;
    }
    const verdict = good === COUNT ? 'all intact' : `CORRUPTED from packet #${firstBad}`;
    return `${name.padEnd(34)} ${String(good).padStart(7)} of ${COUNT} packets ok   ${verdict}`;
}

console.log(`Sending ${COUNT} packets in one tick to a client that does not read for 300 ms\n`);
console.log(await run('packShared  (view, zero alloc)', sendShared));
console.log(await run('pack       (fresh copy)', sendCopy));
console.log(await run('packInto + pool (you own it)', sendPooled));
