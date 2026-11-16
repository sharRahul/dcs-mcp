import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { bridgeRequest, BridgeError } from "../src/bridge/client.js";

/** Start a one-shot fake DCS hook server that returns `respond(request)` as an envelope. */
function fakeHook(respond: (req: any) => object): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      let buf = "";
      socket.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        const nl = buf.indexOf("\n");
        if (nl === -1) return;
        const req = JSON.parse(buf.slice(0, nl));
        socket.write(JSON.stringify(respond(req)) + "\n");
        socket.end();
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port;
      resolve({ port, close: () => server.close() });
    });
  });
}

test("bridge sends the request and returns data on ok:true", async () => {
  let received: any;
  const hook = await fakeHook((req) => {
    received = req;
    return { ok: true, data: { pong: true, echo: req.cmd } };
  });
  try {
    const data = (await bridgeRequest(
      { cmd: "ping", args: { a: 1 } },
      { host: "127.0.0.1", port: hook.port }
    )) as any;
    assert.equal(received.cmd, "ping");
    assert.deepEqual(received.args, { a: 1 });
    assert.equal(data.pong, true);
    assert.equal(data.echo, "ping");
  } finally {
    hook.close();
  }
});

test("bridge throws BridgeError on ok:false", async () => {
  const hook = await fakeHook(() => ({ ok: false, error: "no mission running" }));
  try {
    await assert.rejects(
      () => bridgeRequest({ cmd: "units" }, { host: "127.0.0.1", port: hook.port }),
      (err: unknown) => err instanceof BridgeError && /no mission running/.test((err as Error).message)
    );
  } finally {
    hook.close();
  }
});

test("bridge errors clearly when nothing is listening", async () => {
  await assert.rejects(
    () => bridgeRequest({ cmd: "ping" }, { host: "127.0.0.1", port: 1, timeoutMs: 500 }),
    (err: unknown) => err instanceof BridgeError
  );
});

/** Server that accepts a connection and then behaves badly. */
function rudeHook(behave: (socket: net.Socket) => void): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const server = net.createServer(behave);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port;
      resolve({ port, close: () => server.close() });
    });
  });
}

test("bridge rejects when the hook closes without replying (never hangs)", async () => {
  const hook = await rudeHook((socket) => socket.end());
  try {
    await assert.rejects(
      () => bridgeRequest({ cmd: "ping" }, { host: "127.0.0.1", port: hook.port, timeoutMs: 10_000 }),
      (err: unknown) => err instanceof BridgeError && /closed it without replying/.test((err as Error).message)
    );
  } finally {
    hook.close();
  }
});

test("bridge rejects on a truncated response instead of waiting for a newline", async () => {
  const hook = await rudeHook((socket) => {
    socket.write('{"ok":true,"da');
    socket.end();
  });
  try {
    await assert.rejects(
      () => bridgeRequest({ cmd: "ping" }, { host: "127.0.0.1", port: hook.port, timeoutMs: 10_000 }),
      (err: unknown) => err instanceof BridgeError && /mid-response/.test((err as Error).message)
    );
  } finally {
    hook.close();
  }
});

test("bridge times out when the hook accepts but never answers or closes", async () => {
  const sockets: net.Socket[] = [];
  const hook = await rudeHook((socket) => sockets.push(socket)); // hold it open, say nothing
  try {
    await assert.rejects(
      () => bridgeRequest({ cmd: "ping" }, { host: "127.0.0.1", port: hook.port, timeoutMs: 300 }),
      (err: unknown) => err instanceof BridgeError && /Timed out after 300ms/.test((err as Error).message)
    );
  } finally {
    for (const s of sockets) s.destroy();
    hook.close();
  }
});

test('bridge rejects malformed success envelopes and invalid options before connecting', async () => {
 const hook = await fakeHook(() => ({ ok: 'yes', data: 'untrusted' }));
 try { await assert.rejects(bridgeRequest({ cmd: 'status' }, { host: '127.0.0.1', port: hook.port }), /envelope|boolean|Malformed/i); }
 finally { hook.close(); }
 await assert.rejects(bridgeRequest({ cmd: 'ping' }, { host: '127.0.0.1', port: 0 }), (e: any) => e.code === 'INVALID_OPTIONS');
 await assert.rejects(bridgeRequest({ cmd: 'ping', args: { text: 'x'.repeat(4 * 1024 * 1024) } }, { host: '127.0.0.1', port: 1 }), (e: any) => e.code === 'REQUEST_TOO_LARGE');
});
test('bridge preserves a multibyte UTF8 sequence split across TCP reads', async () => {
 const server = net.createServer(socket => { socket.once('data', () => { const bytes = Buffer.from(JSON.stringify({ ok: true, data: '航空' }) + '\n'); const split = bytes.indexOf(Buffer.from('航')) + 1; socket.write(bytes.subarray(0, split)); setTimeout(() => socket.end(bytes.subarray(split)), 10); }); });
 await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
 try { assert.equal(await bridgeRequest({ cmd: 'ping' }, { host: '127.0.0.1', port: (server.address() as net.AddressInfo).port }), '航空'); }
 finally { server.close(); }
});
