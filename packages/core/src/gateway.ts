import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { ResolvedConfig } from 'cordon-sdk';
import { AuditLogger } from './audit/logger.js';
import { ApprovalManager } from './approvals/manager.js';
import { PolicyEngine } from './policies/engine.js';
import { UpstreamManager } from './proxy/upstream-manager.js';
import { Interceptor } from './proxy/interceptor.js';

export class CordonGateway {
  private server: Server;
  private upstream: UpstreamManager;
  private policy: PolicyEngine;
  private approvals: ApprovalManager;
  private audit: AuditLogger;
  private interceptor: Interceptor;

  constructor(config: ResolvedConfig) {
    this.audit = new AuditLogger(config.audit);
    this.policy = new PolicyEngine(config);
    this.approvals = new ApprovalManager(config.approvals);
    this.upstream = new UpstreamManager(config.servers);
    this.interceptor = new Interceptor(
      this.upstream,
      this.policy,
      this.approvals,
      this.audit,
    );

    // The front-facing MCP server that Claude Desktop connects to
    this.server = new Server(
      { name: 'cordon', version: '0.1.0' },
      { capabilities: { tools: {} } },
    );

    this.registerHandlers();
  }

  async start(): Promise<void> {
    // 1. Connect to all configured upstream MCP servers
    await this.upstream.connect();

    this.audit.log({
      event: 'gateway_started',
      servers: this.upstream.serverNames(),
    });

    // 2. Start the stdio transport — this blocks until the client disconnects
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
  }

  async stop(): Promise<void> {
    await this.upstream.disconnect();
    await this.server.close();
    this.audit.log({ event: 'gateway_stopped' });
    this.audit.close();
  }

  // ── Handlers ────────────────────────────────────────────────────────────────

  private registerHandlers(): void {
    // tools/list — return the merged tool registry from all upstream servers
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const tools = this.upstream.getTools().map((t) => ({
        name: t.proxyName,
        description: t.description,
        inputSchema: t.inputSchema,
      }));
      return { tools };
    });

    // tools/call — intercept, apply policy, forward if allowed
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      return this.interceptor.handle(
        request.params.name,
        request.params.arguments ?? {},
      );
    });
  }
}
