# Repository Guidelines

## Project Structure & Module Organization
- `src/` contains runtime code.
- `src/index.ts` defines the Hono app, auth middleware, health routes, and graceful shutdown.
- `src/db/schema.ts` defines Drizzle tables/enums (`sessions`, `messages`, `memories`).
- `src/session.ts` contains session/message persistence service logic.
- `src/memory/` contains memory extraction logic, queue orchestration, and prompting.
- `src/llm.ts` contains OpenAI/Ollama integration helpers.
- `src/queue.ts` contains reusable BullMQ queue setup.
- `test/unit/` contains isolated unit tests for services.
- `test/e2e/` contains Testcontainers-backed end-to-end tests.
- `drizzle/` stores generated SQL migrations; `drizzle.config.ts` configures migration tooling.
- `scripts/migrate.ts` applies migrations and ensures `pgvector` extension availability.
- `docker/` and `docker-compose.yml` define local infrastructure (Postgres + Redis + migrator/app services).

## Build, Test, and Development Commands
- `bun install`: install dependencies.
- `cp .env.example .env`: create local environment config.
- `bun run dev:infra`: start Postgres and Redis with Docker Compose.
- `bun run dev`: run the app with hot reload.
- `bun run start`: run the app without hot reload.
- `bun run test:unit`: run unit tests from `test/unit`.
- `bun run test:e2e`: run e2e tests from `test/e2e` (Docker required).
- `bun run db:generate`: generate Drizzle migrations.
- `bun run db:migrate`: apply Drizzle migrations.

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
- Add unit tests under `test/unit/*.test.ts` and e2e tests under `test/e2e/*.test.ts`.
- Group related cases with `describe()` blocks.
- Unit policy: mock external providers where appropriate (for example `src/llm` in service unit tests).
- E2E policy: use real infrastructure via Testcontainers (Postgres + Redis).
- E2E policy: clean DB/queue state in `beforeEach` to avoid cross-test contamination.
- E2E policy: tests that exercise extraction rely on configured LLM providers from `.env`.

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
- Keep `DATABASE_URL` and `REDIS_URL` aligned with how services are addressed in the active environment (host vs Compose network).
