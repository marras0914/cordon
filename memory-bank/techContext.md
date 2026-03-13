# Tech Context

## Stack

| Layer | Choice | Reason |
|---|---|---|
| Language | TypeScript (ESM only) | Type safety for the config SDK; same ecosystem as MCP |
| Monorepo | npm workspaces + Turborepo | Respects build order (sdk → core → cli) |
| Bundler | tsup | Fast, zero-config, handles DTS generation |
| MCP SDK | `@modelcontextprotocol/sdk` v1.11.x | Stable v1 — v2 alpha splits packages, not yet stable |
| Config loader | `jiti` | Runs user's `cordon.config.ts` at runtime without compile step |
| CLI framework | `commander` | Lightweight, well-maintained |
| Linter/formatter | Biome | Fast, replaces ESLint + Prettier |
| Tests | vitest (stubbed) | Fast unit testing — integration tests use tsx directly |

## Key SDK Details

**Low-level `Server` class** (not `McpServer`) is used in `@cordon/core` because we proxy JSON Schema directly — we don't want Zod transformation.

**`client.callTool()` return type** is a union — includes `CompatibilityCallToolResultSchema` which has `toolResult` instead of `content`. Never annotate the return type as `CallToolResult`. Use:
```typescript
type ToolCallResponse = Awaited<ReturnType<Client['callTool']>>;
```

**`transport.stderr`** is null until after `client.connect()`. Always pipe after connect:
```typescript
await client.connect(transport);
transport.stderr?.pipe(process.stderr);
```

## Development Setup

```bash
# From repo root
npm install
npm run build   # builds sdk → core → cli in order
npm run dev     # watch mode

# Run integration test
cd examples/security-showcase
npx tsx block-test.ts   # should print: All tests passed.

# Run interactive demo
npm run demo            # type A/D when approval prompt appears
```

## Package Names

| Package | npm name | Status |
|---|---|---|
| SDK | `cordon-sdk` | Published 0.1.0 (placeholder), 0.1.1 ready locally |
| Core | `@cordon/core` | Unpublished — needs npm org or rename to `cordon-core` |
| CLI | `cordon-cli` | Unpublished, name available |

npm user: `marras0914`
GitHub: `github.com/marras0914/cordon`

## Publishing Checklist

```bash
npm login                   # token is expired/restricted — do this first
# If using @cordon/ scope: create npm org at npmjs.com/org/create first

cd packages/sdk  && npm run build && npm publish --access public
cd packages/core && npm run build && npm publish --access public
cd packages/cli  && npm run build && npm publish --access public
```

## Known Gotchas

- `workspace:*` is pnpm/yarn syntax — use `"*"` for local workspace deps in npm
- `packageManager` field in root `package.json` is required for Turborepo to detect npm workspaces
- tsup `banner` option must be a string, not a function — use array of configs to add shebang only to binary entry
- On Windows, tty input for approvals uses `\\.\CONIN$` not `/dev/tty`
