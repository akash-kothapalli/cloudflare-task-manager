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

	const cleaned = SCHEMA.replace(/--[^\n]*/g, '')
		.replace(/[\n\t]+/g, ' ')
		.replace(/\s{2,}/g, ' ');

	const statements = cleaned
		.split(';')
		.map((s) => s.trim())
		.filter(Boolean);

	await db.batch(statements.map((sql) => db.prepare(sql)));
}

// ─── Wipe all data between tests ──────────────────────────────────────────────
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
	options: { body?: unknown; token?: string } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
	const headers: Record<string, string> = { 'Content-Type': 'application/json' };
	if (options.token) headers['Authorization'] = `Bearer ${options.token}`;

	const request = new Request(`http://localhost${path}`, {
		method,
		headers,
		body: options.body ? JSON.stringify(options.body) : undefined,
	});

	const ctx = createExecutionContext();
	const response = await worker.fetch(request, env, ctx);
	await waitOnExecutionContext(ctx);
	const body = (await response.json()) as Record<string, unknown>;
	return { status: response.status, body };
}

// ─── Auth helper: register a fresh user and return token ─────────────────────
//
// WHY: Every describe block that needs an authenticated user calls this in its
// own beforeEach. Because beforeEach already wiped the DB, each call starts
// with a guaranteed-empty users table, so there are no duplicate-email races.
//
async function registerAndLogin(email = 'alice@test.com', name = 'Alice', password = 'password123'): Promise<string> {
	const res = await req('POST', '/auth/register', {
		body: { email, name, password },
	});
	return (res.body.data as Record<string, unknown>).token as string;
}

// ─── One-time schema apply ────────────────────────────────────────────────────
beforeAll(async () => {
	await applySchema(env.DB);
});

// ─── Wipe before EVERY it() ───────────────────────────────────────────────────
beforeEach(async () => {
	await cleanDB();
});

// =============================================================================
describe('Health check', () => {
	it('GET /health → 200 with status ok', async () => {
		const { status, body } = await req('GET', '/health');
		expect(status).toBe(200);
		expect((body.data as Record<string, unknown>).status).toBe('ok');
	});
});

// =============================================================================
describe('Auth — Register', () => {
	it('201 creates account, returns token + user (no password)', async () => {
		const { status, body } = await req('POST', '/auth/register', {
			body: { email: 'alice@test.com', name: 'Alice', password: 'password123' },
		});
		expect(status).toBe(201);
		const data = body.data as Record<string, unknown>;
		expect(typeof data.token).toBe('string');
		const user = data.user as Record<string, unknown>;
		expect(user.email).toBe('alice@test.com');
		expect(user.name).toBe('Alice');
		expect(user.password).toBeUndefined();
	});

	it('400 when email missing', async () => {
		const { status, body } = await req('POST', '/auth/register', {
			body: { name: 'Bob', password: 'password123' },
		});
		expect(status).toBe(400);
		expect((body.error as Record<string, unknown>).code).toBe('BAD_REQUEST');
	});

	it('400 when name missing', async () => {
		const { status } = await req('POST', '/auth/register', {
			body: { email: 'bob@test.com', password: 'password123' },
		});
		expect(status).toBe(400);
	});

	it('400 when password under 8 chars', async () => {
		const { status } = await req('POST', '/auth/register', {
			body: { email: 'x@test.com', name: 'X', password: 'short' },
		});
		expect(status).toBe(400);
	});

	it('409 duplicate email', async () => {
		// Register alice once inside this test — beforeEach already cleaned the DB
		await req('POST', '/auth/register', {
			body: { email: 'alice@test.com', name: 'Alice', password: 'password123' },
		});

		// Attempt a second registration with the same email
		const { status, body } = await req('POST', '/auth/register', {
			body: { email: 'alice@test.com', name: 'Alice2', password: 'password123' },
		});
		expect(status).toBe(409);
		expect((body.error as Record<string, unknown>).code).toBe('CONFLICT');
	});
});

