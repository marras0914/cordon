import json
import uuid
import yaml
import httpx
import os
from contextlib import asynccontextmanager
from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse, JSONResponse

import db
import pii
import ratelimit
import alerting
from dashboard import dashboard

REAL_MCP_SERVER = os.getenv("REAL_MCP_SERVER", "http://localhost:8001")
OPA_URL = os.getenv("CORDON_OPA_URL", "")   # e.g. http://opa:8181
POLICY_FILE = "policy.yaml"


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.init_db()
    yield


app = FastAPI(title="Cordon MCP Gateway", lifespan=lifespan)
app.mount("/dashboard", dashboard)


# ---------- policy evaluation ----------

def _yaml_policy(tool_name: str) -> tuple[str, str]:
    """Fallback: evaluate tool against policy.yaml."""
    with open(POLICY_FILE, "r") as f:
        config = yaml.safe_load(f)
    for rule in config.get("rules", []):
        if rule["tool"] == tool_name:
            return rule["action"], rule.get("reason", "")
    return config.get("default_action", "ALLOW"), ""


async def evaluate_policy(tool_name: str, arguments: dict,
                          client_ip: str = None) -> tuple[str, str]:
    """
    Evaluate policy for a tool call.
    Tries OPA first (if CORDON_OPA_URL is set), falls back to policy.yaml.
    Returns (action, reason).
    """
    if OPA_URL:
        try:
            async with httpx.AsyncClient() as client:
                resp = await client.post(
                    f"{OPA_URL}/v1/data/cordon/decision",
                    json={"input": {
                        "tool": tool_name,
                        "arguments": arguments,
                        "client_ip": client_ip,
                    }},
                    timeout=2.0,
                )
            result = resp.json().get("result", {})
            return result.get("action", "ALLOW"), result.get("reason", "")
        except Exception as exc:
            print(f"[CORDON] OPA unreachable ({exc}), falling back to policy.yaml")

    return _yaml_policy(tool_name)


# ---------- routes ----------

@app.get("/sse")
async def sse_proxy(request: Request):
    client = httpx.AsyncClient()

    async def event_generator():
        async with client.stream(
            "GET", f"{REAL_MCP_SERVER}/sse", headers=dict(request.headers)
        ) as response:
            async for line in response.aiter_lines():
                yield f"{line}\n"

    return StreamingResponse(event_generator(), media_type="text/event-stream")


async def _forward(request: Request, payload: dict, request_id):
    """Forward payload to the real MCP backend."""
    try:
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                f"{REAL_MCP_SERVER}/messages",
                params=request.query_params,
                json=payload,
            )
        return resp.json()
    except httpx.ConnectError:
        return JSONResponse(status_code=502, content={
            "jsonrpc": "2.0",
            "id": request_id,
            "error": {"code": -32003,
                      "message": f"Cordon: backend unreachable at {REAL_MCP_SERVER}"},
        })


@app.post("/messages")
async def message_interceptor(request: Request):
    payload = await request.json()
    method = payload.get("method", "unknown")
    request_id = payload.get("id")
    client_ip = request.client.host if request.client else None

    if method == "tools/call":
        tool_name = payload.get("params", {}).get("name")
        raw_arguments = payload.get("params", {}).get("arguments", {})
        safe_arguments = pii.redact(raw_arguments)   # redacted copy for storage

        # Rate limit check (per client IP)
        allowed, retry_after = ratelimit.check(client_ip or "unknown")
        if not allowed:
            db.log_event(method=method, tool_name=tool_name, action="BLOCK",
                         reason="Rate limit exceeded", request_id=request_id,
                         client_ip=client_ip)
            alerting.on_block(tool_name, "Rate limit exceeded", client_ip)
            return {
                "jsonrpc": "2.0",
                "id": request_id,
                "error": {
                    "code": -32005,
                    "message": f"Cordon: rate limit exceeded. Retry after {retry_after}s.",
                },
            }

        action, reason = await evaluate_policy(tool_name, raw_arguments, client_ip)
        print(f"[CORDON] {tool_name} -> {action}")

        if action == "BLOCK":
            db.log_event(method=method, tool_name=tool_name, action="BLOCK",
                         reason=reason, request_id=request_id, client_ip=client_ip)
            alerting.on_block(tool_name, reason, client_ip)
            return {
                "jsonrpc": "2.0",
                "id": request_id,
                "error": {"code": -32001,
                          "message": f"Cordon Policy Violation: {reason}"},
            }

        if action == "REQUIRE_APPROVAL":
            approval_id = request.headers.get("X-Cordon-Approval-Id")
            if approval_id:
                approval = db.get_approval(approval_id)
                if approval and approval["status"] == "APPROVED":
                    db.log_event(method=method, tool_name=tool_name, action="ALLOW",
                                 reason="Human approved", request_id=request_id,
                                 client_ip=client_ip)
                    return await _forward(request, payload, request_id)

                if approval and approval["status"] == "REJECTED":
                    db.log_event(method=method, tool_name=tool_name, action="BLOCK",
                                 reason="Human rejected", request_id=request_id,
                                 client_ip=client_ip)
                    return {
                        "jsonrpc": "2.0",
                        "id": request_id,
                        "error": {"code": -32001,
                                  "message": "Request rejected by human operator."},
                    }

                if approval and approval["status"] == "PENDING":
                    return {
                        "jsonrpc": "2.0",
                        "id": request_id,
                        "error": {
                            "code": -32002,
                            "message": f"Approval required. Retry with header "
                                       f"X-Cordon-Approval-Id: {approval_id}",
                        },
                    }

            # Queue for human review — store redacted arguments
            aid = str(uuid.uuid4())
            db.queue_approval(aid, tool_name, json.dumps(safe_arguments),
                              request_id, client_ip)
            db.log_event(method=method, tool_name=tool_name, action="REQUIRE_APPROVAL",
                         reason=reason, request_id=request_id, client_ip=client_ip)
            alerting.on_approval_queued(tool_name, db.pending_approval_count())
            return {
                "jsonrpc": "2.0",
                "id": request_id,
                "error": {
                    "code": -32002,
                    "message": f"Approval required. Retry with header "
                               f"X-Cordon-Approval-Id: {aid}",
                },
            }

    return await _forward(request, payload, request_id)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
