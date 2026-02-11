# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
bun install                  # Install dependencies
bun run dev                  # Run with hot reload
bun run start                # Run without hot reload
bun run start:infra          # Start Postgres + Redis via Docker Compose
bun run db:generate          # Generate Drizzle migrations
bun run db:migrate           # Apply migrations
bun test                     # Run all tests
bun test test/<file>.test.ts # Run a single test file
bun run test:real-env        # Integration tests with Testcontainers
bun run test:unit            # Unit tests
```

Setup: `cp .env.example .env` then `bun run start:infra` for local Postgres/Redis.

## Architecture

Maid is a WebSocket-based chat service with auth, session management, and AI assistant capabilities. Built on **Bun** runtime with **Hono** framework.

- **`src/index.ts`** — Hono app entry point: HTTP routes, middleware, WebSocket upgrade at `/stream`
- **`src/maid/index.ts`** — WebSocket handler logic via `getWebsocketHandler()` factory (takes `HandlerDeps` with db/redis)
- **`src/llm.ts`** — LLM clients (OpenAI + Ollama) and helper functions
- **`src/db/schema.ts`** — Drizzle ORM schema: `sessions`, `messages`, `memories` tables with JSONB metadata
- **`src/env.ts`** — Environment variable validation (fails fast on missing vars)
- **`drizzle/`** — Generated SQL migrations (committed to repo)

Key infrastructure: PostgreSQL 18 with pgvector extension, Redis 7. Auth via Better Auth with bearer token / WebSocket query param token.

## LLM API Rules

- Always use single-prompt generate/response APIs, not multi-turn chat APIs
  - OpenAI: use `client.responses.create()` (Responses API), not `client.chat.completions.create()`
  - Ollama: use `ollama.generate()`, not `ollama.chat()`

## Code Style

- TypeScript strict mode, 2-space indent, no semicolons
- Named exports, domain-based file organization (`src/db/`, `src/maid/`)
- Files: lowercase (`schema.ts`). Variables/functions: `camelCase`. Types: `PascalCase`. DB columns/tables: `snake_case`

## Testing

- Bun test runner (`bun:test`). Tests in `test/*.test.ts`
- Integration tests use Testcontainers (real Postgres/Redis containers, 120s startup timeout)
- Clean up containers/connections in `afterAll`

## Commits

Format: `type(scope): imperative summary` (e.g., `feat(db): add sessions index`). Include schema + migration changes together.
