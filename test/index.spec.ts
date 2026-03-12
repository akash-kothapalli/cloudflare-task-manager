// =============================================================================
// test/index.spec.ts — Integration tests for cloudflare-task-manager
// Runs inside real Workers V8 runtime via @cloudflare/vitest-pool-workers
// Run: npm test
// =============================================================================

import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import worker from '../src/index';
import SCHEMA from '../src/db/schema.sql?raw';

// ─── Schema setup ─────────────────────────────────────────────────────────────
async function applySchema(db: D1Database): Promise<void> {
	await db.exec('PRAGMA foreign_keys = ON');
	const cleaned = SCHEMA.replace(/--[^\n]*/g, '').replace(/[\n\t]+/g, ' ').replace(/\s{2,}/g, ' ');
	const statements = cleaned.split(';').map((s) => s.trim()).filter(Boolean);
	await db.batch(statements.map((sql) => db.prepare(sql)));
}

async function cleanDB(): Promise<void> {
	await env.DB.exec('DELETE FROM task_tags;');
	await env.DB.exec('DELETE FROM tags;');
	await env.DB.exec('DELETE FROM tasks;');
	await env.DB.exec('DELETE FROM users;');
}

// ─── HTTP helper ──────────────────────────────────────────────────────────────
async function req(
	method: string,
	path: string,
	options: { body?: unknown; token?: string; cookie?: string } = {},
): Promise<{ status: number; body: Record<string, unknown>; headers: Headers }> {
	const headers: Record<string, string> = { 'Content-Type': 'application/json' };
	if (options.token) headers['Authorization'] = `Bearer ${options.token}`;
	if (options.cookie) headers['Cookie'] = options.cookie;

	const request = new Request(`http://localhost${path}`, {
		method,
		headers,
		body: options.body ? JSON.stringify(options.body) : undefined,
	});

	const ctx = createExecutionContext();
	const response = await worker.fetch(request, env, ctx);
	await waitOnExecutionContext(ctx);
	const body = (await response.json()) as Record<string, unknown>;
	return { status: response.status, body, headers: response.headers };
}

// ─── Auth helper: register + verify OTP → returns { token, refreshToken } ────
// The dev_otp is returned in the registration response when SEND_EMAIL is
// not configured. We use it to immediately verify and get a real JWT.
async function registerAndLogin(
	email = 'alice@test.com',
	name = 'Alice',
	password = 'password123',
): Promise<{ token: string; refreshToken: string }> {
	const regRes = await req('POST', '/auth/register', { body: { email, name, password } });
	const regData = regRes.body.data as Record<string, unknown>;

	// In test environment SEND_EMAIL is not configured → dev_otp is returned
	const devOtp = regData.dev_otp as string;
	if (!devOtp) throw new Error('dev_otp not returned — check SEND_EMAIL binding and ENVIRONMENT');

	const verifyRes = await req('POST', '/auth/verify-otp', { body: { email, otp: devOtp } });
	const verifyData = verifyRes.body.data as Record<string, unknown>;
	return {
		token: verifyData.token as string,
		refreshToken: verifyData.refreshToken as string,
	};
}

// ─── One-time setup ───────────────────────────────────────────────────────────
beforeAll(async () => { await applySchema(env.DB); });
beforeEach(async () => { await cleanDB(); });

// =============================================================================
describe('Health check', () => {
	it('GET /health → 200', async () => {
		const { status, body } = await req('GET', '/health');
		expect(status).toBe(200);
		expect((body.data as Record<string, unknown>).status).toBe('ok');
	});
});

