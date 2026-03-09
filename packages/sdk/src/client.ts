import { ApprovalTimeout, CordonError, PolicyBlocked, RateLimited } from "./errors.ts";

export interface CordonClientOptions {
  /** Root URL of the Cordon gateway, e.g. "http://localhost:8000" */
  baseUrl: string;
  /** Seconds between approval status polls. Default: 5 */
  pollInterval?: number;
  /** Fetch timeout in milliseconds. Default: 10_000 */
  fetchTimeout?: number;
}

export type ToolResult = Record<string, unknown>;

interface JsonRpcResponse {
  jsonrpc: string;
  id?: string | number;
  result?: ToolResult;
  error?: { code: number; message: string };
}

let _id = 1;

export class CordonClient {
  private readonly baseUrl: string;
  private readonly pollInterval: number;
  private readonly fetchTimeout: number;

  constructor(options: CordonClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.pollInterval = (options.pollInterval ?? 5) * 1_000;
    this.fetchTimeout = options.fetchTimeout ?? 10_000;
  }

  /**
   * Call a tool through the Cordon gateway.
   *
   * Transparently handles the HITL approval loop: if the gateway returns
   * REQUIRE_APPROVAL (-32002), polls until approved, rejected, or timed out.
   *
   * @throws {PolicyBlocked}    Tool blocked by policy
   * @throws {ApprovalRejected} Operator rejected the request
   * @throws {ApprovalTimeout}  approval_timeout_ms elapsed
   * @throws {RateLimited}      Gateway rate limit exceeded
   * @throws {CordonError}      Any other gateway error
   */
  async callTool(
    toolName: string,
    args: Record<string, unknown>,
    options?: {
      approvalTimeoutMs?: number;
      requestId?: string | number;
    },
  ): Promise<ToolResult> {
    const approvalTimeout = options?.approvalTimeoutMs ?? 300_000;
    const requestId = options?.requestId ?? _id++;

    const payload = {
      jsonrpc: "2.0",
      id: requestId,
      method: "tools/call",
      params: { name: toolName, arguments: args },
    };

    let approvalId: string | null = null;
    let elapsed = 0;

    while (true) {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (approvalId) headers["X-Cordon-Approval-Id"] = approvalId;

      const res = await fetch(`${this.baseUrl}/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.fetchTimeout),
      });

      const body = (await res.json()) as JsonRpcResponse;

      if (body.result !== undefined) return body.result;

      const code = body.error?.code;
      const msg = body.error?.message ?? "";

      if (code === -32001) throw new PolicyBlocked(toolName, msg);

      if (code === -32005) throw new RateLimited(parseRetryAfter(msg));

      if (code === -32002) {
        if (approvalId === null) {
          approvalId = parseApprovalId(msg);
          if (!approvalId) throw new CordonError(`Could not parse approval_id from: ${msg}`);
        }
        if (elapsed >= approvalTimeout) {
          throw new ApprovalTimeout(toolName, approvalId, approvalTimeout / 1_000);
        }
        await sleep(this.pollInterval);
        elapsed += this.pollInterval;
        continue;
      }

      throw new CordonError(`Unexpected gateway error (code=${code}): ${msg}`);
    }
  }

  /** Convenience: call multiple tools in parallel */
  async callTools(
    calls: Array<{ toolName: string; args: Record<string, unknown> }>,
    options?: { approvalTimeoutMs?: number },
  ): Promise<ToolResult[]> {
    return Promise.all(calls.map((c) => this.callTool(c.toolName, c.args, options)));
  }

  [Symbol.asyncDispose]() {
    // No persistent connection to clean up — fetch is stateless
    return Promise.resolve();
  }
}

// ---------- helpers ----------

function parseApprovalId(message: string): string | null {
  const match = message.match(
    /X-Cordon-Approval-Id:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
  );
  return match?.[1] ?? null;
}

function parseRetryAfter(message: string): number {
  const match = message.match(/Retry after (\d+)s/);
  return match ? Number(match[1]) : 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
