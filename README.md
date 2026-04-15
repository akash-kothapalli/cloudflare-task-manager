# Cloudflare Task Manager

A full-stack task management application built on Cloudflare Workers, D1, KV,and Workers AI. Zero external dependencies — runs entirely on Cloudflare's developer platform.

**Live URL:** `https://cloudflare-task-manager.taskflow-akash.workers.dev`

---

## What It Does

Create and manage tasks with full lifecycle tracking (todo → in progress → done). Every task is automatically enriched by **Llama-3** running on Workers AI — generating a one-sentence summary and sentiment classification without any user wait time. Tags, filters, pagination, and a dark-themed UI are all included.

---

## UI Features

The frontend is a single `public/index.html` — zero dependencies, zero build step:

- **Auth** — Login / Register tabs with show/hide password toggle. Access token in JS memory only (XSS-safe). Refresh token in HttpOnly cookie (server-set, auto-sent by browser) and `localStorage` as fallback for API clients. Session auto-restored on refresh via silent token renewal
- **Forgot password** — Email OTP flow: enter email → receive reset code → enter code + new password → signed in automatically
- **Task board** — Cards with status chips, priority badges, due dates, and tag chips
- **AI strip** — `ai_summary` and `ai_sentiment` appear on each card after Llama-3 enriches (colour-coded: green = positive, yellow = neutral, red = negative)
- **Sidebar filters** — All / Todo / In Progress / Done with live counts
- **Priority filter** dropdown
- **Stats bar** — Total / In Progress / Done / AI Enriched counts
- **Modals** — Create/Edit task (all fields), Manage tags with hex color palette picker
- **Tag filter** — Click any tag in the sidebar to filter tasks by that tag.
  "All Tags" resets the filter. Active filters shown as dismissible pills
  below the stats bar (works alongside status and priority filters)
- **Dark / Light mode toggle** — 🌙/☀️ button in topbar. Preference saved
  to localStorage and restored on next visit
- **Filter pills** — Active filters (status, tag, priority) shown as orange
  pills with × to remove individual filters without resetting others
- **Favicon** — ⚡ bolt icon in browser tab
- **AI Enriched stat** — Shows "Llama-3 summaries" subtitle explaining what
  the count means
- **Tag recolor** — Edit button on each tag in Manage Tags modal opens an
  inline editor with name input + mini color picker. Sends `PATCH /tags/:id`
  with both `name` and `color`
- **Pagination** — Prev/Next for multi-page results
- **Toast notifications** — Success/error feedback
- **Themes** — Dark (default) and Light mode. Inter for body text, Syne for
  display headings (logo, stat numbers, titles)

---

## Tech Stack

| Layer    | Technology                            | Why                                                   |
| -------- | ------------------------------------- | ----------------------------------------------------- |
| Runtime  | Cloudflare Workers (V8 isolate)       | Edge execution, zero cold start, globally distributed |
| Database | D1 (SQLite)                           | Relational data, FK constraints, composite indexes    |
| Cache    | KV Store                              | Per-user task cache + sliding-window rate limiting + OTP storage    |
| AI       | Workers AI — Llama-3-8b-instruct      | Task summarisation + sentiment, no external API key   |
| Email    | Brevo Transactional API               | OTP delivery — 300 emails/day free, sends to any address |
| Frontend | Vanilla HTML/JS — `public/index.html` | Zero build step, served as Workers static asset       |
| Auth     | JWT (jose) + PBKDF2-SHA256            | Web Crypto only — no Node.js crypto dependency        |
| Language | TypeScript strict mode                | No `any`, Readonly types, discriminated unions        |

---

## Project Structure

