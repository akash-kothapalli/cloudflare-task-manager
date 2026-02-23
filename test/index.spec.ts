// =============================================================================
// test/index.spec.ts — Integration tests for cloudflare-task-manager
// Runs inside real Workers V8 runtime via @cloudflare/vitest-pool-workers
// Run: npm test
// =============================================================================

import {
  env,
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import worker from "../src/index";

// ─── Issue 1 fix: Load schema.sql correctly ───────────────────────────────────
//
// WHY NOT: await env.DB.exec(entireSchemaString)
//   D1's exec() only accepts ONE statement at a time.
//   A multi-statement string silently fails after the first semicolon.
//   Result: only the first table is created, beforeAll throws, all tests skip.
//
// WHY THIS WORKS: we read the .sql file, strip comments, split on semicolons,
//   filter blank statements, then exec() each one individually.
//
// In the Workers runtime (Miniflare), import.meta.url points to the test file.
// We use the SCHEMA constant (inlined at build time by vitest's module resolver).
// Vitest resolves ?raw imports as string content — no fs module needed.

import SCHEMA from "../src/db/schema.sql?raw";

async function applySchema(db: D1Database): Promise<void> {
  // Remove all SQL comments first
  const cleaned = SCHEMA.replace(/--.*$/gm, "");

  const statements = cleaned
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);

  await db.batch(
    statements.map((sql) => db.prepare(sql))
  );
}

