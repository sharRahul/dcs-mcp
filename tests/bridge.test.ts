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