```
cloudflare-task-manager/
├── public/
│   └── index.html              ← Full UI — zero dependencies
├── src/
│   ├── index.ts                ← Worker entry point: 5-step request pipeline
│   ├── controllers/            ← HTTP layer: parse → validate → call service → respond
│   │   ├── auth.controller.ts
│   │   ├── task.controller.ts
│   │   └── tag.controller.ts
│   ├── services/               ← Business logic, caching, AI enrichment
│   │   ├── auth.service.ts
│   │   ├── task.service.ts
│   │   ├── tag.service.ts
│   │   ├── email-validation.service.ts  ← MX record check (production) + format validation
│   │   └── otp.service.ts              ← OTP generation, KV storage, Brevo email delivery
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
│   │   ├── jwt.ts              ← PBKDF2 hashing + JWT sign/verify (access + refresh tokens)
│   │   ├── response.ts         ← Typed API envelope: ok(), created(), badRequest()...
│   │   └── validation.ts       ← Central validation, ValidationResult<T> pattern
│   └── db/
│       ├── schema.sql          ← 4 tables, 8 indexes, CHECK constraints
│       └── seed.sql            ← Dev test data (2 users, 4 tags, 8 tasks)
├── migrations/
│   └── 002_add_is_verified.sql ← ALTER TABLE users ADD COLUMN is_verified (existing DBs)
├── test/
│   └── index.spec.ts           ← 53 integration tests (vitest-pool-workers)
├── wrangler.jsonc              ← Production config (DB + KV + AI + Assets)
├── wrangler.test.jsonc         ← Test config (no AI binding — Miniflare limitation)
└── vitest.config.mts           ← Points at wrangler.test.jsonc for local tests
```

---

## Prerequisites

- Node.js 18+
- Cloudflare account (free tier works)
- Wrangler CLI: `npm install -g wrangler`
- Brevo account (free tier — [brevo.com](https://brevo.com))

---

## Local Setup

### 1. Clone and install

```bash
git clone https://github.com/akash-kothapalli/cloudflare-task-manager.git
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
###  5. Create a preview namespace for local dev isolation

```bash
npx wrangler kv namespace create CACHE --preview
```
Copy the  **both** `id` (production) and preview_id(local) into  `wrangler.jsonc`:

```jsonc
"kv_namespaces": [{ "binding": "CACHE", "id": "YOUR-PRODUCTION-KV-ID", "preview_id": "YOUR-PREVIEW-KV-ID" }]
```
### 6. Create `.dev.vars` for local secrets

```
JWT_SECRET=your-secret-minimum-32-characters-long
REFRESH_TOKEN_SECRET=another-secret-minimum-32-characters-long
ENVIRONMENT=development
```
ENVIRONMENT=development   # REQUIRED — without this, dev_otp is never returned
                          # in register/forgot-password responses, making local
                          # testing impossible (OTP is only returned when not production)


Generate a secure value — Windows PowerShell:

```powershell
-join ((1..32) | ForEach-Object { '{0:x}' -f (Get-Random -Max 16) })
```

Mac/Linux:

```bash
openssl rand -hex 32
```

### 7. Apply schema locally

```bash
npm run db:migrate:local
```

### 8. Seed test data (optional)

```bash
npx wrangler d1 execute task-manager-db --local --file=src/db/seed.sql
```

### 9. Start dev server

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

Create a new account. Sends a 6-digit OTP to the provided email for verification.

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
		"requiresVerification": true,
		"dev_otp": "123456"
	}
}
```

> `dev_otp` is only returned when `ENVIRONMENT !== 'production'`. In production, the OTP is sent via Brevo email only.

**Validation errors:**

- `400` — email missing or invalid format
- `400` — name missing
- `400` — password under 8 characters
- `409` — email already registered

---

#### `POST /auth/verify-otp`

Verify the OTP received after registration. Returns tokens on success.

```bash
curl -X POST http://localhost:8787/auth/verify-otp \
  -H "Content-Type: application/json" \
  -d '{"email":"alice@example.com","otp":"123456"}'
```

**Response 200:**

```json
{
	"success": true,
	"data": {
		"token": "eyJhbGc...",
		"refreshToken": "eyJhbGc...",
		"user": { "id": 1, "email": "alice@example.com", "name": "Alice", "created_at": "...", "updated_at": "..." }
	}
}
```

**Errors:** `400` wrong or expired OTP, `400` OTP must be 6 digits

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
		"refreshToken": "eyJhbGc...",
		"user": { "id": 1, "email": "alice@example.com", "name": "Alice" }
	}
}
```

> `refreshToken` is also set as an `HttpOnly` cookie (`refresh_token`, `SameSite=None`) for browser clients. The cookie is used automatically by `POST /auth/refresh`.

**Errors:** `401` for wrong email or password (same error — prevents user enumeration)
**Errors:** `403` if account exists but email is not yet verified

---

#### `POST /auth/forgot-password`

Send a 6-digit reset code to any registered email address, regardless of verification status.

```bash
curl -X POST http://localhost:8787/auth/forgot-password \
  -H "Content-Type: application/json" \
  -d '{"email":"alice@example.com"}'
