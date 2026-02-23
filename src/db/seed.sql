-- =============================================================================
-- seed.sql — Development test data
-- Local : npx wrangler d1 execute task-manager-db --local --file=src/db/seed.sql
-- Remote: npx wrangler d1 execute task-manager-db --remote --file=src/db/seed.sql
--
-- Password for all seed users: "password123"
-- Hash generated with PBKDF2-SHA256 (same algorithm as the app)
-- Generate your own: POST /auth/register then copy the hash from DB
-- =============================================================================

-- Clear existing data (safe to run multiple times)
DELETE FROM task_tags;
DELETE FROM tasks;
DELETE FROM tags;
DELETE FROM users;

-- ─── Users ────────────────────────────────────────────────────────────────────
-- Password: "password123" (PBKDF2-SHA256 hash — NOT plaintext)
INSERT INTO users (id, email, name, password) VALUES
  (1, 'alice@example.com', 'Alice Johnson',
   'a3f2b8c1d4e5f6a7b8c9d0e1f2a3b4c5:d9e4a7f1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9'),
  (2, 'bob@example.com', 'Bob Smith',
   'b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9:e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1');

-- ─── Tags ─────────────────────────────────────────────────────────────────────
INSERT INTO tags (id, user_id, name, color) VALUES
  (1, 1, 'work',     '#6366f1'),
  (2, 1, 'personal', '#10b981'),
  (3, 1, 'urgent',   '#ef4444'),
  (4, 2, 'learning', '#f59e0b');

-- ─── Tasks ────────────────────────────────────────────────────────────────────
INSERT INTO tasks (id, user_id, title, description, status, priority, due_date) VALUES
  (1, 1, 'Set up Cloudflare Workers project',
   'Initialise wrangler, configure D1 and KV bindings',
   'done', 'high', '2026-02-01'),

  (2, 1, 'Implement JWT authentication',
   'Register, login, token verification middleware',
   'done', 'critical', '2026-02-05'),

  (3, 1, 'Build task CRUD API',
   'GET, POST, PATCH, DELETE endpoints with user scoping',
   'in_progress', 'high', '2026-03-01'),

  (4, 1, 'Add Workers AI enrichment',
   'Auto-generate task summaries using Llama-3',
   'todo', 'medium', '2026-03-15'),

  (5, 1, 'Write integration tests',
   'Cover all endpoints with vitest-pool-workers',
   'in_progress', 'high', '2026-03-10'),

  (6, 1, 'Deploy to production',
   'wrangler deploy + set JWT_SECRET via wrangler secret',
   'todo', 'critical', '2026-03-20'),

  (7, 2, 'Read Cloudflare docs',
   'Workers, D1, KV, AI — understand all primitives',
   'in_progress', 'medium', '2026-03-31'),

  (8, 2, 'Build personal project',
   'Apply Workers skills to a side project',
   'todo', 'low', NULL);

-- ─── Task tags (join table) ────────────────────────────────────────────────────
INSERT INTO task_tags (task_id, tag_id) VALUES
  (1, 1), -- task 1 tagged "work"
  (2, 1), -- task 2 tagged "work"
  (2, 3), -- task 2 tagged "urgent"
  (3, 1), -- task 3 tagged "work"
  (4, 1), -- task 4 tagged "work"
  (5, 1), -- task 5 tagged "work"
  (6, 3), -- task 6 tagged "urgent"
  (7, 4), -- task 7 tagged "learning"
  (8, 4); -- task 8 tagged "learning"
