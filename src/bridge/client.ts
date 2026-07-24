/**
 * Live DCS bridge client.
 *
 * Connects over TCP to the DCS hook server (see scripts/Hooks/dcs-mcp-hook.lua),
 * sends one JSON request line, and reads one newline-terminated JSON response.
 *
 * Wire protocol (newline-terminated JSON, one round trip per connection):
 *   -> {"cmd":"<name>","args":{...},"env":"mission"|"export"}
 *   <- {"ok":true,"data":<any>} | {"ok":false,"error":"<message>"}
 */
import net from "node:net";
import { BRIDGE_TIMEOUT_MS } from "../constants.js";

export interface BridgeOptions {
  host: string;
  port: number;
  timeoutMs?: number;
}

export interface BridgeRequest {
  cmd: string;
  args?: Record<string, unknown>;
  env?: "mission" | "export" | "server";
}

export class BridgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BridgeError";
  }
}

interface BridgeEnvelope {
  ok: boolean;
  data?: unknown;
  error?: string;
}

/** Send one request to the DCS hook server and return its `data` payload. */
export function bridgeRequest(request: BridgeRequest, opts: BridgeOptions): Promise<unknown> {
  const timeoutMs = opts.timeoutMs ?? BRIDGE_TIMEOUT_MS;
  const payload = JSON.stringify(request);

  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let buffer = "";
    let settled = false;

    const timedOut = () =>
      reject(
        new BridgeError(
          `Timed out after ${timeoutMs}ms contacting the DCS hook server at ${opts.host}:${opts.port}. ` +
            `Is DCS running with scripts/Hooks/dcs-mcp-hook.lua installed and a mission loaded?`
        )
      );

    // Hard deadline. `socket.setTimeout` is an *idle* timer that stops firing once
    // the socket closes, so on its own it cannot rescue a connection the hook
    // closed without answering. This timer always fires.
    const deadline = setTimeout(() => finish(timedOut), timeoutMs);
    deadline.unref?.();

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      socket.destroy();
      fn();
    };

    // The peer closing before a full line arrived must reject, not hang forever.
    const onClosed = () =>
      finish(() =>
        reject(
          new BridgeError(
            buffer.length === 0
              ? `The DCS hook server at ${opts.host}:${opts.port} accepted the connection but closed it ` +
                `without replying. Check that a mission is running and that dcs-mcp-hook.lua loaded ` +
                `(look for "DCS-MCP" lines in Saved Games/DCS/Logs/dcs.log).`
              : `The DCS hook server at ${opts.host}:${opts.port} closed the connection mid-response ` +
                `(incomplete reply: ${JSON.stringify(buffer.slice(0, 200))}).`
          )
        )
      );
    socket.on("close", onClosed);
    socket.on("end", onClosed);

    socket.setTimeout(timeoutMs);
    socket.on("timeout", () => finish(timedOut));
    socket.on("error", (err) =>
      finish(() =>
        reject(
          new BridgeError(
            `Cannot reach the DCS hook server at ${opts.host}:${opts.port} (${err.message}). ` +
              `Install scripts/Hooks/dcs-mcp-hook.lua into Saved Games/DCS/Scripts/Hooks and start DCS.`
          )
        )
      )
    );

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      const line = buffer.slice(0, newline).trim();
      finish(() => {
        let env: BridgeEnvelope;
        try {
          env = JSON.parse(line) as BridgeEnvelope;
        } catch {
          reject(new BridgeError(`Bridge returned malformed JSON: ${line.slice(0, 300)}`));
          return;
        }
        if (!env.ok) {
          reject(new BridgeError(env.error ?? "DCS hook server reported an error"));
          return;
        }
        resolve(env.data);
      });
    });

    socket.connect(opts.port, opts.host, () => {
      socket.write(`${payload}\n`);
    });
  });
}