```

**Response 200:**

```json
{
	"success": true,
	"data": {
		"message": "A reset code has been sent to your email address.",
		"dev_otp": "654321"
	}
}
```

> Always returns 200 even if the email is not registered — prevents user enumeration. `dev_otp` only shown outside production.

---

#### `POST /auth/reset-password`

Verify the reset OTP, save a new hashed password, and sign the user in. The OTP is single-use and expires after 10 minutes.

```bash
curl -X POST http://localhost:8787/auth/reset-password \
  -H "Content-Type: application/json" \
  -d '{"email":"alice@example.com","otp":"654321","newPassword":"newpassword123"}'
```

**Response 200:** Full auth response (token + refreshToken + user) — user is signed in immediately after reset.

**Errors:** `400` invalid or expired OTP, `400` password under 8 characters, `400` missing fields

---

#### `GET /auth/me` 🔒

Get the current user's profile.

```bash
curl http://localhost:8787/auth/me \
  -H "Authorization: Bearer <token>"
```

---

#### `POST /auth/refresh`

Exchange a valid refresh token for a new access token. Accepts the token in the request body or via the `refresh_token` HttpOnly cookie set at login.

```bash
# Via request body
curl -X POST http://localhost:8787/auth/refresh \
  -H "Content-Type: application/json" \
  -d '{"refreshToken":"eyJhbGc..."}'

# Via cookie (browser — sent automatically)
curl -X POST http://localhost:8787/auth/refresh \
  --cookie "refresh_token=eyJhbGc..."
```

**Response 200:**

```json
{
	"success": true,
	"data": {
		"token": "eyJhbGc...",
		"refreshToken": "eyJhbGc..."
	}
}
```

**Errors:** `401` missing token, `401` tampered or expired token

---

---

#### `POST /auth/logout`

Revoke the current refresh token server-side. After this call the refresh
token is permanently dead — `POST /auth/refresh` with the same token returns 401.
The access token still works for up to 15 minutes (by design — short TTL is
the revocation mechanism for access tokens).

```bash
curl -X POST http://localhost:8787/auth/logout \
  -H "Content-Type: application/json" \
  -d '{"refreshToken":"eyJhbGc..."}'

# Or via HttpOnly cookie (browser — sent automatically)
curl -X POST http://localhost:8787/auth/logout \
  --cookie "refresh_token=eyJhbGc..."
```

**Response 200:** `{ "success": true, "data": { "message": "Logged out successfully" } }`

> Always returns 200 — logout is idempotent. If the token is already expired
> or invalid, the result is the same: logged out. The `refresh_token` HttpOnly
> cookie is cleared via `Max-Age=0`.

---
#### `POST /auth/resend-otp`

Resend the verification OTP to an unverified account. Does not work for already-verified accounts — use `POST /auth/forgot-password` instead.

```bash
curl -X POST http://localhost:8787/auth/resend-otp \
  -H "Content-Type: application/json" \
  -d '{"email":"alice@example.com"}'
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

# Filter by tag
curl "http://localhost:8787/tasks?tag_id=3" -H "Authorization: Bearer <token>"

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
| `tag_id`     | positive integer                        | none    |
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

| Field   | Required | Type                               |
| ------- | -------- | ---------------------------------- |
| `name`  | ✅       | string, max 50 chars               |
| `color` | ❌       | hex color e.g. `#6366f1` (default) |

