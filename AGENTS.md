# Repository Guidelines

## Project Structure & Module Organization
- `src/` contains runtime code.
- `src/index.ts` defines the Hono app and HTTP routes.
- `src/db/` contains Drizzle DB client and schema definitions.
- `src/redis/` contains Redis client setup.
- `test/` contains integration-style tests (currently `websocket-real-env.test.ts`).
- `drizzle/` stores generated SQL migrations; `drizzle.config.ts` configures migration tooling.
- `docker/` and `docker-compose.yml` define local infrastructure (Postgres + Redis).

## Build, Test, and Development Commands
- `bun install`: install dependencies.
- `cp .env.example .env`: create local environment config.
- `bun run dev`: run the app with hot reload.
- `bun run start`: run the app without hot reload.
- `bun run test`: run the full Bun test suite.
- `bun run test:real-env`: run the Testcontainers-backed environment test.
- `bun run start:infra`: start Postgres and Redis via Docker Compose.
- `bun run db:generate` and `bun run db:migrate`: generate and apply Drizzle migrations.

## Coding Style & Naming Conventions
- Language: TypeScript with strict mode enabled (`tsconfig.json`).
- Use 2-space indentation and semicolon-free style, matching current files.
- Prefer named exports for modules and colocate related logic (for example, DB code under `src/db/`).
- Naming: files use lowercase domain names (`client.ts`, `schema.ts`).
- Naming: variables/functions use `camelCase`.
- Naming: types/interfaces use `PascalCase`.
- Naming: database columns/tables use `snake_case` via Drizzle builders.

## Testing Guidelines
- Framework: Bun test runner (`bun:test`).
- Keep tests deterministic and isolated; clean up containers/connections in `afterAll`.
- Name tests by behavior (for example, `connects to postgres`).
- Add tests in `test/*.test.ts`; group related cases with `describe()` blocks.

## Commit & Pull Request Guidelines
- Current history is minimal (`init`), so adopt a consistent style now.
- Recommended commit format: `type(scope): imperative summary` (for example, `feat(db): add sessions index`).
- Keep commits focused; include schema + migration changes together.
- PRs should include a short problem/solution summary.
- PRs should include a linked issue/task when available.
- PRs should include test evidence (`bun run test`, relevant command output).
- PRs should include API examples when route behavior changes (request/response snippets).

## Security & Configuration Tips
- Never commit secrets; keep real values only in `.env`.
- Validate required env vars through `src/env.ts` before starting services.
- For local infra changes, prefer updating `docker-compose.yml` over ad hoc container commands.
