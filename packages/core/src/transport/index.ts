import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { GatewayConfig } from '@getcordon/policy';

/**
 * Builds an MCP `Server` instance with handlers already registered.
 * Provided by `CordonGateway` so the transport layer stays agnostic to
 * how policy / audit / upstream are wired underneath.
 */
export type ServerFactory = () => Server;

/**
 * Manages the lifetime of an inbound transport. May serve one connection
 * (stdio) or many concurrent connections (HTTP / SSE).
 */
export interface TransportLifecycle {
  /**
   * Begin serving. For stdio, this creates one `Server` via the factory and
   * connects it to a single `StdioServerTransport`. For HTTP transports
   * (added in a follow-up commit), this starts the HTTP listener and
   * creates a fresh `Server` per inbound connection.
   */
  start(serverFactory: ServerFactory): Promise<void>;

  /** Stop serving and tear down active connections. */
  stop(): Promise<void>;
}

class StdioLifecycle implements TransportLifecycle {
  private server?: Server;
  private transport?: StdioServerTransport;

  async start(serverFactory: ServerFactory): Promise<void> {
    this.server = serverFactory();
    this.transport = new StdioServerTransport();
    await this.server.connect(this.transport);
  }

  async stop(): Promise<void> {
    await this.server?.close();
  }
}

/**
 * Pick a transport implementation based on the gateway config. Defaults to
 * stdio when no config is provided (preserves the Claude Desktop spawning
 * pattern that is the only supported mode today).
 */
export function createTransport(
  config: GatewayConfig | undefined,
): TransportLifecycle {
  const resolved = config ?? { transport: 'stdio' as const };

  if (resolved.transport === 'stdio') {
    return new StdioLifecycle();
  }

  if (resolved.transport === 'http') {
    throw new Error(
      'HTTP/SSE transport is not implemented yet — coming in a follow-up commit on this branch.',
    );
  }

  // Exhaustive switch — TypeScript enforces this never executes.
  const _exhaustive: never = resolved;
  throw new Error(`Unknown gateway transport: ${JSON.stringify(_exhaustive)}`);
}