**Errors:** `409` if tag name already exists for this user

#### `PATCH /tags/:id` 🔒

Rename or recolor an existing tag. Send only the fields you want to change — at least one is required.

```bash
curl -X PATCH http://localhost:8787/tags/1 \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"name": "urgent", "color": "#ef4444"}'
```

| Field   | Required | Validation |
| ------- | -------- | ---------- |
| `name`  | ❌       | string, max 50 chars |
| `color` | ❌       | valid hex e.g. `#ff0000` |

**Errors:** `400` invalid hex color, `400` empty body, `404` tag not found

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

53 integration tests run inside a real Workers V8 runtime via `@cloudflare/vitest-pool-workers`. The real `schema.sql` is loaded before each run via `?raw` import — no hardcoded schema in test files.

| Suite | Tests |
| ------------------------------------ | ----- |
| Health check | 1 |
| Auth — Register + OTP flow | 8 |
| Auth — Login | 3 |
| Auth — Refresh token | 4 |
| Auth — Me | 3 |
| Tasks — CRUD | 9 |
| Tags — CRUD including PATCH | 10 |
| Security — Cross-user data isolation | 8 |
| Security headers | 4 |
| WAF — Malicious input detection | 3 |

---

## Deployment

### 1. Apply schema to remote D1

```bash
npm run db:migrate:remote
```

### 2. Set production secrets

```bash
npx wrangler secret put JWT_SECRET
npx wrangler secret put REFRESH_TOKEN_SECRET
npx wrangler secret put BREVO_API_KEY
# Paste your generated secrets at each prompt
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

**Smart Placement:**
`wrangler.jsonc` enables `"placement": { "mode": "smart" }`. Cloudflare
automatically runs the Worker in the region geographically closest to the
D1 database, not closest to the user. Since D1 queries dominate latency
(5-10ms per query), minimising the Worker-to-D1 round trip is more valuable
than minimising the user-to-Worker round trip. Free on all plans.


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

### KV Store — four use cases

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
Key:   rl:{ip}:{windowMinute}   (windowMinute resets every 60 seconds)
Value: request count for that minute
TTL:   90 seconds (slightly longer than window — ensures key outlives the window)
Why:   Fixed-window per minute. Old sliding-window design had a bug where
       the TTL reset on every write, meaning a steady stream of requests
       never allowed the counter to reset. The minute-bucket key gives a
       clean reset every 60 seconds.
Note:  KV has no atomic increment (no CAS). A small overage (~2-3 requests)
       is possible under high concurrency. Acceptable for free-tier use.
```

**OTP storage:**

```
Key:   otp:{email}
Value: 6-digit code (cryptographically random)
TTL:   600 seconds (10 minutes)
Use:   Registration verification + forgot-password reset codes
Note:  Single-use — deleted immediately on successful verification
```

**Refresh token revocation (jti denylist):**

```
Key:   rt:{jti}          (jti = UUID embedded in the JWT payload)
Value: "1" (presence = token valid)
TTL:   7 days (matches token expiry — KV auto-cleans when token would die anyway)
Use:   POST /auth/logout deletes the key. POST /auth/refresh checks for key existence.
       No key = token revoked → 401. Rotation: old key deleted, new key written on refresh.
```

### D1 schema

```sql
users     — email UNIQUE, PBKDF2 hash stored as "saltHex:hashHex", is_verified flag
tasks     — user_id FK + ON DELETE CASCADE
            status CHECK IN ('todo','in_progress','done','cancelled')
            priority CHECK IN ('low','medium','high','critical')
            ai_sentiment CHECK IN ('positive','neutral','negative') or NULL
tags      — UNIQUE(user_id, name) — per-user namespace
task_tags — composite PK (task_id, tag_id), CASCADE on both FKs
```

Eight composite indexes: `(user_id, status)`, `(user_id, priority)`, `(user_id, due_date)` keep filter queries fast regardless of table size.


