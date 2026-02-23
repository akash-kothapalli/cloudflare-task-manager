# Cloudflare Task Manager API

A production-grade REST API built on Cloudflare Workers with D1 (SQLite), KV Store, and Workers AI. Built as part of the nexarq AI technical assessment.

**Live URL:** `https://cloudflare-task-manager.<your-subdomain>.workers.dev`

---

## Tech Stack

| Layer | Technology | Why |
|---|---|---|
| Runtime | Cloudflare Workers (V8 isolate) | Edge execution, zero cold start, global |
| Database | D1 (SQLite) | Relational data, FK constraints, indexes |
| Cache | KV Store | Per-user task cache, rate-limit counters |
| AI | Workers AI — Llama-3-8b | Task summarisation + sentiment analysis |
| Auth | JWT via `jose` + PBKDF2 | Web Crypto only — no Node.js deps |
| Language | TypeScript (strict mode) | Type safety, no `any`, Readonly DB rows |

---

## Project Structure

```
src/
├── controllers/     — HTTP layer: parse request, call service, return response
│   ├── auth.controller.ts
│   ├── task.controller.ts
│   └── tag.controller.ts
├── services/        — Business logic: validation, caching, AI enrichment
│   ├── auth.service.ts
│   ├── task.service.ts
│   └── tag.service.ts
├── repositories/    — Data layer: all SQL queries, row mapping, no business logic
│   ├── user.repository.ts
│   ├── task.repository.ts
│   └── tag.repository.ts
├── middleware/      — Cross-cutting concerns
│   ├── auth.middleware.ts    — JWT verification → AuthContext
│   ├── security.ts           — Headers, CORS, rate limiting, WAF
│   ├── logger.ts             — Structured JSON logging
│   └── error-handler.ts      — AppError class, global error boundary
├── routes/
│   └── index.ts              — Clean router (replaces if-chain anti-pattern)
├── types/           — Strict TypeScript types, no any
├── utils/
│   ├── jwt.ts                — PBKDF2 password hashing + JWT sign/verify
│   ├── response.ts           — Typed API envelope helpers
│   └── validation.ts         — Central input validation, ValidationResult<T>
├── db/
│   ├── schema.sql            — D1 table definitions + indexes
│   └── seed.sql              — Development test data
└── index.ts                  — Worker entry point: 5-step request pipeline
```

---

## Prerequisites

- Node.js 18+
- Cloudflare account (free tier works)
- Wrangler CLI: `npm install -g wrangler`

---

## Local Setup — Step by Step

### 1. Clone and install

```bash
git clone https://github.com/<your-username>/cloudflare-task-manager.git
cd cloudflare-task-manager
npm install
```

### 2. Authenticate with Cloudflare

```bash
npx wrangler login
# Opens browser — log in with your Cloudflare account
```

### 3. Create D1 database

```bash
npx wrangler d1 create task-manager-db
```

Copy the `database_id` from the output and verify it matches `wrangler.jsonc`:
```jsonc
"d1_databases": [{ "binding": "DB", "database_name": "task-manager-db", "database_id": "YOUR-ID-HERE" }]
```

### 4. Create KV namespace

```bash
npx wrangler kv namespace create CACHE
```

Copy the `id` and verify it matches `wrangler.jsonc`:
```jsonc
"kv_namespaces": [{ "binding": "CACHE", "id": "YOUR-KV-ID-HERE" }]
```

### 5. Set up local secrets

Create `.dev.vars` in the project root (already in `.gitignore`):
```
JWT_SECRET=your-secret-here-minimum-32-characters
ENVIRONMENT=development
```

Generate a secure secret on Windows PowerShell:
```powershell
-join ((1..32) | ForEach-Object { '{0:x}' -f (Get-Random -Max 16) })
```

Or on Mac/Linux:
```bash
openssl rand -hex 32
```

### 6. Run DB migration locally

```bash
npx wrangler d1 execute task-manager-db --local --file=src/db/schema.sql
```

### 7. Seed test data (optional)

```bash
npx wrangler d1 execute task-manager-db --local --file=src/db/seed.sql
```

### 8. Start local dev server

```bash
npm run dev
# → Ready on http://localhost:8787
```

---

## API Reference

All protected endpoints require: `Authorization: Bearer <token>`

All responses follow this envelope:
```json
{ "success": true, "data": { ... } }
{ "success": false, "error": { "code": "ERROR_CODE", "message": "..." } }
```

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

