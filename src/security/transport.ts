import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { assertInputBudget } from './input-budget.js';
/** SDK framing bounds bytes; application bounds JSON topology before schema validation. */
export class GuardedStdioTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private readonly inner = new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 64 * 1024 * 1024 });
  async start() {
    this.inner.onclose = () => this.onclose?.(); this.inner.onerror = e => this.onerror?.(e);
    this.inner.onmessage = message => {
      try {
        assertInputBudget(message);
        this.onmessage?.(message);
      } catch (e) {
        if ('id' in message) void this.inner.send({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: (e as Error).message } }).catch(error => this.onerror?.(error));
      }
    };
    await this.inner.start();
  }
  async close() { await this.inner.close(); }
  async send(message: JSONRPCMessage) { await this.inner.send(message); }
}