// =============================================================================
describe('Auth — Register + OTP flow', () => {
	it('201 returns requiresVerification with dev_otp', async () => {
		const { status, body } = await req('POST', '/auth/register', {
			body: { email: 'alice@test.com', name: 'Alice', password: 'password123' },
		});
		expect(status).toBe(201);
		const data = body.data as Record<string, unknown>;
		expect(data.requiresVerification).toBe(true);
		expect(typeof data.dev_otp).toBe('string');
		expect((data.dev_otp as string)).toHaveLength(6);
	});

	it('200 verify-otp returns token + refreshToken + user (no password)', async () => {
		const regRes = await req('POST', '/auth/register', {
			body: { email: 'alice@test.com', name: 'Alice', password: 'password123' },
		});
		const otp = (regRes.body.data as Record<string, unknown>).dev_otp as string;

		const { status, body, headers } = await req('POST', '/auth/verify-otp', {
			body: { email: 'alice@test.com', otp },
		});
		expect(status).toBe(200);
		const data = body.data as Record<string, unknown>;
		expect(typeof data.token).toBe('string');
		expect(typeof data.refreshToken).toBe('string');
		const user = data.user as Record<string, unknown>;
		expect(user.email).toBe('alice@test.com');
		expect(user.password).toBeUndefined();
		expect(user.is_verified).toBe(1);
		// HttpOnly cookie should be set
		expect(headers.get('Set-Cookie')).toContain('refresh_token=');
		expect(headers.get('Set-Cookie')).toContain('HttpOnly');
	});

	it('400 invalid OTP', async () => {
		await req('POST', '/auth/register', {
			body: { email: 'alice@test.com', name: 'Alice', password: 'password123' },
		});
		const { status } = await req('POST', '/auth/verify-otp', {
			body: { email: 'alice@test.com', otp: '000000' },
		});
		expect(status).toBe(400);
	});

	it('400 OTP must be 6 digits', async () => {
		const { status } = await req('POST', '/auth/verify-otp', {
			body: { email: 'alice@test.com', otp: '12345' },
		});
		expect(status).toBe(400);
	});

	it('409 duplicate verified email', async () => {
		await registerAndLogin('alice@test.com');
		const { status, body } = await req('POST', '/auth/register', {
			body: { email: 'alice@test.com', name: 'Alice2', password: 'password123' },
		});
		expect(status).toBe(409);
		expect((body.error as Record<string, unknown>).code).toBe('CONFLICT');
	});

	it('400 missing required fields', async () => {
		const { status } = await req('POST', '/auth/register', { body: { name: 'Bob', password: 'password123' } });
		expect(status).toBe(400);
	});

	it('400 password under 8 chars', async () => {
		const { status } = await req('POST', '/auth/register', {
			body: { email: 'x@test.com', name: 'X', password: 'short' },
		});
		expect(status).toBe(400);
	});

	it('403 login blocked for unverified account', async () => {
		await req('POST', '/auth/register', {
			body: { email: 'unverified@test.com', name: 'UV', password: 'password123' },
		});
		const { status, body } = await req('POST', '/auth/login', {
			body: { email: 'unverified@test.com', password: 'password123' },
		});
		expect(status).toBe(403);
		expect((body.error as Record<string, unknown>).code).toBe('FORBIDDEN');
	});
});

// =============================================================================
describe('Auth — Login', () => {
	beforeEach(async () => {
		await registerAndLogin('alice@test.com');
	});

	it('200 correct credentials returns token + refreshToken + HttpOnly cookie', async () => {
		const { status, body, headers } = await req('POST', '/auth/login', {
			body: { email: 'alice@test.com', password: 'password123' },
		});
		expect(status).toBe(200);
		const data = body.data as Record<string, unknown>;
		expect(typeof data.token).toBe('string');
		expect(typeof data.refreshToken).toBe('string');
		expect(headers.get('Set-Cookie')).toContain('HttpOnly');
	});

	it('401 wrong password', async () => {
		const { status } = await req('POST', '/auth/login', {
			body: { email: 'alice@test.com', password: 'wrongpassword' },
		});
		expect(status).toBe(401);
	});

	it('401 non-existent email — same error (no user enumeration)', async () => {
		const { status, body } = await req('POST', '/auth/login', {
			body: { email: 'ghost@test.com', password: 'password123' },
		});
		expect(status).toBe(401);
		expect((body.error as Record<string, unknown>).code).toBe('UNAUTHORIZED');
	});
});

