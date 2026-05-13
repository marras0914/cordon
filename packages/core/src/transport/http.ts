import http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { HTTPGatewayConfig } from '@getcordon/policy';
import type { TransportLifecycle, ServerFactory } from './index.js';

const DEFAULT_PORT = 7777;
const DEFAULT_HOST = '127.0.0.1';
const MCP_PATH = '/mcp';

/**
 * HTTP transport built on the MCP SDK's `StreamableHTTPServerTransport`.
 *
 * The SDK transport handles session multiplexing internally via session IDs
 * in headers, so one transport instance serves all concurrent client sessions
 * (n8n agents, Cursor instances, etc). One MCP Server is wired to one
 * transport via the `serverFactory` callback.
 *
 * The HTTP listener does three jobs before delegating to the transport:
 *   1. Reject requests on paths other than `/mcp` (404)
 *   2. Verify the Bearer token from `Authorization` header (401 if missing or invalid)
 *   3. Pass the request through to `transport.handleRequest`, which speaks the
 *      MCP Streamable HTTP wire protocol (GET to open SSE stream, POST to send
 *      a message, DELETE to terminate a session)
 */
export class HTTPLifecycle implements TransportLifecycle {
  private server?: Server;
  private transport?: StreamableHTTPServerTransport;
  private httpServer?: http.Server;

  constructor(private readonly config: HTTPGatewayConfig) {}

  async start(serverFactory: ServerFactory): Promise<void> {
    this.transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });

    this.server = serverFactory();
    await this.server.connect(this.transport);

    this.httpServer = http.createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        process.stderr.write(`[cordon] http handler error: ${err}\n`);
        if (!res.headersSent) {
          this.respond(res, 500, 'Internal server error');
        }
      });
    });

    const port = this.config.port ?? DEFAULT_PORT;
    const host = this.config.host ?? DEFAULT_HOST;

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        this.httpServer?.removeListener('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        this.httpServer?.removeListener('error', onError);
        resolve();
      };
      this.httpServer!.once('error', onError);
      this.httpServer!.once('listening', onListening);
      this.httpServer!.listen(port, host);
    });

    process.stderr.write(
      `[cordon] HTTP gateway listening on http://${host}:${port}${MCP_PATH}\n`,
    );
  }

  async stop(): Promise<void> {
    if (this.httpServer) {
      await new Promise<void>((resolve) => {
        this.httpServer!.close(() => resolve());
      });
    }
    await this.transport?.close();
    await this.server?.close();
  }

  private async handle(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url ?? '', `http://${req.headers.host ?? 'localhost'}`);

    if (url.pathname !== MCP_PATH) {
      return this.respond(res, 404, 'Not found');
    }

    if (!this.checkAuth(req)) {
      return this.respond(res, 401, 'Unauthorized');
    }

    // Delegate to the MCP transport. It handles GET (open SSE stream), POST
    // (send message), and DELETE (terminate session) per the Streamable HTTP spec.
    await this.transport!.handleRequest(req, res);
  }

  private checkAuth(req: http.IncomingMessage): boolean {
    const header = req.headers.authorization;
    if (typeof header !== 'string') return false;
    const idx = header.indexOf(' ');
    if (idx === -1) return false;
    const scheme = header.slice(0, idx);
    const token = header.slice(idx + 1).trim();
    if (scheme !== 'Bearer' || !token) return false;
    return constantTimeEquals(token, this.config.authToken);
  }

  private respond(res: http.ServerResponse, status: number, message: string): void {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: message }));
  }
}

/**
 * Constant-time string comparison. Prevents timing attacks on the auth token
 * by ensuring comparison runs in time proportional to the longer string,
 * not to the first byte that differs.
 */
function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