**Tag fetching — batch query (no N+1):**
`GET /tasks` with a page of 20 tasks uses exactly **3 DB queries** total:
1. `COUNT(*)` to get total (parallel with query 2)
2. `SELECT * FROM tasks WHERE ...` for the page
3. One batch `SELECT ... WHERE task_id IN (?, ?, ...)` for all tags

Before: 21 queries for 20 tasks (1 task query + 20 tag queries). A JOIN with
`GROUP_CONCAT` or an IN-clause batch was the fix. Tags are grouped by
`task_id` in JavaScript memory — no extra DB round trips.


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
| Auth | Access token: JWT HS256, 15-min expiry (memory-only in browser). Refresh token: JWT HS256, 7-day expiry, `jti` stored in KV on issue. Token rotation on refresh (old jti deleted, new jti stored). `POST /auth/logout` deletes jti from KV — token permanently dead server-side. |
| Passwords        | PBKDF2-SHA256, 100k iterations, unique salt per user. Reset via email OTP — new password hashed and saved, user signed in immediately |
| User enumeration | Login and forgot-password always return same message regardless of whether email exists |
| SQL injection    | All queries use D1 `.bind()` — zero string interpolation                                                                                                                                                                                                                                                 |
| LIKE injection   | `%` and `_` escaped in search input before query                                                                                                                                                                                                                                                         |
| Rate limiting    | 60 req/min/IP via KV, keyed on `CF-Connecting-IP`                                                                                                                                                                                                                                                        |
| WAF              | SQLi, XSS (URL + request body), path traversal — regex + escaped-root detection on every request |
| Task isolation   | Every query: `AND user_id = ?` — cross-user access impossible                                                                                                                                                                                                                                            |
| OTP security     | Cryptographically random (Web Crypto), 10-min TTL, single-use (deleted on verify), timing-safe comparison |
| Security headers | `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`, `Content-Security-Policy: default-src 'none'`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy: geolocation=(), microphone=(), camera=()` |
| CORS | Allowlist (not wildcard `*`) — only `taskflow-akash.workers.dev` and localhost dev ports accepted. Wildcard would allow any website to call the API with a logged-in user's credentials. Preflight handled before rate limiting. |

---

## Environment Variables

| Variable               | Where                                              | Description                          |
| ---------------------- | -------------------------------------------------- | ------------------------------------ |
| `JWT_SECRET`           | `.dev.vars` locally, `wrangler secret put` in prod | Access token signing key — 32+ chars |
| `REFRESH_TOKEN_SECRET` | `.dev.vars` locally, `wrangler secret put` in prod | Refresh token signing key — 32+ chars |
| `BREVO_API_KEY`        | `wrangler secret put` in prod only                 | Brevo transactional email API key (`xkeysib-...`) — 300 emails/day free |
| `EMAIL_FROM`           | `wrangler secret put` (optional)                   | Sender address — must be verified in Brevo dashboard (default: your Brevo account email) |
| `ENVIRONMENT`          | `wrangler.jsonc` vars block / `.dev.vars`          | `development` or `production`        |

---

## NPM Scripts

```bash
npm run dev               # Local dev server → http://localhost:8787
npm run deploy            # Deploy to Cloudflare Workers
npm test                  # Run 53 integration tests
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
The test runner (vitest + `@cloudflare/vitest-pool-workers`) uses a version of
Miniflare that cannot resolve the Workers AI binding and throws a module error
if it is present. The test config omits `"ai"` so tests run cleanly.

Note: `wrangler dev --local` DOES support Workers AI — it proxies inference
calls to real Cloudflare GPU infrastructure even in local mode. Only the test
runner needs the AI binding removed. The guard `if (!env.AI) return` now
applies only to the test environment.

**Why KV for caching, not D1?**
D1 adds ~5–10ms per round trip. KV reads are ~1ms globally. The rate limiter runs on every single request — that cost compounds fast. KV is the right primitive for hot-path reads where eventual consistency is acceptable.

**Why Brevo for email?**
Brevo's free tier sends to any email address with no domain verification required — unlike Resend (free tier restricted to verified recipients only). 300 emails/day is sufficient for a project. The sender address just needs to be verified once in the Brevo dashboard.