// =============================================================================
describe('Auth — Refresh token', () => {
	it('200 POST /auth/refresh with valid refresh token returns new tokens', async () => {
		const { refreshToken } = await registerAndLogin();
		const { status, body } = await req('POST', '/auth/refresh', {
			body: { refreshToken },
		});
		expect(status).toBe(200);
		const data = body.data as Record<string, unknown>;
		expect(typeof data.token).toBe('string');
		expect(typeof data.refreshToken).toBe('string');
	});

	it('200 POST /auth/refresh via HttpOnly cookie', async () => {
		const { refreshToken } = await registerAndLogin();
		const { status, body } = await req('POST', '/auth/refresh', {
			cookie: `refresh_token=${refreshToken}`,
		});
		expect(status).toBe(200);
		expect(typeof (body.data as Record<string, unknown>).token).toBe('string');
	});

	it('401 missing refresh token', async () => {
		const { status } = await req('POST', '/auth/refresh', {});
		expect(status).toBe(401);
	});

	it('401 tampered refresh token', async () => {
		const { status } = await req('POST', '/auth/refresh', {
			body: { refreshToken: 'invalid.refresh.token' },
		});
		expect(status).toBe(401);
	});
});

// =============================================================================
describe('Auth — Me', () => {
	let token: string;

	beforeEach(async () => {
		({ token } = await registerAndLogin());
	});

	it('200 returns current user', async () => {
		const { status, body } = await req('GET', '/auth/me', { token });
		expect(status).toBe(200);
		expect((body.data as Record<string, unknown>).email).toBe('alice@test.com');
	});

	it('401 without token', async () => {
		const { status } = await req('GET', '/auth/me');
		expect(status).toBe(401);
	});

	it('401 malformed token', async () => {
		const { status } = await req('GET', '/auth/me', { token: 'not.a.real.token' });
		expect(status).toBe(401);
	});
});

// =============================================================================
describe('Tasks — CRUD', () => {
	let token: string;
	let taskId: number;

	beforeEach(async () => {
		({ token } = await registerAndLogin());
		const { body } = await req('POST', '/tasks', {
			token,
			body: { title: 'Write unit tests', priority: 'high', status: 'in_progress', due_date: '2026-12-31' },
		});
		taskId = (body.data as Record<string, unknown>).id as number;
	});

	it('201 creates task', async () => {
		const { status, body } = await req('POST', '/tasks', {
			token,
			body: { title: 'New task', priority: 'low', status: 'todo' },
		});
		expect(status).toBe(201);
		expect((body.data as Record<string, unknown>).title).toBe('New task');
	});

	it('400 missing title', async () => {
		const { status } = await req('POST', '/tasks', { token, body: { priority: 'high' } });
		expect(status).toBe(400);
	});

	it('400 invalid status', async () => {
		const { status } = await req('POST', '/tasks', { token, body: { title: 'X', status: 'flying' } });
		expect(status).toBe(400);
	});

	it('200 GET /tasks with pagination meta', async () => {
		const { status, body } = await req('GET', '/tasks', { token });
		expect(status).toBe(200);
		expect(Array.isArray(body.data)).toBe(true);
		const meta = body.meta as Record<string, unknown>;
		expect(typeof meta.total).toBe('number');
	});

	it('200 GET /tasks/:id', async () => {
		const { status, body } = await req('GET', `/tasks/${taskId}`, { token });
		expect(status).toBe(200);
		expect((body.data as Record<string, unknown>).id).toBe(taskId);
	});

	it('200 PATCH sets status done + auto completed_at', async () => {
		const { status, body } = await req('PATCH', `/tasks/${taskId}`, { token, body: { status: 'done' } });
		expect(status).toBe(200);
		const task = body.data as Record<string, unknown>;
		expect(task.status).toBe('done');
		expect(task.completed_at).not.toBeNull();
	});

	it('200 DELETE removes task', async () => {
		const { status } = await req('DELETE', `/tasks/${taskId}`, { token });
		expect(status).toBe(200);
		const { status: getStatus } = await req('GET', `/tasks/${taskId}`, { token });
		expect(getStatus).toBe(404);
	});

	it('404 task not found', async () => {
		const { status } = await req('GET', '/tasks/99999', { token });
		expect(status).toBe(404);
	});

	it('401 without token', async () => {
		const { status } = await req('GET', '/tasks');
		expect(status).toBe(401);
	});
});

