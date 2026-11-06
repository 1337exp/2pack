# Who owns the bytes

**English** · [Русский](buffer-ownership.ru.md)

The single most common way to corrupt network traffic in Node is also the most tempting optimisation: *reuse one buffer for every packet*. 2pack offers that trick, labels it, and gives you a safer way to get the same zero-allocation result. This page explains why.

## The trick

Packing into a fresh array costs an allocation per packet. Keep one scratch buffer instead, write every packet into it, hand out a *view*, and the allocations disappear. That is `packShared`:

```ts
const bytes = Packet.packShared(value); // a view of the codec's own buffer
```

It is correct for single-threaded JavaScript **as long as the bytes are consumed before the next call**. And that "as long as" is the whole story.

## The trap: `write()` returning does not mean the bytes were sent

```ts
socket.write(Packet.packShared(a));
socket.write(Packet.packShared(b)); // overwrites a's bytes
```

`socket.write(buf)` returns immediately. If the operating system's send buffer has room, the bytes are copied into it right away and you are fine. If it does not (a slow client, a phone on a bad connection, a busy browser tab), Node **keeps a reference to your buffer** in the socket's write queue and sends it later. `write()` returns `false` to tell you about it: that is *backpressure*.

Until that queued write finishes, the memory behind your buffer must not change. With `packShared` it changes on the very next packet: every queued chunk now points at the same memory, which holds whatever was packed last.

You cannot see this on localhost with a fast reader, which is why it survives testing and shows up in production. The same applies to anything that queues a buffer instead of copying it: a batching array, an `await` between packing and sending, a retry queue, a stream. Check what the API you are calling does with the buffer.

## Measured

`npm run backpressure` runs a burst of 300 000 small packets into a client that does not read for 300 ms:

```
packShared  (view, zero alloc)      160218 of 300000 packets ok   CORRUPTED from packet #160218
pack       (fresh copy)             300000 of 300000 packets ok   all intact
packInto + pool (you own it)        300000 of 300000 packets ok   all intact
```

The first 160 218 packets (about 2.4 MB) fit into the OS buffers and went straight out. When those filled up, every later packet was queued by reference and arrived as garbage. The exact number depends on the operating system and its socket buffers; the shape does not.

## Three ways to pack

| Method | You get | Allocation | The bytes stay valid |
|---|---|---|---|
| `pack(value)` | a new `Uint8Array` | one per packet | forever, they are yours |
| `packInto(buf, value, offset?)` | the number of bytes written into **your** buffer | none | for as long as **you** keep the buffer untouched |
| `packShared(value)` | a view of the codec's internal buffer | none | until the next `pack` or `packShared` on that codec |

Cost on this machine (Node 22; `npm run bench`):

| | 24-byte record | 144-byte snapshot |
|---|---|---|
| `pack` | 108 ns | 1246 ns |
| `packShared` | 100 ns (−7 %) | 945 ns (−24 %) |
| `packInto` | 77 ns (−29 %) | 909 ns (−27 %) |

The surprise is the first row against the second. On small packets the shared buffer saves almost nothing over a copy, and `packInto` beats it anyway, because the copy and the allocation are what you pay for, not the sharing. And `packInto` is safe, because the buffer is yours: nothing else writes into it.

## What to do

- **Default to `pack()`.** One small allocation, no rules to remember. On the payloads in `npm run bench` it is already faster than msgpackr and cbor-x, and 2 to 4 times smaller.
- **When allocation matters (a game server's send path), use `packInto` with buffers you own.** Pack a frame's packets one after another into one buffer, give it to the socket once, and return it to a pool only when the write callback fires. `examples/backpressure.mjs` has a 20-line version of exactly this.
- **Use `packShared` only when you finish with the bytes before the next call**, in the same synchronous stretch of code: hashing them, measuring them, compressing them synchronously. Never hand its result to something that may keep it.

The same rule applies on the way in: `bytes(max, { view: true })` returns a window into the buffer you decoded from, and network libraries often reuse the buffer they gave you. Copying is the default there too.
