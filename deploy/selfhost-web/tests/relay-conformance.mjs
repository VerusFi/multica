#!/usr/bin/env node
// WISP relay conformance suite — the parity gate for the two script relays
// (and the replacement for the old Go relay's `go test` protocol coverage).
//
// Usage (from deploy/selfhost-web/):
//   node tests/relay-conformance.mjs
//   node tests/relay-conformance.mjs powershell -NoProfile -ExecutionPolicy Bypass -File relay.ps1
//
// The relay command is spawned with `-listen 127.0.0.1:<free port>`
// appended (PowerShell binds -listen to relay.ps1's -Listen parameter
// case-insensitively, so the same flag spelling works for both).
//
// The WebSocket client below is hand-rolled on purpose: it lets the suite
// set an arbitrary Origin header, observe non-101 handshake responses, and
// send byte-exact (even malformed) WISP frames — none of which the
// standard WebSocket API allows.
import { spawn } from "child_process";
import { createConnection, createServer } from "net";
import { createSocket } from "dgram";
import { createHash, randomBytes } from "crypto";

const root = new URL("..", import.meta.url).pathname;
const cmd = process.argv.length > 2 ? process.argv.slice(2) : ["python3", "relay.py"];

const TYPE_CONNECT = 0x01, TYPE_DATA = 0x02, TYPE_CONTINUE = 0x03, TYPE_CLOSE = 0x04;
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (cond, message) => { if (!cond) throw new Error(message ?? "assertion failed"); };

const freePort = () => new Promise((resolve) => {
  const srv = createServer().listen(0, "127.0.0.1", () => {
    const { port } = srv.address();
    srv.close(() => resolve(port));
  });
});

async function startRelay(extraArgs = []) {
  const port = await freePort();
  const proc = spawn(cmd[0], [...cmd.slice(1), "-listen", `127.0.0.1:${port}`, ...extraArgs],
    { cwd: root, stdio: ["ignore", "inherit", "inherit"] });
  const deadline = Date.now() + 60_000; // PowerShell startup on a CI runner is slow
  for (;;) {
    if (proc.exitCode !== null) throw new Error(`relay exited early (code ${proc.exitCode})`);
    const up = await new Promise((resolve) => {
      const c = createConnection(port, "127.0.0.1");
      c.on("connect", () => { c.destroy(); resolve(true); });
      c.on("error", () => resolve(false));
    });
    if (up) break;
    if (Date.now() > deadline) { proc.kill(); throw new Error("relay never started listening"); }
    await sleep(200);
  }
  return { port, proc, stop: () => proc.kill() };
}

// --- minimal raw WebSocket client ------------------------------------------

class WSClient {
  constructor(socket, initial) {
    this.socket = socket;
    this.buffer = initial;
    this.queue = [];
    this.waiters = [];
    this.ended = false;
    socket.on("data", (chunk) => { this.buffer = Buffer.concat([this.buffer, chunk]); this.#parse(); });
    socket.on("close", () => { this.ended = true; this.#flush(); });
    socket.on("error", () => {});
    this.#parse();
  }

  #parse() {
    // Server frames are never masked; the relay always sends FIN frames.
    for (;;) {
      if (this.buffer.length < 2) return;
      const opcode = this.buffer[0] & 0x0f;
      let length = this.buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2); offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        length = Number(this.buffer.readBigUInt64BE(2)); offset = 10;
      }
      if (this.buffer.length < offset + length) return;
      this.queue.push({ opcode, payload: this.buffer.slice(offset, offset + length) });
      this.buffer = this.buffer.slice(offset + length);
      this.#flush();
    }
  }

  #flush() {
    while (this.waiters.length && (this.queue.length || this.ended)) {
      const waiter = this.waiters.shift();
      if (this.queue.length) waiter.resolve(this.queue.shift());
      else waiter.reject(new Error("websocket closed"));
    }
  }

  next(timeoutMs = 10_000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for a frame")), timeoutMs);
      this.waiters.push({
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.#flush();
    });
  }

  send(opcode, payload) {
    const body = Buffer.from(payload);
    const mask = randomBytes(4);
    for (let i = 0; i < body.length; i++) body[i] ^= mask[i % 4];
    let header;
    if (body.length < 126) {
      header = Buffer.from([0x80 | opcode, 0x80 | body.length]);
    } else {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(body.length, 2);
    }
    this.socket.write(Buffer.concat([header, mask, body]));
  }

  destroy() { this.socket.destroy(); }
}