// =============================================================================
describe('Tags — CRUD including PATCH', () => {
	let token: string;
	let tagId: number;

	beforeEach(async () => {
		({ token } = await registerAndLogin());
		const { body } = await req('POST', '/tags', { token, body: { name: 'work', color: '#ef4444' } });
		tagId = (body.data as Record<string, unknown>).id as number;
	});

	it('201 creates tag', async () => {
		const { status, body } = await req('POST', '/tags', { token, body: { name: 'personal', color: '#6366f1' } });
		expect(status).toBe(201);
		expect((body.data as Record<string, unknown>).name).toBe('personal');
	});

	it('400 invalid hex color', async () => {
		const { status } = await req('POST', '/tags', { token, body: { name: 'bad', color: 'red' } });
		expect(status).toBe(400);
	});

	it('409 duplicate tag name', async () => {
		const { status } = await req('POST', '/tags', { token, body: { name: 'work' } });
		expect(status).toBe(409);
	});

	it('200 GET /tags returns list', async () => {
		const { status, body } = await req('GET', '/tags', { token });
		expect(status).toBe(200);
		expect((body.data as unknown[]).length).toBeGreaterThan(0);
	});

	it('200 PATCH /tags/:id renames tag', async () => {
		const { status, body } = await req('PATCH', `/tags/${tagId}`, { token, body: { name: 'renamed' } });
		expect(status).toBe(200);
		expect((body.data as Record<string, unknown>).name).toBe('renamed');
	});

	it('200 PATCH /tags/:id recolors tag', async () => {
		const { status, body } = await req('PATCH', `/tags/${tagId}`, { token, body: { color: '#00ff00' } });
		expect(status).toBe(200);
		expect((body.data as Record<string, unknown>).color).toBe('#00ff00');
	});

	it('400 PATCH with invalid hex color', async () => {
		const { status } = await req('PATCH', `/tags/${tagId}`, { token, body: { color: 'blue' } });
		expect(status).toBe(400);
	});

	it('400 PATCH with empty body', async () => {
		const { status } = await req('PATCH', `/tags/${tagId}`, { token, body: {} });
		expect(status).toBe(400);
	});

	it('404 PATCH non-existent tag', async () => {
		const { status } = await req('PATCH', '/tags/99999', { token, body: { name: 'ghost' } });
		expect(status).toBe(404);
	});

	it('200 DELETE /tags/:id', async () => {
		const { status } = await req('DELETE', `/tags/${tagId}`, { token });
		expect(status).toBe(200);
	});
});

