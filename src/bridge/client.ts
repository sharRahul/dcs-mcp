/**
 * Live-telemetry bridge client.
 *
 * Connects over TCP to the DCS export listener (see scripts/Export.lua), sends a
 * single command line, and reads one newline-terminated JSON response. Read-only:
 * the bridge only exposes approved, whitelisted queries and never accepts Lua.
 */
import net from "node:net";
import { BRIDGE_TIMEOUT_MS } from "../constants.js";

export interface BridgeOptions {
  host: string;
  port: number;
  timeoutMs?: number;
}

export class BridgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BridgeError";
  }
}

/** Send one command to the bridge and return the parsed JSON response. */
export function bridgeRequest(command: string, opts: BridgeOptions): Promise<unknown> {
  const timeoutMs = opts.timeoutMs ?? BRIDGE_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let buffer = "";
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      fn();
    };

    socket.setTimeout(timeoutMs);
    socket.on("timeout", () =>
      finish(() =>
        reject(
          new BridgeError(
            `Timed out after ${timeoutMs}ms contacting DCS bridge at ${opts.host}:${opts.port}. ` +
              `Is DCS running with scripts/Export.lua installed?`
          )
        )
      )
    );
    socket.on("error", (err) =>
      finish(() =>
        reject(
          new BridgeError(
            `Cannot reach DCS bridge at ${opts.host}:${opts.port} (${err.message}). ` +
              `Ensure DCS is running and Export.lua is installed in Saved Games/DCS/Scripts.`
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
        try {
          resolve(JSON.parse(line));
        } catch {
          reject(new BridgeError(`Bridge returned malformed JSON: ${line.slice(0, 200)}`));
        }
      });
    });

    socket.connect(opts.port, opts.host, () => {
      socket.write(`${command}\n`);
    });
  });
}