// ─── HTTP helper ──────────────────────────────────────────────────────────────
async function req(
  method: string,
  path: string,
  options: { body?: unknown; token?: string } = {}
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (options.token) headers["Authorization"] = `Bearer ${options.token}`;

  const request = new Request(`http://localhost${path}`, {
    method,
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const ctx      = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  const body = await response.json() as Record<string, unknown>;
  return { status: response.status, body };
}

// ─── Shared state across tests ────────────────────────────────────────────────
let authToken    = "";
let createdTaskId: number;
let createdTagId:  number;

// ─── Setup: apply real schema.sql before any test runs ───────────────────────
beforeAll(async () => {
  await applySchema(env.DB);
});

// =============================================================================
describe("Health check", () => {
  it("GET /health → 200 with status ok", async () => {
    const { status, body } = await req("GET", "/health");
    expect(status).toBe(200);
    expect((body.data as Record<string, unknown>).status).toBe("ok");
  });
});

// =============================================================================
describe("Auth — Register", () => {
  it("201 creates account, returns token + user (no password)", async () => {
    const { status, body } = await req("POST", "/auth/register", {
      body: { email: "alice@test.com", name: "Alice", password: "password123" },
    });
    expect(status).toBe(201);
    const data = body.data as Record<string, unknown>;
    expect(typeof data.token).toBe("string");
    const user = data.user as Record<string, unknown>;
    expect(user.email).toBe("alice@test.com");
    expect(user.name).toBe("Alice");
    expect(user.password).toBeUndefined(); // must NEVER leak
    authToken = data.token as string;
  });

  it("400 when email missing", async () => {
    const { status, body } = await req("POST", "/auth/register", {
      body: { name: "Bob", password: "password123" },
    });
    expect(status).toBe(400);
    expect((body.error as Record<string, unknown>).code).toBe("BAD_REQUEST");
  });

  it("400 when name missing", async () => {
    const { status } = await req("POST", "/auth/register", {
      body: { email: "bob@test.com", password: "password123" },
    });
    expect(status).toBe(400);
  });

  it("400 when password under 8 chars", async () => {
    const { status } = await req("POST", "/auth/register", {
      body: { email: "x@test.com", name: "X", password: "short" },
    });
    expect(status).toBe(400);
  });

  it("409 duplicate email", async () => {
    const { status, body } = await req("POST", "/auth/register", {
      body: { email: "alice@test.com", name: "Alice2", password: "password123" },
    });
    expect(status).toBe(409);
    expect((body.error as Record<string, unknown>).code).toBe("CONFLICT");
  });
});

// =============================================================================
describe("Auth — Login", () => {
  it("200 correct credentials", async () => {
    const { status, body } = await req("POST", "/auth/login", {
      body: { email: "alice@test.com", password: "password123" },
    });
    expect(status).toBe(200);
    expect(typeof (body.data as Record<string, unknown>).token).toBe("string");
    expect(
      ((body.data as Record<string, unknown>).user as Record<string, unknown>).password
    ).toBeUndefined();
  });

  it("401 wrong password", async () => {
    const { status, body } = await req("POST", "/auth/login", {
      body: { email: "alice@test.com", password: "wrongpassword" },
    });
    expect(status).toBe(401);
    expect((body.error as Record<string, unknown>).code).toBe("UNAUTHORIZED");
  });

  it("401 non-existent email — same error as wrong password (no user enumeration)", async () => {
    const { status, body } = await req("POST", "/auth/login", {
      body: { email: "ghost@test.com", password: "password123" },
    });
    expect(status).toBe(401);
    expect((body.error as Record<string, unknown>).code).toBe("UNAUTHORIZED");
  });
});

// =============================================================================
describe("Auth — Me", () => {
  it("200 returns current user", async () => {
    const { status, body } = await req("GET", "/auth/me", { token: authToken });
    expect(status).toBe(200);
    expect((body.data as Record<string, unknown>).email).toBe("alice@test.com");
  });

  it("401 without token", async () => {
    const { status } = await req("GET", "/auth/me");
    expect(status).toBe(401);
  });

  it("401 malformed token", async () => {
    const { status } = await req("GET", "/auth/me", { token: "not.a.real.token" });
    expect(status).toBe(401);
  });
});

// =============================================================================
describe("Tasks — Create", () => {
  it("201 creates task with all fields", async () => {
    const { status, body } = await req("POST", "/tasks", {
      token: authToken,
      body: {
        title:       "Write unit tests",
        description: "Cover all endpoints",
        priority:    "high",
        status:      "in_progress",
        due_date:    "2026-12-31",
      },
    });
    expect(status).toBe(201);
    const task = body.data as Record<string, unknown>;
    expect(task.title).toBe("Write unit tests");
    expect(task.priority).toBe("high");
    expect(task.status).toBe("in_progress");
    expect(task.due_date).toBe("2026-12-31");
    expect(typeof task.id).toBe("number");
    createdTaskId = task.id as number;
  });

  it("400 when title missing", async () => {
    const { status, body } = await req("POST", "/tasks", {
      token: authToken, body: { priority: "high" },
    });
    expect(status).toBe(400);
    expect((body.error as Record<string, unknown>).code).toBe("BAD_REQUEST");
  });

  it("400 invalid status value", async () => {
    const { status } = await req("POST", "/tasks", {
      token: authToken, body: { title: "Bad", status: "flying" },
    });
    expect(status).toBe(400);
  });

  it("400 invalid priority value", async () => {
    const { status } = await req("POST", "/tasks", {
      token: authToken, body: { title: "Bad", priority: "extreme" },
    });
    expect(status).toBe(400);
  });

  it("401 without token", async () => {
    const { status } = await req("POST", "/tasks", { body: { title: "Unauth" } });
    expect(status).toBe(401);
  });
});

// =============================================================================
describe("Tasks — Read", () => {
  it("200 returns list with pagination meta", async () => {
    const { status, body } = await req("GET", "/tasks", { token: authToken });
    expect(status).toBe(200);
    expect(Array.isArray(body.data)).toBe(true);
    const meta = body.meta as Record<string, unknown>;
    expect(typeof meta.total).toBe("number");
    expect(typeof meta.page).toBe("number");
    expect(typeof meta.limit).toBe("number");
  });

  it("200 filters by status=in_progress", async () => {
    const { status, body } = await req("GET", "/tasks?status=in_progress", {
      token: authToken,
    });
    expect(status).toBe(200);
    (body.data as Record<string, unknown>[]).forEach(t =>
      expect(t.status).toBe("in_progress")
    );
  });

  it("400 invalid status filter", async () => {
    const { status } = await req("GET", "/tasks?status=flying", { token: authToken });
    expect(status).toBe(400);
  });

  it("200 GET /tasks/:id returns single task", async () => {
    const { status, body } = await req("GET", `/tasks/${createdTaskId}`, {
      token: authToken,
    });
    expect(status).toBe(200);
    expect((body.data as Record<string, unknown>).id).toBe(createdTaskId);
  });

  it("404 non-existent task", async () => {
    const { status, body } = await req("GET", "/tasks/99999", { token: authToken });
    expect(status).toBe(404);
    expect((body.error as Record<string, unknown>).code).toBe("NOT_FOUND");
  });

  it("401 GET /tasks without token", async () => {
    const { status } = await req("GET", "/tasks");
    expect(status).toBe(401);
  });
});

// =============================================================================
describe("Tasks — Update (PATCH)", () => {
  it("200 status → done auto-sets completed_at", async () => {
    const { status, body } = await req("PATCH", `/tasks/${createdTaskId}`, {
      token: authToken, body: { status: "done" },
    });
    expect(status).toBe(200);
    const task = body.data as Record<string, unknown>;
    expect(task.status).toBe("done");
    expect(task.completed_at).not.toBeNull();
  });

  it("200 partial update — only title changes, status unchanged", async () => {
    const { status, body } = await req("PATCH", `/tasks/${createdTaskId}`, {
      token: authToken, body: { title: "Updated title" },
    });
    expect(status).toBe(200);
    const task = body.data as Record<string, unknown>;
    expect(task.title).toBe("Updated title");
    expect(task.status).toBe("done"); // unchanged
  });

  it("400 empty body", async () => {
    const { status } = await req("PATCH", `/tasks/${createdTaskId}`, {
      token: authToken, body: {},
    });
    expect(status).toBe(400);
  });

  it("404 non-existent task", async () => {
    const { status } = await req("PATCH", "/tasks/99999", {
      token: authToken, body: { title: "Ghost" },
    });
    expect(status).toBe(404);
  });
});

// =============================================================================
describe("Tags", () => {
  it("201 creates tag", async () => {
    const { status, body } = await req("POST", "/tags", {
      token: authToken, body: { name: "work", color: "#ef4444" },
    });
    expect(status).toBe(201);
    const tag = body.data as Record<string, unknown>;
    expect(tag.name).toBe("work");
    expect(tag.color).toBe("#ef4444");
    createdTagId = tag.id as number;
  });

  it("400 invalid hex color", async () => {
    const { status } = await req("POST", "/tags", {
      token: authToken, body: { name: "bad", color: "red" },
    });
    expect(status).toBe(400);
  });

  it("409 duplicate tag name", async () => {
    const { status, body } = await req("POST", "/tags", {
      token: authToken, body: { name: "work" },
    });
    expect(status).toBe(409);
    expect((body.error as Record<string, unknown>).code).toBe("CONFLICT");
  });

  it("200 GET /tags returns user tags", async () => {
    const { status, body } = await req("GET", "/tags", { token: authToken });
    expect(status).toBe(200);
    expect((body.data as unknown[]).length).toBeGreaterThan(0);
  });

  it("200 DELETE /tags/:id", async () => {
    const { status } = await req("DELETE", `/tags/${createdTagId}`, { token: authToken });
    expect(status).toBe(200);
  });

  it("404 DELETE already-deleted tag", async () => {
    const { status } = await req("DELETE", `/tags/${createdTagId}`, { token: authToken });
    expect(status).toBe(404);
  });
});

// =============================================================================
describe("Security headers", () => {
  async function getHeaders(path: string): Promise<Headers> {
    const request = new Request(`http://localhost${path}`);
    const ctx     = createExecutionContext();
    const res     = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);
    return res.headers;
  }

  it("X-Content-Type-Options: nosniff", async () => {
    expect((await getHeaders("/health")).get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("X-Frame-Options: DENY", async () => {
    expect((await getHeaders("/health")).get("X-Frame-Options")).toBe("DENY");
  });

  it("Strict-Transport-Security present", async () => {
    expect((await getHeaders("/health")).get("Strict-Transport-Security")).toContain("max-age=");
  });

  it("OPTIONS preflight → 204 with CORS headers", async () => {
    const request = new Request("http://localhost/tasks", { method: "OPTIONS" });
    const ctx     = createExecutionContext();
    const res     = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeTruthy();
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("GET");
  });
});

// =============================================================================
describe("Tasks — Delete", () => {
  it("200 DELETE /tasks/:id", async () => {
    const { status, body } = await req("DELETE", `/tasks/${createdTaskId}`, {
      token: authToken,
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
  });

  it("404 DELETE already-deleted task", async () => {
    const { status } = await req("DELETE", `/tasks/${createdTaskId}`, {
      token: authToken,
    });
    expect(status).toBe(404);
  });
});