// =============================================================================
// CROSS-USER ISOLATION TESTS
// These are the most important security tests — they verify that User B
// cannot read, modify, or delete resources that belong to User A.
// The absence of these tests was called out in the security review.
// =============================================================================
describe('Security — Cross-user data isolation', () => {
	let aliceToken: string;
	let bobToken: string;
	let aliceTaskId: number;
	let aliceTagId: number;

	beforeEach(async () => {
		// Create two independent users
		([{ token: aliceToken }, { token: bobToken }] = await Promise.all([
			registerAndLogin('alice@test.com', 'Alice'),
			registerAndLogin('bob@test.com', 'Bob'),
		]));

		// Alice creates a task and a tag
		const [taskRes, tagRes] = await Promise.all([
			req('POST', '/tasks', { token: aliceToken, body: { title: "Alice's private task", priority: 'high', status: 'todo' } }),
			req('POST', '/tags', { token: aliceToken, body: { name: "alice-tag", color: '#ff0000' } }),
		]);
		aliceTaskId = (taskRes.body.data as Record<string, unknown>).id as number;
		aliceTagId = (tagRes.body.data as Record<string, unknown>).id as number;
	});

	it("Bob cannot read Alice's task", async () => {
		const { status } = await req('GET', `/tasks/${aliceTaskId}`, { token: bobToken });
		expect(status).toBe(404); // not 200, not 403 — 404 prevents object enumeration
	});

	it("Bob cannot update Alice's task", async () => {
		const { status } = await req('PATCH', `/tasks/${aliceTaskId}`, {
			token: bobToken,
			body: { title: "Hacked by Bob" },
		});
		expect(status).toBe(404);
	});

	it("Bob cannot delete Alice's task", async () => {
		const { status } = await req('DELETE', `/tasks/${aliceTaskId}`, { token: bobToken });
		expect(status).toBe(404);
		// Task still accessible by Alice
		const { status: aliceStatus } = await req('GET', `/tasks/${aliceTaskId}`, { token: aliceToken });
		expect(aliceStatus).toBe(200);
	});

	it("Bob cannot see Alice's tags in GET /tags", async () => {
		const { body } = await req('GET', '/tags', { token: bobToken });
		const tags = body.data as Record<string, unknown>[];
		const aliceTagVisible = tags.some((t) => t.id === aliceTagId);
		expect(aliceTagVisible).toBe(false);
	});

	it("Bob cannot update Alice's tag", async () => {
		const { status } = await req('PATCH', `/tags/${aliceTagId}`, {
			token: bobToken,
			body: { name: 'stolen' },
		});
		expect(status).toBe(404);
	});

	it("Bob cannot delete Alice's tag", async () => {
		const { status } = await req('DELETE', `/tags/${aliceTagId}`, { token: bobToken });
		expect(status).toBe(404);
		// Tag still accessible by Alice
		const { body } = await req('GET', '/tags', { token: aliceToken });
		const tags = body.data as Record<string, unknown>[];
		expect(tags.some((t) => t.id === aliceTagId)).toBe(true);
	});

	it("Bob's GET /tasks only returns his own tasks (not Alice's)", async () => {
		// Bob creates his own task
		await req('POST', '/tasks', { token: bobToken, body: { title: "Bob's task", status: 'todo', priority: 'low' } });

		const { body } = await req('GET', '/tasks', { token: bobToken });
		const tasks = body.data as Record<string, unknown>[];
		const aliceTaskVisible = tasks.some((t) => t.id === aliceTaskId);
		expect(aliceTaskVisible).toBe(false);
		expect(tasks.every((t) => t.title !== "Alice's private task")).toBe(true);
	});

	it('IDOR: Bob cannot attach Alice\'s tag to his task', async () => {
		// Bob creates a task and tries to attach Alice's tag ID
		const { body: taskBody } = await req('POST', '/tasks', {
			token: bobToken,
			body: { title: "Bob's task", status: 'todo', priority: 'low', tag_ids: [aliceTagId] },
		});
		const bobTask = taskBody.data as Record<string, unknown>;
		// Alice's tag should NOT appear on Bob's task
		expect((bobTask.tags as unknown[]).length).toBe(0);
	});
});

// =============================================================================
describe('Security headers', () => {
	async function getHeaders(path: string): Promise<Headers> {
		const request = new Request(`http://localhost${path}`);
		const ctx = createExecutionContext();
		const res = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		return res.headers;
	}

	it('X-Content-Type-Options: nosniff', async () => {
		expect((await getHeaders('/health')).get('X-Content-Type-Options')).toBe('nosniff');
	});

	it('X-Frame-Options: DENY', async () => {
		expect((await getHeaders('/health')).get('X-Frame-Options')).toBe('DENY');
	});

	it('Strict-Transport-Security present', async () => {
		expect((await getHeaders('/health')).get('Strict-Transport-Security')).toContain('max-age=');
	});

	it('OPTIONS preflight → 204 with CORS headers', async () => {
		const request = new Request('http://localhost/tasks', { method: 'OPTIONS' });
		const ctx = createExecutionContext();
		const res = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(res.status).toBe(204);
		expect(res.headers.get('Access-Control-Allow-Methods')).toContain('GET');
	});
});

// =============================================================================
describe('WAF — Malicious input detection', () => {
	let token: string;

	beforeEach(async () => {
		({ token } = await registerAndLogin());
	});

	it('403 SQL injection in URL', async () => {
		const { status } = await req('GET', "/tasks?search=' OR 1=1--", { token });
		expect(status).toBe(403);
	});

	it('403 XSS in POST body', async () => {
		const { status } = await req('POST', '/tasks', {
			token,
			body: { title: '<script>alert(1)</script>' },
		});
		expect(status).toBe(403);
	});

	it('403 path traversal in URL', async () => {
		const { status } = await req('GET', '/tasks/../../../etc/passwd', { token });
		expect(status).toBe(403);
	});
});