| Param | Values | Default |
|---|---|---|
| `status` | `todo` `in_progress` `done` `cancelled` | all |
| `priority` | `low` `medium` `high` `critical` | all |
| `search` | any string | none |
| `due_before` | `YYYY-MM-DD` | none |
| `page` | integer ≥ 1 | `1` |
| `limit` | 1–100 | `20` |

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

| Field | Required | Type | Values |
|---|---|---|---|
| `title` | ✅ | string | max 255 chars |
| `description` | ❌ | string | max 5000 chars |
| `status` | ❌ | string | `todo` `in_progress` `done` `cancelled` (default: `todo`) |
| `priority` | ❌ | string | `low` `medium` `high` `critical` (default: `medium`) |
| `due_date` | ❌ | string | `YYYY-MM-DD` |
| `tag_ids` | ❌ | number[] | array of existing tag IDs |

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

| Field | Required | Type |
|---|---|---|
| `name` | ✅ | string, max 50 chars |
| `color` | ❌ | hex color e.g. `#6366f1` (default) |

**Errors:** `409` if tag name already exists for this user

#### `DELETE /tags/:id` 🔒
Delete a tag. Automatically removed from all tasks.

```bash
curl -X DELETE http://localhost:8787/tags/1 \
  -H "Authorization: Bearer <token>"
```

---

## Testing

### Run automated tests

```bash
npm test
```

Tests run inside a real Workers runtime via `@cloudflare/vitest-pool-workers` — same V8 isolate as production. 35 test cases covering auth, CRUD, filtering, security headers, and CORS.

### Manual testing with curl — complete flow

```bash
BASE=http://localhost:8787

# 1. Register
TOKEN=$(curl -s -X POST $BASE/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","name":"Test User","password":"password123"}' \
  | grep -o '"token":"[^"]*"' | cut -d'"' -f4)

echo "Token: $TOKEN"

# 2. Create a task
curl -X POST $BASE/tasks \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title":"My first task","priority":"high","due_date":"2026-12-31"}'

# 3. List tasks
curl "$BASE/tasks" -H "Authorization: Bearer $TOKEN"

# 4. Mark as done (replace 1 with your task ID)
curl -X PATCH $BASE/tasks/1 \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"status":"done"}'

# 5. Wait 2 seconds then fetch — AI fields should now be populated
sleep 2
curl $BASE/tasks/1 -H "Authorization: Bearer $TOKEN"
```

---

## Deployment

### 1. Apply schema to remote DB

```bash
npx wrangler d1 execute task-manager-db --remote --file=src/db/schema.sql
```

### 2. Seed remote DB (optional)

```bash
npx wrangler d1 execute task-manager-db --remote --file=src/db/seed.sql
```

> **Note:** The seed users have placeholder password hashes. Register fresh users via the API after deploying — the PBKDF2 hash in seed.sql is illustrative only.

### 3. Set production secret

```bash
npx wrangler secret put JWT_SECRET
# Paste your secret when prompted (use openssl rand -hex 32)
```

### 4. Deploy

```bash
npm run deploy
```

Output: `✅ Deployed to https://cloudflare-task-manager.<subdomain>.workers.dev`

### 5. Test live deployment

```bash
BASE=https://cloudflare-task-manager.<subdomain>.workers.dev
curl $BASE/health
```

---

## Architectural Decisions

### Why no framework (no Hono)?

The assessment required demonstrating HTTP protocol knowledge. Using a framework hides routing, middleware chaining, and header handling. Our custom router and 5-step middleware pipeline shows understanding of how requests actually flow through an edge Worker.

### Request pipeline (`src/index.ts`)

```
Request
  → WAF scan (SQLi / XSS / path traversal patterns)
  → CORS preflight (OPTIONS → 204 immediately)
  → Rate limiting (60 req/min/IP via KV sliding window)
  → Structured JSON logging (CF-Ray, IP, country, duration)
  → Router → Controller → Service → Repository
  → Security headers on every response
```

### KV Store — two use cases

**1. Per-user task cache**
- Key: `tasks:{userId}` and `task:{userId}:{taskId}`
- TTL: 60 seconds
- Invalidated on every write (create/update/delete)
- Why per-user: a global `all_tasks` key would let user A's cache contain user B's data

