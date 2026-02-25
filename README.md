# Cloudflare Task Manager

A full-stack task management application built on Cloudflare Workers, D1, KV,and Workers AI. Zero external dependencies — runs entirely on Cloudflare's developer platform.

**Live URL:** `https://cloudflare-task-manager.taskflow-akash.workers.dev`

---

## What It Does

Create and manage tasks with full lifecycle tracking (todo → in progress → done). Every task is automatically enriched by **Llama-3** running on Workers AI — generating a one-sentence summary and sentiment classification without any user wait time. Tags, filters, pagination, and a dark-themed UI are all included.

---

## UI Features

The frontend is a single `public/index.html` — 1,305 lines, zero dependencies, zero build step:

- **Auth** — Login / Register tabs, JWT stored in localStorage, session auto-restored on refresh
- **Task board** — Cards with status chips, priority badges, due dates, and tag chips
- **AI strip** — `ai_summary` and `ai_sentiment` appear on each card after Llama-3 enriches (colour-coded: green = positive, yellow = neutral, red = negative)
- **Sidebar filters** — All / Todo / In Progress / Done with live counts
- **Priority filter** dropdown
- **Stats bar** — Total / In Progress / Done / AI Enriched counts
- **Modals** — Create/Edit task (all fields), Manage tags with hex color palette picker
- **Pagination** — Prev/Next for multi-page results
- **Toast notifications** — Success/error feedback
- **Dark theme** — Cloudflare orange accent, DM Mono + Syne fonts

---

## Tech Stack

| Layer    | Technology                            | Why                                                   |
| -------- | ------------------------------------- | ----------------------------------------------------- |
| Runtime  | Cloudflare Workers (V8 isolate)       | Edge execution, zero cold start, globally distributed |
| Database | D1 (SQLite)                           | Relational data, FK constraints, composite indexes    |
| Cache    | KV Store                              | Per-user task cache + sliding-window rate limiting    |
| AI       | Workers AI — Llama-3-8b-instruct      | Task summarisation + sentiment, no external API key   |
| Frontend | Vanilla HTML/JS — `public/index.html` | Zero build step, served as Workers static asset       |
| Auth     | JWT (jose) + PBKDF2-SHA256            | Web Crypto only — no Node.js crypto dependency        |
| Language | TypeScript strict mode                | No `any`, Readonly types, discriminated unions        |

---

## Project Structure

```
cloudflare-task-manager/
├── public/
│   └── index.html              ← Full UI — 1,305 lines, zero dependencies
├── src/
│   ├── index.ts                ← Worker entry point: 5-step request pipeline
│   ├── controllers/            ← HTTP layer: parse → validate → call service → respond
│   │   ├── auth.controller.ts
│   │   ├── task.controller.ts
│   │   └── tag.controller.ts
│   ├── services/               ← Business logic, caching, AI enrichment
│   │   ├── auth.service.ts
│   │   ├── task.service.ts
│   │   └── tag.service.ts
│   ├── repositories/           ← Data layer: SQL only, parameterised queries, row mapping
│   │   ├── user.repository.ts
│   │   ├── task.repository.ts
│   │   └── tag.repository.ts
│   ├── middleware/
│   │   ├── auth.middleware.ts  ← JWT verification → typed AuthContext
│   │   ├── security.ts         ← Security headers, CORS, rate limiting, WAF
│   │   ├── logger.ts           ← Structured JSON logging with CF-Ray + timing
│   │   └── error-handler.ts   ← AppError class + global error boundary
│   ├── routes/
│   │   └── index.ts            ← Clean router — no if-chain anti-pattern
│   ├── types/                  ← Strict TypeScript interfaces, no any
│   ├── utils/
│   │   ├── jwt.ts              ← PBKDF2 hashing + JWT sign/verify
│   │   ├── response.ts         ← Typed API envelope: ok(), created(), badRequest()...
│   │   └── validation.ts       ← Central validation, ValidationResult<T> pattern
│   └── db/
│       ├── schema.sql          ← 4 tables, 8 indexes, CHECK constraints
│       └── seed.sql            ← Dev test data (2 users, 4 tags, 8 tasks)
├── test/
│   └── index.spec.ts           ← 35 integration tests (vitest-pool-workers)
├── wrangler.jsonc              ← Production config (DB + KV + AI + Assets)
├── wrangler.test.jsonc         ← Test config (no AI binding — Miniflare limitation)
└── vitest.config.mts           ← Points at wrangler.test.jsonc for local tests
```

---

## Prerequisites