function wsHandshake(port, origin) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(port, "127.0.0.1");
    const key = randomBytes(16).toString("base64");
    socket.on("connect", () => {
      socket.write(
        `GET / HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n` +
        (origin ? `Origin: ${origin}\r\n` : "") +
        "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
        `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    let head = Buffer.alloc(0);
    const onData = (chunk) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end === -1) return;
      socket.off("data", onData);
      const response = head.slice(0, end).toString("latin1");
      const status = Number(response.split(" ")[1]);
      if (status !== 101) { socket.destroy(); resolve({ status }); return; }
      const expected = createHash("sha1").update(key + WS_GUID).digest("base64");
      if (!response.includes(expected)) { socket.destroy(); reject(new Error("bad Sec-WebSocket-Accept")); return; }
      resolve({ status, ws: new WSClient(socket, head.slice(end + 4)) });
    };
    socket.on("data", onData);
    socket.on("error", reject);
    socket.setTimeout(10_000, () => { socket.destroy(); resolve({ status: 0 }); });
  });
}

// --- WISP helpers -----------------------------------------------------------

const wispFrame = (type, streamId, payload) => {
  const head = Buffer.alloc(5);
  head[0] = type;
  head.writeUInt32LE(streamId, 1);
  return Buffer.concat([head, Buffer.from(payload)]);
};
const connectPayload = (streamType, port, host) => {
  const head = Buffer.alloc(3);
  head[0] = streamType;
  head.writeUInt16LE(port, 1);
  return Buffer.concat([head, Buffer.from(host)]);
};
const parseWisp = (buf) => ({ type: buf[0], streamId: buf.readUInt32LE(1), payload: buf.slice(5) });

async function nextWisp(ws, predicate) {
  for (;;) {
    const { opcode, payload } = await ws.next();
    if (opcode !== 0x2) continue;
    const frame = parseWisp(payload);
    if (predicate(frame)) return frame;
  }
}

async function openSession(port) {
  const { status, ws } = await wsHandshake(port, "http://localhost:8000");
  assert(status === 101, `handshake failed with status ${status}`);
  const first = parseWisp((await ws.next()).payload);
  assert(first.type === TYPE_CONTINUE && first.streamId === 0,
    "expected the initial CONTINUE on stream 0");
  assert(first.payload.readUInt32LE(0) === 128, "initial buffer must be 128");
  return ws;
}

// --- test runner ------------------------------------------------------------

let failures = 0;
async function test(name, fn) {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (e) { failures++; console.error(`FAIL ${name}\n  ${(e && e.stack) || e}`); }
}

const relay = await startRelay();
try {
  await test("initial CONTINUE(128) on stream 0 after upgrade", async () => {
    const ws = await openSession(relay.port);
    ws.destroy();
  });

  await test("foreign Origin is rejected", async () => {
    const { status } = await wsHandshake(relay.port, "https://evil.example");
    assert(status !== 101, `expected a non-101 response, got ${status}`);
  });

  await test("absent Origin is accepted (non-browser client)", async () => {
    const { status, ws } = await wsHandshake(relay.port, null);
    assert(status === 101, `expected 101, got ${status}`);
    ws.destroy();
  });

  await test("TCP stream echoes and DATA is answered with CONTINUE", async () => {
    const echo = createServer((c) => c.pipe(c));
    await new Promise((r) => echo.listen(0, "127.0.0.1", r));
    const ws = await openSession(relay.port);
    ws.send(0x2, wispFrame(TYPE_CONNECT, 1, connectPayload(0x01, echo.address().port, "127.0.0.1")));
    ws.send(0x2, wispFrame(TYPE_DATA, 1, Buffer.from("ping")));
    const data = await nextWisp(ws, (f) => f.type === TYPE_DATA && f.streamId === 1);
    assert(data.payload.toString() === "ping", `echo mismatch: ${data.payload}`);
    // The relay acknowledges every accepted client DATA with CONTINUE(128).
    // (It may arrive before or after the echo; a fresh session isolates it.)
    const ws2 = await openSession(relay.port);
    ws2.send(0x2, wispFrame(TYPE_CONNECT, 1, connectPayload(0x01, echo.address().port, "127.0.0.1")));
    ws2.send(0x2, wispFrame(TYPE_DATA, 1, Buffer.from("x")));
    const cont = await nextWisp(ws2, (f) => f.type === TYPE_CONTINUE && f.streamId === 1);
    assert(cont.payload.readUInt32LE(0) === 128, "CONTINUE window must be 128");
    ws.destroy(); ws2.destroy(); echo.close();
  });

  await test("hostname CONNECT resolves relay-side", async () => {
    const echo = createServer((c) => c.pipe(c));
    await new Promise((r) => echo.listen(0, "127.0.0.1", r));
    const ws = await openSession(relay.port);
    ws.send(0x2, wispFrame(TYPE_CONNECT, 1, connectPayload(0x01, echo.address().port, "localhost")));
    ws.send(0x2, wispFrame(TYPE_DATA, 1, Buffer.from("ping")));
    const data = await nextWisp(ws, (f) => f.type === TYPE_DATA && f.streamId === 1);
    assert(data.payload.toString() === "ping");
    ws.destroy(); echo.close();
  });

  await test("CONNECT to a closed port yields CLOSE(0x42)", async () => {
    const closedPort = await freePort(); // nothing listens here
    const ws = await openSession(relay.port);
    ws.send(0x2, wispFrame(TYPE_CONNECT, 1, connectPayload(0x01, closedPort, "127.0.0.1")));
    const close = await nextWisp(ws, (f) => f.type === TYPE_CLOSE && f.streamId === 1);
    assert(close.payload[0] === 0x42, `expected reason 0x42, got 0x${close.payload[0].toString(16)}`);
    ws.destroy();
  });

  await test("malformed CONNECT payload yields CLOSE(0x41)", async () => {
    const ws = await openSession(relay.port);
    ws.send(0x2, wispFrame(TYPE_CONNECT, 1, Buffer.from([0x01, 0x00]))); // < 4 bytes
    const close = await nextWisp(ws, (f) => f.type === TYPE_CLOSE && f.streamId === 1);
    assert(close.payload[0] === 0x41, `expected reason 0x41, got 0x${close.payload[0].toString(16)}`);
    ws.destroy();
  });

  await test("a short WISP frame is ignored and the session survives", async () => {
    const echo = createServer((c) => c.pipe(c));
    await new Promise((r) => echo.listen(0, "127.0.0.1", r));
    const ws = await openSession(relay.port);
    ws.send(0x2, Buffer.from([0x02, 0x01, 0x00])); // 3 bytes: shorter than a WISP header
    ws.send(0x2, wispFrame(TYPE_CONNECT, 1, connectPayload(0x01, echo.address().port, "127.0.0.1")));
    ws.send(0x2, wispFrame(TYPE_DATA, 1, Buffer.from("still-alive")));
    const data = await nextWisp(ws, (f) => f.type === TYPE_DATA && f.streamId === 1);
    assert(data.payload.toString() === "still-alive");
    ws.destroy(); echo.close();
  });

  await test("UDP stream (type 2) echoes a datagram", async () => {
    const udp = createSocket("udp4");
    udp.on("message", (message, rinfo) => udp.send(message, rinfo.port, rinfo.address));
    await new Promise((r) => udp.bind(0, "127.0.0.1", r));
    const ws = await openSession(relay.port);
    ws.send(0x2, wispFrame(TYPE_CONNECT, 1, connectPayload(0x02, udp.address().port, "127.0.0.1")));
    ws.send(0x2, wispFrame(TYPE_DATA, 1, Buffer.from("dgram")));
    const data = await nextWisp(ws, (f) => f.type === TYPE_DATA && f.streamId === 1);
    assert(data.payload.toString() === "dgram", `udp echo mismatch: ${data.payload}`);
    ws.destroy(); udp.close();
  });

  await test("client CLOSE tears down the target connection", async () => {
    let targetClosed;
    const closed = new Promise((r) => (targetClosed = r));
    const echo = createServer((c) => { c.on("close", targetClosed); c.pipe(c); });
    await new Promise((r) => echo.listen(0, "127.0.0.1", r));
    const ws = await openSession(relay.port);
    ws.send(0x2, wispFrame(TYPE_CONNECT, 1, connectPayload(0x01, echo.address().port, "127.0.0.1")));
    ws.send(0x2, wispFrame(TYPE_DATA, 1, Buffer.from("hello"))); // ensure established
    await nextWisp(ws, (f) => f.type === TYPE_DATA && f.streamId === 1);
    ws.send(0x2, wispFrame(TYPE_CLOSE, 1, Buffer.from([0x02])));
    await Promise.race([closed, sleep(10_000).then(() => { throw new Error("target never closed"); })]);
    ws.destroy(); echo.close();
  });

  await test("WebSocket PING is answered with PONG", async () => {
    const ws = await openSession(relay.port);
    ws.send(0x9, Buffer.from("hello"));
    for (;;) {
      const { opcode, payload } = await ws.next();
      if (opcode === 0xA) { assert(payload.toString() === "hello", "PONG must echo the PING payload"); break; }
    }
    ws.destroy();
  });
} finally {
  relay.stop();
}

const relayAllowed = await startRelay(["-origin", "https://owner.github.io"]);
try {
  await test("explicitly allowed Origin is accepted (URL form normalized)", async () => {
    const { status, ws } = await wsHandshake(relayAllowed.port, "https://owner.github.io");
    assert(status === 101, `expected 101, got ${status}`);
    ws.destroy();
  });

  await test("other foreign Origins stay rejected on the -origin relay", async () => {
    const { status } = await wsHandshake(relayAllowed.port, "https://evil.example");
    assert(status !== 101, `expected a non-101 response, got ${status}`);
  });
} finally {
  relayAllowed.stop();
}

process.exit(failures ? 1 : 0);
