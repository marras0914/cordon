import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { ResolvedConfig } from '@getcordon/policy';
import { AuditLogger } from './audit/logger.js';
import { ApprovalManager } from './approvals/manager.js';
import { PolicyEngine } from './policies/engine.js';
import { UpstreamManager } from './proxy/upstream-manager.js';
import { Interceptor } from './proxy/interceptor.js';
import { RateLimiter } from './rate-limiter.js';
import { createTransport, type TransportLifecycle } from './transport/index.js';

export class CordonGateway {
  private upstream: UpstreamManager;
  private policy: PolicyEngine;
  private approvals: ApprovalManager;
  private audit: AuditLogger;
  private interceptor: Interceptor;
  private transport?: TransportLifecycle;
  private readonly config: ResolvedConfig;

  constructor(config: ResolvedConfig) {
    this.config = config;
    this.audit = new AuditLogger(config.audit);
    this.policy = new PolicyEngine(config);
    this.approvals = new ApprovalManager(config.approvals);
    this.upstream = new UpstreamManager(config.servers);
    const rateLimiter = config.rateLimit ? new RateLimiter(config.rateLimit) : undefined;
    this.interceptor = new Interceptor(
      this.upstream,
      this.policy,
      this.approvals,
      this.audit,
      rateLimiter,
    );
  }

  async start(): Promise<void> {
    // 1. Connect to all configured upstream MCP servers
    await this.upstream.connect();

    this.audit.log({
      event: 'gateway_started',
      servers: this.upstream.serverNames(),
    });

    // 2. Start the inbound transport. For stdio this creates one Server and
    //    connects it to StdioServerTransport (blocks until client disconnects).
    //    For HTTP transports (follow-up commit) the listener handles many
    //    concurrent connections, each with its own Server instance.
    this.transport = createTransport(this.config.gateway);
    await this.transport.start(() => this.createServer());
  }

  async stop(): Promise<void> {
    await this.transport?.stop();
    await this.upstream.disconnect();
    this.audit.log({ event: 'gateway_stopped' });
    this.audit.close();
  }

  // ── Handlers ────────────────────────────────────────────────────────────────

  /**
   * Build a fresh MCP Server with handlers registered. Called once per
   * inbound connection — once total for stdio, once per session for HTTP.
   */
  private createServer(): Server {
    const server = new Server(
      { name: 'cordon', version: '0.1.0' },
      { capabilities: { tools: {} } },
    );
    this.registerHandlers(server);
    return server;
  }

  private registerHandlers(server: Server): void {
    // tools/list — return the merged tool registry, with `hidden`-policy
    // tools filtered out so the model never sees them.
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      const tools = this.upstream
        .getTools()
        .filter((t) => !this.policy.isHidden(t.serverName, t.originalName))
        .map((t) => ({
          name: t.proxyName,
          description: t.description,
          inputSchema: t.inputSchema,
        }));
      return { tools };
    });

    // tools/call — intercept, apply policy, forward if allowed
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      return this.interceptor.handle(
        request.params.name,
        request.params.arguments ?? {},
      );
    });
  }
}