- Node.js 18+
- Cloudflare account (free tier works)
- Wrangler CLI: `npm install -g wrangler`

---

## Local Setup

### 1. Clone and install

```bash
git clone https://github.com/<your-username>/cloudflare-task-manager.git
cd cloudflare-task-manager
npm install
```

### 2. Authenticate with Cloudflare

```bash
npx wrangler login
```

### 3. Create D1 database

```bash
npx wrangler d1 create task-manager-db
```

Copy the `database_id` from the output into **both** `wrangler.jsonc` and `wrangler.test.jsonc`:

```jsonc
"d1_databases": [{ "binding": "DB", "database_name": "task-manager-db", "database_id": "YOUR-ID-HERE" }]
```

### 4. Create KV namespace

```bash
npx wrangler kv namespace create CACHE
```

Copy the `id` into **both** `wrangler.jsonc` and `wrangler.test.jsonc`:

```jsonc
"kv_namespaces": [{ "binding": "CACHE", "id": "YOUR-KV-ID-HERE" }]
```

### 5. Create `.dev.vars` for local secrets

```
JWT_SECRET=your-secret-minimum-32-characters-long
ENVIRONMENT=development
```

Generate a secure value — Windows PowerShell:

```powershell
-join ((1..32) | ForEach-Object { '{0:x}' -f (Get-Random -Max 16) })
```

Mac/Linux:

```bash
openssl rand -hex 32
```

### 6. Apply schema locally

```bash
npm run db:migrate:local
```

### 7. Seed test data (optional)

```bash
npx wrangler d1 execute task-manager-db --local --file=src/db/seed.sql
```

### 8. Start dev server

```bash
npm run dev
# → http://localhost:8787  (UI + API on the same origin)
```

Open `http://localhost:8787` — the full UI loads. Register an account, create tasks, and watch AI summaries appear on cards after ~1–2 seconds.

---

## API Reference

**Base URL (local):** `http://localhost:8787`

All responses use a consistent envelope:

```json
{ "success": true,  "data": { ... } }
{ "success": false, "error": { "code": "ERROR_CODE", "message": "..." } }
```

Protected routes require: `Authorization: Bearer <token>`

---

### Auth

#### `POST /auth/register`

Create a new account.

```bash
curl -X POST http://localhost:8787/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"alice@example.com","name":"Alice","password":"password123"}'
```

**Response 201:**

```json
{
	"success": true,
	"data": {
		"token": "eyJhbGc...",
		"user": { "id": 1, "email": "alice@example.com", "name": "Alice", "created_at": "...", "updated_at": "..." }
	}
}
```

**Validation errors:**

- `400` — email missing or invalid format
- `400` — name missing
- `400` — password under 8 characters
- `409` — email already registered

---

#### `POST /auth/login`

Sign in and get a token.

```bash
curl -X POST http://localhost:8787/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"alice@example.com","password":"password123"}'
```

**Response 200:**

```json
{
	"success": true,
	"data": {
		"token": "eyJhbGc...",
		"user": { "id": 1, "email": "alice@example.com", "name": "Alice" }
	}
}
```

**Errors:** `401` for wrong email or password (same error — prevents user enumeration)

---

#### `GET /auth/me` 🔒

Get the current user's profile.

```bash
curl http://localhost:8787/auth/me \
  -H "Authorization: Bearer <token>"
```

---

Validation: email format required, name required, password minimum 8 characters. Duplicate email returns `409`. Wrong credentials return `401` with identical message whether email or password is wrong (prevents user enumeration).

---

### Tasks

#### `GET /tasks` 🔒

List all tasks for the authenticated user. Supports filtering and pagination.

```bash
# All tasks
curl http://localhost:8787/tasks -H "Authorization: Bearer <token>"

# Filter by status
curl "http://localhost:8787/tasks?status=in_progress" -H "Authorization: Bearer <token>"

# Filter by priority
curl "http://localhost:8787/tasks?priority=high" -H "Authorization: Bearer <token>"

# Search by title
curl "http://localhost:8787/tasks?search=deploy" -H "Authorization: Bearer <token>"

# Tasks due before a date
curl "http://localhost:8787/tasks?due_before=2026-03-31" -H "Authorization: Bearer <token>"

# Pagination
curl "http://localhost:8787/tasks?page=2&limit=10" -H "Authorization: Bearer <token>"

# Combined filters
curl "http://localhost:8787/tasks?status=todo&priority=critical&page=1&limit=5" -H "Authorization: Bearer <token>"
```

**Query parameters:**