// =============================================================================
describe('Auth — Login', () => {
	// Each test in this block needs a pre-existing user to log in against.
	// WHY beforeEach here rather than a single beforeAll: the top-level
	// beforeEach wipes the DB before every it(), so we must re-create the user
	// before each test as well.
	let registeredEmail: string;
	let registeredPassword: string;

	beforeEach(async () => {
		registeredEmail = 'alice@test.com';
		registeredPassword = 'password123';
		await req('POST', '/auth/register', {
			body: { email: registeredEmail, name: 'Alice', password: registeredPassword },
		});
	});

	it('200 correct credentials', async () => {
		const { status, body } = await req('POST', '/auth/login', {
			body: { email: registeredEmail, password: registeredPassword },
		});
		expect(status).toBe(200);
		const data = body.data as Record<string, unknown>;
		expect(typeof data.token).toBe('string');
		expect((data.user as Record<string, unknown>).password).toBeUndefined();
	});

	it('401 wrong password', async () => {
		const { status, body } = await req('POST', '/auth/login', {
			body: { email: registeredEmail, password: 'wrongpassword' },
		});
		expect(status).toBe(401);
		expect((body.error as Record<string, unknown>).code).toBe('UNAUTHORIZED');
	});

	it('401 non-existent email — same error as wrong password (no user enumeration)', async () => {
		const { status, body } = await req('POST', '/auth/login', {
			body: { email: 'ghost@test.com', password: 'password123' },
		});
		expect(status).toBe(401);
		expect((body.error as Record<string, unknown>).code).toBe('UNAUTHORIZED');
	});
});

