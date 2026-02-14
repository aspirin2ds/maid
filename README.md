# Maid

Maid is a Bun backend (`Bun.serve` + native WebSocket) with PostgreSQL (`pgvector`) and Redis.  
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

Optional tuning vars (all have defaults):

- `OLLAMA_KEEP_ALIVE`
- `APP_SHUTDOWN_TIMEOUT_MS`
- `LOGGER_FILE`
- `LOGGER_FILE_SIZE`
- `MEMORY_QUEUE_NAME`
- `MEMORY_QUEUE_JOB_NAME`
- `MEMORY_QUEUE_DEBOUNCE_DELAY_MS`
- `MEMORY_QUEUE_ATTEMPTS`
- `MEMORY_QUEUE_BACKOFF_DELAY_MS`
- `MEMORY_QUEUE_WORKER_CONCURRENCY`
- `MEMORY_SERVICE_DEFAULT_LIMIT`
- `MEMORY_SERVICE_DEFAULT_THRESHOLD`
- `MEMORY_EXTRACTION_THRESHOLD`
- `MEMORY_EXTRACTION_TOP_K`
- `MEMORY_EXTRACTION_RETRIES`
- `MIGRATIONS_TIMEOUT_MS`
- `MIGRATIONS_RETRY_DELAY_MS`
- `MIGRATIONS_FOLDER`

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

- `src/index.ts`: Bun server wiring, auth checks, route definitions, shutdown handling
- `src/db/schema.ts`: Drizzle schema (`sessions`, `messages`, `memories`)
- `src/session.ts`: session/message persistence service
- `src/memory/`: memory extraction, prompts, queue orchestration
- `src/llm.ts`: OpenAI/Ollama integrations
- `src/queue.ts`: reusable BullMQ queue wrapper
- `test/unit`: service-level unit tests
- `test/e2e`: Testcontainers-based e2e tests