| Param        | Values                                  | Default |
| ------------ | --------------------------------------- | ------- |
| `status`     | `todo` `in_progress` `done` `cancelled` | all     |
| `priority`   | `low` `medium` `high` `critical`        | all     |
| `search`     | any string                              | none    |
| `due_before` | `YYYY-MM-DD`                            | none    |
| `page`       | integer ≥ 1                             | `1`     |
| `limit`      | 1–100                                   | `20`    |

**Response 200:**

```json
{
	"success": true,
	"data": [
		{
			"id": 3,
			"user_id": 1,
			"title": "Build task CRUD API",
			"description": "GET, POST, PATCH, DELETE endpoints",
			"status": "in_progress",
			"priority": "high",
			"due_date": "2026-03-01",
			"completed_at": null,
			"ai_summary": "Implementing RESTful task management endpoints",
			"ai_sentiment": "positive",
			"tags": [{ "id": 1, "name": "work", "color": "#6366f1" }],
			"created_at": "2026-02-23T10:00:00Z",
			"updated_at": "2026-02-23T10:00:00Z"
		}
	],
	"meta": { "page": 1, "limit": 20, "total": 6, "hasMore": false }
}
```

---

#### `GET /tasks/:id` 🔒

Get a single task by ID.

```bash
curl http://localhost:8787/tasks/3 -H "Authorization: Bearer <token>"
```

**Errors:** `404` if task not found or belongs to another user

---

#### `POST /tasks` 🔒

Create a new task.

```bash
curl -X POST http://localhost:8787/tasks \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Deploy to production",
    "description": "Run wrangler deploy and set production secrets",
    "priority": "critical",
    "status": "todo",
    "due_date": "2026-03-20",
    "tag_ids": [1, 3]
  }'
```

**Fields:**

| Field         | Required | Type     | Values                                                    |
| ------------- | -------- | -------- | --------------------------------------------------------- |
| `title`       | ✅       | string   | max 255 chars                                             |
| `description` | ❌       | string   | max 5000 chars                                            |
| `status`      | ❌       | string   | `todo` `in_progress` `done` `cancelled` (default: `todo`) |
| `priority`    | ❌       | string   | `low` `medium` `high` `critical` (default: `medium`)      |
| `due_date`    | ❌       | string   | `YYYY-MM-DD`                                              |
| `tag_ids`     | ❌       | number[] | array of existing tag IDs                                 |

**Response 201:** Full task object with tags

> **Workers AI:** After returning 201, the Worker asynchronously sends the task to Llama-3 to generate `ai_summary` and `ai_sentiment`. These fields appear on subsequent GET requests (usually within 1–2 seconds).

---

#### `PATCH /tasks/:id` 🔒

Partially update a task. Only send the fields you want to change.

```bash
# Mark as done
curl -X PATCH http://localhost:8787/tasks/3 \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"status": "done"}'

# Change priority and due date
curl -X PATCH http://localhost:8787/tasks/3 \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"priority": "critical", "due_date": "2026-02-28"}'

# Update title and attach tags
curl -X PATCH http://localhost:8787/tasks/3 \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"title": "Updated title", "tag_ids": [1, 2]}'

# Clear description (set to null explicitly)
curl -X PATCH http://localhost:8787/tasks/3 \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"description": null}'
```

> When `status` changes to `done`, `completed_at` is automatically set. When moving away from `done`, `completed_at` is cleared.

**Errors:** `400` empty body, `404` task not found

---

#### `DELETE /tasks/:id` 🔒

Delete a task permanently.

```bash
curl -X DELETE http://localhost:8787/tasks/3 \
  -H "Authorization: Bearer <token>"
```

**Response 200:** `{ "success": true, "data": { "message": "Task 3 deleted successfully" } }`

**Partial update**

```bash
# Mark done — completed_at is auto-set by the DB
curl -X PATCH http://localhost:8787/tasks/1 \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"status":"done"}'

# Only update priority — other fields unchanged
curl -X PATCH http://localhost:8787/tasks/1 \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"priority":"high"}'
```

---

### Tags

#### `GET /tags` 🔒

List all tags created by the authenticated user.

```bash
curl http://localhost:8787/tags -H "Authorization: Bearer <token>"
```

#### `POST /tags` 🔒

Create a reusable tag.

```bash
curl -X POST http://localhost:8787/tags \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"name": "urgent", "color": "#ef4444"}'
```

| Field   | Required | Type                               |
| ------- | -------- | ---------------------------------- |
| `name`  | ✅       | string, max 50 chars               |
| `color` | ❌       | hex color e.g. `#6366f1` (default) |

