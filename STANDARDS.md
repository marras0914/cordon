# Project Standards

Living document. These apply to all new projects and any significant refactors.
When in doubt, check here first.

---

## Runtime & tooling

| Tool | Choice | Notes |
|---|---|---|
| Runtime | **Bun** | TypeScript-native, no compile step in dev, fast |
| Package manager | **Bun** | `bun install`, `bun add` — no npm/yarn/pnpm |
| Lint + format | **Biome** | Single tool, no ESLint + Prettier split |
| Build (libraries) | **tsup** | ESM + CJS + `.d.ts` output |
| Testing | **Vitest** | Fast, Jest-compatible, works with Node and Bun |
| Node compat target | ES2022 | Safe for LTS Node if Bun is unavailable |

## TypeScript

- `strict: true` always — no exceptions
- `exactOptionalPropertyTypes: true` — no silent `| undefined` widening
- `noUncheckedIndexedAccess: true` — array/object access returns `T | undefined`
- `verbatimModuleSyntax: true` — explicit `import type` for types
- No `any` — use `unknown` + type guard or `satisfies`
- Prefer `type` over `interface` unless declaration merging is needed
- Zod for all external input validation (API bodies, env vars, config files)

## Project structure

```
my-project/
  src/
    index.ts          # public entry point — re-exports only
    <module>.ts       # one concern per file
    <module>.test.ts  # co-located tests for unit tests
  test/
    integration/      # integration tests that need a running server
  dist/               # build output — never committed
  package.json
  tsconfig.json       # extends ../../tsconfig.base.json
  README.md
```

## Naming conventions

| Thing | Convention | Example |
|---|---|---|
| Files | `kebab-case.ts` | `rate-limit.ts` |
| Variables / functions | `camelCase` | `checkRateLimit` |
| Types / interfaces | `PascalCase` | `PolicyResult` |
| Constants | `SCREAMING_SNAKE` for module-level, `camelCase` for local | `OPA_URL`, `defaultAction` |
| Env vars | `SCREAMING_SNAKE` with project prefix | `CORDON_RATE_LIMIT` |

## Git

- **Conventional commits** — enforced in CI
  - `feat:` new feature
  - `fix:` bug fix
  - `chore:` tooling, deps, config
  - `docs:` documentation only
  - `test:` tests only
  - `refactor:` no behaviour change
  - Breaking: append `!` — `feat!: rename API`
- **Branch strategy:** `main` is always deployable. Feature branches off main, squash-merge via PR.
- **No force push to main** — ever.

## HTTP APIs

- JSON in, JSON out
- Errors always return `{ error: { code, message } }` — never raw strings
- 4xx for client errors, 5xx for server errors
- Use Hono for new HTTP services

## Environment variables

- All env vars declared in `.env.example` with comments
- Parsed and validated at startup with Zod — fail fast on missing required vars
- Never read `process.env` outside of the config module

## Testing

- Every module has tests
- Unit tests co-located with source (`module.test.ts`)
- Integration tests in `test/integration/`
- No test helpers that use real network or filesystem by default — mock at the boundary
- Coverage is not a goal — behaviour coverage is

## Dependencies

- Minimise. Every dep is a supply chain risk.
- Prefer built-ins (Bun APIs, Web APIs) over npm packages
- Pin major versions in `package.json` — use `^` for minor/patch
- Run `bun audit` before releases

## Documentation

- `README.md` in every package — quick start + env var table
- `ARCHITECTURE.md` for non-trivial systems
- JSDoc on exported public API only — not on internals
- No inline comments that restate the code — only explain *why*

---

## Applied to: Cordon

| Concern | Implementation |
|---|---|
| Framework | Hono |
| DB | Drizzle ORM — `bun:sqlite` (dev) / `postgres` (prod) |
| Auth | `jose` (JWT/JWKS) + `iron-session` (cookies) |
| Config validation | Zod |
| PII | Custom regex module |
| Policy | YAML (`js-yaml`) + OPA HTTP client |