// =============================================================================
describe('Auth — Me', () => {
	let token: string;

	beforeEach(async () => {
		token = await registerAndLogin();
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
describe('Tasks — Create', () => {
	let token: string;

	beforeEach(async () => {
		token = await registerAndLogin();
	});

	it('201 creates task with all fields', async () => {
		const { status, body } = await req('POST', '/tasks', {
			token,
			body: {
				title: 'Write unit tests',
				description: 'Cover all endpoints',
				priority: 'high',
				status: 'in_progress',
				due_date: '2026-12-31',
			},
		});
		expect(status).toBe(201);
		const task = body.data as Record<string, unknown>;
		expect(task.title).toBe('Write unit tests');
		expect(task.priority).toBe('high');
		expect(task.status).toBe('in_progress');
		expect(task.due_date).toBe('2026-12-31');
		expect(typeof task.id).toBe('number');
	});

	it('400 when title missing', async () => {
		const { status, body } = await req('POST', '/tasks', {
			token,
			body: { priority: 'high' },
		});
		expect(status).toBe(400);
		expect((body.error as Record<string, unknown>).code).toBe('BAD_REQUEST');
	});

	it('400 invalid status value', async () => {
		const { status } = await req('POST', '/tasks', {
			token,
			body: { title: 'Bad', status: 'flying' },
		});
		expect(status).toBe(400);
	});

	it('400 invalid priority value', async () => {
		const { status } = await req('POST', '/tasks', {
			token,
			body: { title: 'Bad', priority: 'extreme' },
		});
		expect(status).toBe(400);
	});

	it('401 without token', async () => {
		const { status } = await req('POST', '/tasks', { body: { title: 'Unauth' } });
		expect(status).toBe(401);
	});
});

// =============================================================================
describe('Tasks — Read', () => {
	let token: string;
	let createdTaskId: number;

	beforeEach(async () => {
		token = await registerAndLogin();

		// Create a task so read tests have data to work with
		const { body } = await req('POST', '/tasks', {
			token,
			body: {
				title: 'Write unit tests',
				priority: 'high',
				status: 'in_progress',
				due_date: '2026-12-31',
			},
		});
		createdTaskId = (body.data as Record<string, unknown>).id as number;
	});

	it('200 returns list with pagination meta', async () => {
		const { status, body } = await req('GET', '/tasks', { token });
		expect(status).toBe(200);
		expect(Array.isArray(body.data)).toBe(true);
		const meta = body.meta as Record<string, unknown>;
		expect(typeof meta.total).toBe('number');
		expect(typeof meta.page).toBe('number');
		expect(typeof meta.limit).toBe('number');
	});

	it('200 filters by status=in_progress', async () => {
		const { status, body } = await req('GET', '/tasks?status=in_progress', { token });
		expect(status).toBe(200);
		(body.data as Record<string, unknown>[]).forEach((t) => expect(t.status).toBe('in_progress'));
	});

	it('400 invalid status filter', async () => {
		const { status } = await req('GET', '/tasks?status=flying', { token });
		expect(status).toBe(400);
	});

	it('200 GET /tasks/:id returns single task', async () => {
		const { status, body } = await req('GET', `/tasks/${createdTaskId}`, { token });
		expect(status).toBe(200);
		expect((body.data as Record<string, unknown>).id).toBe(createdTaskId);
	});

	it('404 non-existent task', async () => {
		const { status, body } = await req('GET', '/tasks/99999', { token });
		expect(status).toBe(404);
		expect((body.error as Record<string, unknown>).code).toBe('NOT_FOUND');
	});

	it('401 GET /tasks without token', async () => {
		const { status } = await req('GET', '/tasks');
		expect(status).toBe(401);
	});
});

// =============================================================================
describe('Tasks — Update (PATCH)', () => {
	let token: string;
	let createdTaskId: number;

	beforeEach(async () => {
		token = await registerAndLogin();

		const { body } = await req('POST', '/tasks', {
			token,
			body: {
				title: 'Write unit tests',
				priority: 'high',
				status: 'in_progress',
				due_date: '2026-12-31',
			},
		});
		createdTaskId = (body.data as Record<string, unknown>).id as number;
	});

	it('200 status → done auto-sets completed_at', async () => {
		const { status, body } = await req('PATCH', `/tasks/${createdTaskId}`, {
			token,
			body: { status: 'done' },
		});
		expect(status).toBe(200);
		const task = body.data as Record<string, unknown>;
		expect(task.status).toBe('done');
		expect(task.completed_at).not.toBeNull();
	});

	it('200 partial update — only title changes, status unchanged', async () => {
		// First mark done so we can confirm status doesn't regress
		await req('PATCH', `/tasks/${createdTaskId}`, {
			token,
			body: { status: 'done' },
		});

		const { status, body } = await req('PATCH', `/tasks/${createdTaskId}`, {
			token,
			body: { title: 'Updated title' },
		});
		expect(status).toBe(200);
		const task = body.data as Record<string, unknown>;
		expect(task.title).toBe('Updated title');
		expect(task.status).toBe('done'); // unchanged
	});

	it('400 empty body', async () => {
		const { status } = await req('PATCH', `/tasks/${createdTaskId}`, {
			token,
			body: {},
		});
		expect(status).toBe(400);
	});

	it('404 non-existent task', async () => {
		const { status } = await req('PATCH', '/tasks/99999', {
			token,
			body: { title: 'Ghost' },
		});
		expect(status).toBe(404);
	});
});

// =============================================================================
describe('Tags', () => {
	let token: string;
	let createdTagId: number;

	beforeEach(async () => {
		token = await registerAndLogin();
	});

	it('201 creates tag', async () => {
		const { status, body } = await req('POST', '/tags', {
			token,
			body: { name: 'work', color: '#ef4444' },
		});
		expect(status).toBe(201);
		const tag = body.data as Record<string, unknown>;
		expect(tag.name).toBe('work');
		expect(tag.color).toBe('#ef4444');
	});

	it('400 invalid hex color', async () => {
		const { status } = await req('POST', '/tags', {
			token,
			body: { name: 'bad', color: 'red' },
		});
		expect(status).toBe(400);
	});

	it('409 duplicate tag name', async () => {
		// Create the tag first within this test
		await req('POST', '/tags', { token, body: { name: 'work' } });

		const { status, body } = await req('POST', '/tags', {
			token,
			body: { name: 'work' },
		});
		expect(status).toBe(409);
		expect((body.error as Record<string, unknown>).code).toBe('CONFLICT');
	});

	it('200 GET /tags returns user tags', async () => {
		await req('POST', '/tags', { token, body: { name: 'work' } });

		const { status, body } = await req('GET', '/tags', { token });
		expect(status).toBe(200);
		expect((body.data as unknown[]).length).toBeGreaterThan(0);
	});

	it('200 DELETE /tags/:id', async () => {
		const { body } = await req('POST', '/tags', {
			token,
			body: { name: 'work', color: '#ef4444' },
		});
		createdTagId = (body.data as Record<string, unknown>).id as number;

		const { status } = await req('DELETE', `/tags/${createdTagId}`, { token });
		expect(status).toBe(200);
	});

	it('404 DELETE already-deleted tag', async () => {
		// Create then delete within this test
		const { body } = await req('POST', '/tags', {
			token,
			body: { name: 'work', color: '#ef4444' },
		});
		const tagId = (body.data as Record<string, unknown>).id as number;

		await req('DELETE', `/tags/${tagId}`, { token });

		const { status } = await req('DELETE', `/tags/${tagId}`, { token });
		expect(status).toBe(404);
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
		expect(res.headers.get('Access-Control-Allow-Origin')).toBeTruthy();
		expect(res.headers.get('Access-Control-Allow-Methods')).toContain('GET');
	});
});

// =============================================================================
describe('Tasks — Delete', () => {
	let token: string;
	let createdTaskId: number;

	beforeEach(async () => {
		token = await registerAndLogin();

		const { body } = await req('POST', '/tasks', {
			token,
			body: { title: 'Task to delete', priority: 'low', status: 'todo' },
		});
		createdTaskId = (body.data as Record<string, unknown>).id as number;
	});

	it('200 DELETE /tasks/:id', async () => {
		const { status, body } = await req('DELETE', `/tasks/${createdTaskId}`, { token });
		expect(status).toBe(200);
		expect(body.success).toBe(true);
	});

	it('404 DELETE already-deleted task', async () => {
		await req('DELETE', `/tasks/${createdTaskId}`, { token });

		const { status } = await req('DELETE', `/tasks/${createdTaskId}`, { token });
		expect(status).toBe(404);
	});
});