**Errors:** `409` if tag name already exists for this user

#### `DELETE /tags/:id` 🔒

Delete a tag. Automatically removed from all tasks.

```bash
curl -X DELETE http://localhost:8787/tags/1 \
  -H "Authorization: Bearer <token>"
```

---

## Tests

```bash
npm test
```

39 integration tests run inside a real Workers V8 runtime via `@cloudflare/vitest-pool-workers`. The real `schema.sql` is loaded before each run via `?raw` import — no hardcoded schema in test files.

| Suite            | Tests |
| ---------------- | ----- |
| Health check     | 1     |
| Register         | 5     |
| Login            | 3     |
| Auth/Me          | 3     |
| Task Create      | 5     |
| Task Read        | 6     |
| Task Update      | 4     |
| Tags             | 6     |
| Security headers | 4     |
| Task Delete      | 2     |

---

## Deployment

### 1. Apply schema to remote D1

```bash
npm run db:migrate:remote
```

### 2. Set production secret

```bash
npx wrangler secret put JWT_SECRET
# Paste your generated secret at the prompt
```

### 3. Deploy

```bash
npm run deploy
```

Output: `Deployed to https://cloudflare-task-manager.<subdomain>.workers.dev`

Cloudflare automatically:

- Serves `public/index.html` at the root URL
- Routes `/auth/*`, `/tasks/*`, `/tags/*`, `/health` to the Worker
- Both UI and API on the same domain — no CORS issues at all

### 4. Push to GitHub

```bash
git add .
git commit -m "feat: full-stack task manager on Cloudflare Workers + D1 + KV + AI"
git push origin main
```

Update the Live URL at the top of this README with your actual `workers.dev` URL.

---

## Architecture

### Request pipeline

Every request passes through five ordered layers before reaching a controller:

```
Request arrives
  │
  ├─ WAF                 detectMaliciousInput()
  │                      Regex for SQLi (UNION SELECT, xp_, exec()),
  │                      XSS (<script>, javascript:, event handlers),
  │                      path traversal (../, %2e%2e)
  │                      → 403 if matched
  │
  ├─ CORS preflight      handleCors()
  │                      OPTIONS → 204 with Access-Control-* headers
  │                      Runs before rate limiter (browsers preflight all cross-origin requests)
  │
  ├─ Rate limiting       checkRateLimit()
  │                      KV counter keyed on CF-Connecting-IP (not spoofable)
  │                      60 req/min sliding window → 429 + Retry-After
  │
  ├─ Logging             logWithTiming()
  │                      Structured JSON: method, path, status, duration_ms, CF-Ray, country
  │
  ├─ Router              controller → service → repository
  │
  └─ Security headers    addSecurityHeaders()
                         Applied to every outgoing response (creates new Response — Workers responses are immutable)
```

### KV Store — two use cases

**Task cache (per-user isolation):**

```
Key pattern:  tasks:{userId}          list cache
              task:{userId}:{taskId}  item cache
TTL:          60 seconds
Invalidation: every write (create / update / delete)
Why per-user: a shared "all_tasks" key would mix users' data
```

**Rate limiting (sliding window):**

```
Key:   rl:{ip}
Value: request count
TTL:   60 seconds — auto-reset creates sliding window effect
Why KV: ~1ms reads vs ~5–10ms D1 round-trip for this hot path
```

### D1 schema

```sql
users     — email UNIQUE, PBKDF2 hash stored as "saltHex:hashHex"
tasks     — user_id FK + ON DELETE CASCADE
            status CHECK IN ('todo','in_progress','done','cancelled')
            priority CHECK IN ('low','medium','high','critical')
            ai_sentiment CHECK IN ('positive','neutral','negative') or NULL
tags      — UNIQUE(user_id, name) — per-user namespace
task_tags — composite PK (task_id, tag_id), CASCADE on both FKs
```

Eight composite indexes: `(user_id, status)`, `(user_id, priority)`, `(user_id, due_date)` keep filter queries fast regardless of table size.

### Password hashing

`bcryptjs` requires Node.js `crypto.pbkdf2()` which does not exist in the Workers V8 runtime. All hashing uses `crypto.subtle` (Web Crypto API — built into every Worker, no import needed):

```
Algorithm:   PBKDF2-SHA256
Iterations:  100,000
Salt:        16 bytes from crypto.getRandomValues() — unique per password
Storage:     "saltHex:hashHex" (self-contained string)
Timing:      verifyPassword() always runs even when user not found
             (uses a dummy hash) — prevents timing-based user enumeration
```