**2. Rate limiting**
- Key: `rl:{ip}` using `CF-Connecting-IP` (Cloudflare's real IP header — not spoofable)
- Counter incremented per request, TTL resets each time (sliding window)
- 60 requests/minute/IP → `429 Too Many Requests` with `Retry-After` header
- D1 would add unnecessary SQL overhead for every request — KV's ~1ms reads are perfect here

### D1 database design

- 4 tables: `users`, `tasks`, `tags`, `task_tags`
- `tasks.user_id` foreign key with `ON DELETE CASCADE` — user deletion cleans up everything
- Composite indexes on `(user_id, status)` and `(user_id, priority)` — filter queries are instant even at scale
- All timestamps stored as `TEXT` — D1/SQLite stores DATETIME as TEXT internally; being explicit avoids type confusion
- `CHECK` constraints on `status`, `priority`, `ai_sentiment` — DB rejects invalid values even if app layer has a bug

### Password hashing — Web Crypto PBKDF2

`bcryptjs` uses Node.js `crypto.pbkdf2()` which doesn't exist in Workers V8 runtime. We use `crypto.subtle` (Web Crypto API — built into every Worker):
- Algorithm: PBKDF2-SHA256, 100,000 iterations
- Salt: 16 random bytes per password (from `crypto.getRandomValues`)
- Output: 256-bit hash stored as `saltHex:hashHex`
- Constant-time comparison to prevent timing attacks

### Workers AI — How it works

When a task is created, the Worker makes an inference call to Cloudflare's AI gateway running **Llama-3-8b-instruct** (Meta's open-source 8 billion parameter language model):

```
User creates task
      ↓
Worker returns 201 immediately (user doesn't wait)
      ↓ (async, non-blocking)
enrichWithAI() sends prompt to Llama-3:
  "Analyse this task. Respond ONLY with JSON:
   {summary: '...', sentiment: 'positive|neutral|negative'}"
      ↓
Llama-3 returns inference result (~1 second)
      ↓
Worker parses JSON, validates sentiment value
      ↓
D1: UPDATE tasks SET ai_summary=?, ai_sentiment=? WHERE id=?
KV: invalidate task cache so next GET returns AI fields
```

**Why non-blocking?** AI inference takes 500ms–2s. Making the user wait would make every `POST /tasks` slow. By firing the AI call after sending the response, the API stays fast and the AI fields appear on subsequent GETs.

**Why Llama-3?** It's available directly in Workers AI with no API key or external service — one binding in `wrangler.jsonc` is all it takes. The model handles instruction-following well enough to reliably return structured JSON.

### Security

| Layer | Implementation |
|---|---|
| Authentication | JWT HS256, 1h expiry, verified on every protected route |
| Password storage | PBKDF2-SHA256, 100k iterations, unique salt per user |
| User enumeration prevention | Login always returns same 401 whether email or password is wrong; `verifyPassword` runs even when user not found (dummy hash, same timing) |
| SQL injection | All queries use D1 parameterized statements — no string concatenation |
| Rate limiting | 60 req/min/IP via KV, `CF-Connecting-IP` header (not spoofable) |
| WAF patterns | Regex scan for SQLi, XSS, path traversal on every request |
| Security headers | `X-Content-Type-Options`, `X-Frame-Options`, `Strict-Transport-Security`, `Content-Security-Policy`, `Referrer-Policy`, `Permissions-Policy` |
| CORS | Preflight handled before rate limiting (browsers send OPTIONS before every cross-origin request) |
| Task isolation | Every DB query includes `AND user_id = ?` — users can never access each other's tasks |

---

## Environment Variables

| Variable | Where set | Purpose |
|---|---|---|
| `JWT_SECRET` | `.dev.vars` (local) / `wrangler secret put` (prod) | JWT signing key |
| `ENVIRONMENT` | `wrangler.jsonc` vars / `.dev.vars` | `development` or `production` |

---

## Scripts

```bash
npm run dev              # Local dev server (http://localhost:8787)
npm run deploy           # Deploy to Cloudflare Workers
npm test                 # Run vitest integration tests
npm run type-check       # TypeScript type check (tsc --noEmit)
npm run cf-typegen       # Regenerate worker-configuration.d.ts from wrangler.jsonc
npm run db:migrate:local # Apply schema.sql to local D1
npm run db:migrate:remote# Apply schema.sql to remote D1
```
