import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { config } from "./config.ts";
import * as db from "./db.ts";
import * as policy from "./policy.ts";
import * as pii from "./pii.ts";
import * as rateLimit from "./rate-limit.ts";
import * as alerting from "./alerting.ts";

export const proxy = new Hono();

// ---------- SSE stream ----------

proxy.get("/sse", async (c) => {
  const upstream = await fetch(`${config.REAL_MCP_SERVER}/sse`, {
    headers: Object.fromEntries(
      [...c.req.raw.headers.entries()].filter(([k]) => k !== "host")
    ),
  });

  return new Response(upstream.body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
    },
  });
});

// ---------- message interceptor ----------

proxy.post("/messages", async (c) => {
  const payload = await c.req.json<{
    jsonrpc: string;
    id?: string | number;
    method?: string;
    params?: { name?: string; arguments?: Record<string, unknown> };
  }>();

  const method = payload.method ?? "unknown";
  const requestId = payload.id;
  const clientIp = c.req.header("x-forwarded-for") ?? c.env?.["REMOTE_ADDR"] ?? null;

  if (method === "tools/call") {
    const toolName = payload.params?.name ?? "";
    const rawArgs = payload.params?.arguments ?? {};
    const safeArgs = pii.redact(rawArgs) as Record<string, unknown>;

    // Rate limit
    const { allowed, retryAfter } = rateLimit.check(clientIp ?? "unknown");
    if (!allowed) {
      await db.logEvent({ method, action: "BLOCK", toolName, reason: "Rate limit exceeded", requestId, clientIp });
      alerting.onBlock(toolName, "Rate limit exceeded", clientIp);
      return c.json({
        jsonrpc: "2.0", id: requestId,
        error: { code: -32005, message: `Cordon: rate limit exceeded. Retry after ${retryAfter}s.` },
      });
    }

    const { action, reason } = await policy.evaluatePolicy(toolName, rawArgs, clientIp);
    console.log(`[CORDON] ${toolName} -> ${action}`);

    if (action === "BLOCK") {
      await db.logEvent({ method, action: "BLOCK", toolName, reason, requestId, clientIp });
      alerting.onBlock(toolName, reason, clientIp);
      return c.json({
        jsonrpc: "2.0", id: requestId,
        error: { code: -32001, message: `Cordon Policy Violation: ${reason}` },
      });
    }

    if (action === "ALLOW") {
      await db.logEvent({ method, action: "ALLOW", toolName, reason, requestId, clientIp });
      return forward(payload, requestId);
    }

    if (action === "REQUIRE_APPROVAL") {
      const approvalId = c.req.header("x-cordon-approval-id");

      if (approvalId) {
        const approval = await db.getApproval(approvalId);

        if (approval?.status === "APPROVED") {
          await db.logEvent({ method, action: "ALLOW", toolName, reason: "Human approved", requestId, clientIp });
          return forward(c, payload, requestId);
        }
        if (approval?.status === "REJECTED") {
          await db.logEvent({ method, action: "BLOCK", toolName, reason: "Human rejected", requestId, clientIp });
          return c.json({
            jsonrpc: "2.0", id: requestId,
            error: { code: -32001, message: "Request rejected by human operator." },
          });
        }
        if (approval?.status === "PENDING") {
          return c.json({
            jsonrpc: "2.0", id: requestId,
            error: { code: -32002, message: `Approval required. Retry with header X-Cordon-Approval-Id: ${approvalId}` },
          });
        }
      }

      const aid = crypto.randomUUID();
      await db.queueApproval({ id: aid, toolName, arguments: JSON.stringify(safeArgs), requestId, clientIp });
      await db.logEvent({ method, action: "REQUIRE_APPROVAL", toolName, reason, requestId, clientIp });
      alerting.onApprovalQueued(toolName, await db.pendingApprovalCount());

      return c.json({
        jsonrpc: "2.0", id: requestId,
        error: { code: -32002, message: `Approval required. Retry with header X-Cordon-Approval-Id: ${aid}` },
      });
    }
  }

  return forward(c, payload, requestId);
});

// ---------- forward ----------

async function forward(payload: unknown, requestId: string | number | undefined): Promise<Response> {
  try {
    const upstream = await fetch(`${config.REAL_MCP_SERVER}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { "Content-Type": "application/json" },
    });
  } catch {
    return Response.json({
      jsonrpc: "2.0", id: requestId,
      error: { code: -32003, message: `Cordon: backend unreachable at ${config.REAL_MCP_SERVER}` },
    }, { status: 502 });
  }
}