### Workers AI — how it works

```
POST /tasks  →  Worker returns 201 immediately (< 50ms)
                     │
                     └─ enrichWithAI() fires async (non-blocking)
                               │
                        Cloudflare AI Gateway
                               │
                        Nearest GPU datacenter
                        (Meta Llama-3-8b-instruct weights)
                               │
                        Prompt sent:
                        "Analyse this task. Respond ONLY with JSON:
                         {summary:'...max 100 chars',
                          sentiment:'positive|neutral|negative'}"
                               │
                        ~500ms–2s inference
                               │
                        Response handling:
                        - JSON extracted with regex (model sometimes adds text)
                        - sentiment validated against allowed values
                        - summary capped at 200 chars
                        - if env.AI is undefined (local/test) → skip gracefully
                               │
                        D1: UPDATE tasks SET ai_summary=?, ai_sentiment=?
                        KV: invalidate item cache
                               │
                        Next GET /tasks/:id returns enriched data
```

**Why non-blocking:** Inference takes 500ms–2s. Awaiting it inside the request handler would make every `POST /tasks` slow. Firing after response is sent keeps API latency under 100ms while AI fields appear on the next read — exactly how the UI polls for them.

### Security

| Layer            | Implementation                                                                                                                                                                                                                                                                                           |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth             | JWT HS256, 1h expiry, `jose` library, verified on every protected route                                                                                                                                                                                                                                  |
| Passwords        | PBKDF2-SHA256, 100k iterations, unique salt per user                                                                                                                                                                                                                                                     |
| User enumeration | Login always returns same 401 regardless of which field is wrong                                                                                                                                                                                                                                         |
| SQL injection    | All queries use D1 `.bind()` — zero string interpolation                                                                                                                                                                                                                                                 |
| LIKE injection   | `%` and `_` escaped in search input before query                                                                                                                                                                                                                                                         |
| Rate limiting    | 60 req/min/IP via KV, keyed on `CF-Connecting-IP`                                                                                                                                                                                                                                                        |
| WAF              | SQLi, XSS, path traversal pattern matching on every request                                                                                                                                                                                                                                              |
| Task isolation   | Every query: `AND user_id = ?` — cross-user access impossible                                                                                                                                                                                                                                            |
| Security headers | `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`, `Content-Security-Policy: default-src 'none'`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy: geolocation=(), microphone=(), camera=()` |
| CORS             | Preflight handled before rate limiting — browsers send OPTIONS before every cross-origin request                                                                                                                                                                                                         |

---

## Environment Variables

| Variable      | Where                                              | Description                   |
| ------------- | -------------------------------------------------- | ----------------------------- |
| `JWT_SECRET`  | `.dev.vars` locally, `wrangler secret put` in prod | JWT signing key — 32+ chars   |
| `ENVIRONMENT` | `wrangler.jsonc` vars block / `.dev.vars`          | `development` or `production` |

---

## NPM Scripts

```bash
npm run dev               # Local dev server → http://localhost:8787
npm run deploy            # Deploy to Cloudflare Workers
npm test                  # Run 35 integration tests
npm run type-check        # TypeScript check (tsc --noEmit)
npm run db:migrate:local  # Apply schema.sql to local D1
npm run db:migrate:remote # Apply schema.sql to remote D1
npm run cf-typegen        # Regenerate worker-configuration.d.ts from wrangler.jsonc
```

---

## Technical Summary

**Why no framework (no Hono)?**
The assessment required demonstrating HTTP knowledge. A custom router and middleware pipeline makes every decision explicit — request parsing, auth checking, header injection, error propagation. Nothing is hidden by framework magic.

**Why vanilla JS frontend?**
A single `index.html` with zero build tooling proves a complete product can ship without a framework. The whole frontend is reviewable in one file, loads instantly with no bundle parsing, and has zero supply-chain attack surface.

**Why two wrangler configs?**
Miniflare (the local Workers runtime used by vitest) cannot simulate Workers AI — it requires Cloudflare's actual GPU network. The test config omits the `ai` binding so Miniflare starts cleanly. The service guards `if (!env.AI) return` so tests pass without AI, and production gets real Llama-3 inference. This is the correct pattern: test your own code's logic, not third-party infrastructure.

**Why KV for caching, not D1?**
D1 adds ~5–10ms per round trip. KV reads are ~1ms globally. The rate limiter runs on every single request — that cost compounds fast. KV is the right primitive for hot-path reads where eventual consistency is acceptable.
