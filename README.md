To install dependencies:
```sh
bun install
```

Create env file:
```sh
cp .env.example .env
```

Generate and run migrations:
```sh
bun run db:generate
bun run db:migrate
```

To run:
```sh
bun run dev
```

open http://localhost:3000

DB health endpoint:
`GET /db/health`

Redis health endpoint:
`GET /redis/health`

Run with Docker Compose:
```sh
docker compose up --build
```
