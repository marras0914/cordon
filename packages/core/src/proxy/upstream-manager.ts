import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { StdioServerConfig } from 'cordon-sdk';

/** The actual return type of Client.callTool() — wider than the named CallToolResult. */
export type ToolCallResponse = Awaited<ReturnType<Client['callTool']>>;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ToolWithOrigin extends Tool {
  /** The server that owns this tool. */
  serverName: string;
  /** Original tool name as reported by the server. */
  originalName: string;
  /**
   * Name exposed to the LLM client. Equal to originalName when there are no
   * collisions; namespaced as "serverName__toolName" when two servers share
   * a tool name.
   */
  proxyName: string;
}

// ── Manager ───────────────────────────────────────────────────────────────────

export class UpstreamManager {
  private clients = new Map<string, Client>();
  private registry = new Map<string, ToolWithOrigin>();

  constructor(private configs: StdioServerConfig[]) {}

  async connect(): Promise<void> {
    await Promise.all(this.configs.map((cfg) => this.connectServer(cfg)));
    await this.refreshRegistry();
  }

  async disconnect(): Promise<void> {
    await Promise.all([...this.clients.values()].map((c) => c.close()));
    this.clients.clear();
    this.registry.clear();
  }

  serverNames(): string[] {
    return [...this.clients.keys()];
  }

  /** Returns the current merged + namespaced tool list. */
  getTools(): ToolWithOrigin[] {
    return [...this.registry.values()];
  }

  /** Look up which server and original tool name to use for a proxy tool name. */
  resolve(proxyName: string): ToolWithOrigin | undefined {
    return this.registry.get(proxyName);
  }

  async callTool(serverName: string, toolName: string, args: unknown): Promise<ToolCallResponse> {
    const client = this.clients.get(serverName);
    if (!client) {
      throw new Error(`No upstream client for server '${serverName}'`);
    }
    return client.callTool({
      name: toolName,
      arguments: args as Record<string, unknown>,
    });
  }

  /**
   * Re-queries all upstream servers for their tool lists and rebuilds the
   * registry. Called on startup and whenever a tools/list-changed notification
   * arrives from any upstream.
   */
  async refreshRegistry(): Promise<ToolWithOrigin[]> {
    this.registry.clear();

    // Gather tools per server
    const perServer = new Map<string, Tool[]>();
    for (const [serverName, client] of this.clients) {
      try {
        const { tools } = await client.listTools();
        perServer.set(serverName, tools);
      } catch (err) {
        process.stderr.write(
          `[cordon] warn: failed to list tools from '${serverName}': ${String(err)}\n`,
        );
        perServer.set(serverName, []);
      }
    }

    // Count name occurrences to detect collisions
    const nameCounts = new Map<string, number>();
    for (const tools of perServer.values()) {
      for (const tool of tools) {
        nameCounts.set(tool.name, (nameCounts.get(tool.name) ?? 0) + 1);
      }
    }

    // Build registry; namespace only on collision
    for (const [serverName, tools] of perServer) {
      for (const tool of tools) {
        const collision = (nameCounts.get(tool.name) ?? 0) > 1;
        const proxyName = collision ? `${serverName}__${tool.name}` : tool.name;
        this.registry.set(proxyName, {
          ...tool,
          serverName,
          originalName: tool.name,
          proxyName,
        });
      }
    }

    return [...this.registry.values()];
  }

  // ── Private ──────────────────────────────────────────────────────────────────

  private async connectServer(cfg: StdioServerConfig): Promise<void> {
    const client = new Client({ name: 'cordon', version: '0.1.0' });
    const transport = new StdioClientTransport({
      command: cfg.command,
      args: cfg.args ?? [],
      env: cfg.env,
    });

    // When the upstream process exits, remove it from the registry so the
    // LLM is no longer offered tools from a dead server.
    transport.onclose = () => {
      if (this.clients.has(cfg.name)) {
        process.stderr.write(`[cordon] warn: upstream '${cfg.name}' disconnected\n`);
        this.clients.delete(cfg.name);
        for (const [proxyName, tool] of this.registry) {
          if (tool.serverName === cfg.name) {
            this.registry.delete(proxyName);
          }
        }
      }
    };

    try {
      await client.connect(transport);
      transport.stderr?.pipe(process.stderr);
      this.clients.set(cfg.name, client);
      process.stderr.write(`[cordon] connected to '${cfg.name}'\n`);
    } catch (err) {
      throw new Error(`Failed to connect to upstream '${cfg.name}': ${String(err)}`);
    }
  }
}
