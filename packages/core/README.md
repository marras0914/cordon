# @getcordon/core

Core proxy engine for [Cordon](https://github.com/marras0914/cordon), the security gateway for MCP tool calls.

Most users won't install this directly — it's a dependency of `cordon-cli`. Install this package when you want to embed Cordon programmatically rather than run it via the CLI.

## Install

```bash
npm install @getcordon/core cordon-sdk
```

## Programmatic usage

```typescript
import { CordonGateway } from '@getcordon/core';
import type { ResolvedConfig } from 'cordon-sdk';

const config: ResolvedConfig = {
  servers: [
    {
      name: 'database',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-postgres', process.env.POSTGRES_URL!],
      policy: 'read-only',
    },
  ],
  audit: { enabled: true, output: 'stdout' },
  approvals: { channel: 'terminal' },
};

const gateway = new CordonGateway(config);
await gateway.start();
// ... on shutdown:
await gateway.stop();
```

## What's included

- **UpstreamManager** — manages child-process MCP servers, aggregates their tool registries, filters unknown tools against per-server `knownTools` catalogs
- **PolicyEngine** — evaluates policies per tool call (allow / block / approve / approve-writes / read-only / log-only / hidden); includes write-detection heuristic for `read-only` and `approve-writes`; `isHidden()` query for the gateway's tools/list filter
- **Interceptor** — the hot path; every tool call flows through policy check + rate limit + audit log
- **ApprovalManager** — routes approvals to terminal or Slack channels
- **AuditLogger** — structured JSON logging to stdout, file, or hosted endpoint
- **RateLimiter** — sliding-window counters at global, per-server, and per-tool granularities

## Full documentation

Architecture overview, policy reference, approval flow, and audit format:
**https://github.com/marras0914/cordon**

## License

MIT
