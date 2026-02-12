# Maid

Maid is a Bun + Hono backend with PostgreSQL (`pgvector`) and Redis.  
It stores chat sessions/messages and extracts long-term user memories through a debounced BullMQ worker.

## Requirements

- Bun
- Docker (for local infra and e2e tests)
- OpenAI API key (streaming response path)
- Ollama running locally or reachable by URL (generation + embeddings)

## Quick Start

```sh
bun install
cp .env.example .env
bun run dev:infra
bun run db:migrate
bun run dev
```

App default URL: `http://localhost:3000`

## Environment Variables

See `.env.example` for defaults. Required at runtime:

- `DATABASE_URL`
- `REDIS_URL`
- `BETTER_AUTH_URL`
- `AUTH_ORIGIN`
- `OPENAI_API_KEY`
- `OPENAI_RESPONSE_MODEL`
- `OLLAMA_BASE_URL`
- `OLLAMA_GENERATE_MODEL`
- `OLLAMA_EMBEDDING_MODEL`
- `PORT` (optional, defaults to `3000`)

## Scripts

- `bun run dev:infra`: start local Postgres + Redis with Docker Compose
- `bun run dev`: run app with hot reload
- `bun run start`: run app without hot reload
- `bun run db:generate`: generate Drizzle migration files
- `bun run db:migrate`: apply migrations (also ensures `vector` extension)
- `bun run test:unit`: run unit tests in `test/unit`
- `bun run test:e2e`: run e2e tests in `test/e2e` (Docker required)

## HTTP Routes

- `GET /`: basic service response
- `GET /db/health`: PostgreSQL health check
- `GET /redis/health`: Redis health check
- `GET /stream/:maid`: auth-protected streaming endpoint scaffold (`Bearer` token; Better Auth session lookup)

## Local Infra With Compose

`docker-compose.yml` includes:

- `postgres` (`pgvector/pgvector:pg18`)
- `redis` (`redis:alpine`)
- `migrator` (runs DB migrations)
- `app` (starts service after infra + migration are healthy)

Run full stack:

```sh
docker compose up --build
```

## Project Layout

- `src/index.ts`: app wiring, auth middleware, route definitions, shutdown handling
- `src/db/schema.ts`: Drizzle schema (`sessions`, `messages`, `memories`)
- `src/session.ts`: session/message persistence service
- `src/memory/`: memory extraction, prompts, queue orchestration
- `src/llm.ts`: OpenAI/Ollama integrations
- `src/queue.ts`: reusable BullMQ queue wrapper
- `test/unit`: service-level unit tests
- `test/e2e`: Testcontainers-based e2e tests
