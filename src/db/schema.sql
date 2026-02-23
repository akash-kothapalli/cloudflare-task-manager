-- =============================================================================
-- cloudflare-task-manager  —  D1 Schema
-- Run locally : wrangler d1 execute cloudflare-task-manager-db --file=src/db/schema.sql
-- Run remote  : wrangler d1 execute cloudflare-task-manager-db --remote --file=src/db/schema.sql
-- =============================================================================



-- =============================================================================
-- TABLE: users
-- =============================================================================
CREATE TABLE IF NOT EXISTS users (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  email        TEXT    NOT NULL UNIQUE,
  name         TEXT    NOT NULL DEFAULT '',        -- display name
  password     TEXT    NOT NULL,                   -- PBKDF2 hash: "saltHex:hashHex"
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Fast lookup by email (used on every login)
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- =============================================================================
-- TABLE: tasks
-- =============================================================================
CREATE TABLE IF NOT EXISTS tasks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,

  -- Ownership — every task belongs to exactly one user
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- Core fields
  title         TEXT    NOT NULL,
  description   TEXT,                              -- nullable: not all tasks need details

  -- Status lifecycle: todo → in_progress → done (or cancelled)
  -- CHECK constraint enforced at DB level — not just application level
  status        TEXT    NOT NULL DEFAULT 'todo'
                  CHECK(status IN ('todo', 'in_progress', 'done', 'cancelled')),

  -- Priority for sorting / filtering
  priority      TEXT    NOT NULL DEFAULT 'medium'
                  CHECK(priority IN ('low', 'medium', 'high', 'critical')),

  -- Scheduling
  due_date      TEXT,                              -- ISO-8601: "2026-03-15"
  completed_at  TEXT,                              -- set when status → done

  -- Workers AI enrichment (populated async after task creation)
  ai_summary    TEXT,                              -- one-sentence AI summary
  ai_sentiment  TEXT                               -- positive | neutral | negative
                  CHECK(ai_sentiment IS NULL OR ai_sentiment IN ('positive', 'neutral', 'negative')),

  -- Audit timestamps
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Indexes for the most common query patterns
CREATE INDEX IF NOT EXISTS idx_tasks_user_id         ON tasks(user_id);
CREATE INDEX IF NOT EXISTS idx_tasks_user_status      ON tasks(user_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_user_priority    ON tasks(user_id, priority);
CREATE INDEX IF NOT EXISTS idx_tasks_user_due_date    ON tasks(user_id, due_date);

-- =============================================================================
-- TABLE: tags  (reusable labels created per-user)
-- =============================================================================
CREATE TABLE IF NOT EXISTS tags (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT    NOT NULL,
  color      TEXT    NOT NULL DEFAULT '#6366f1',   -- hex colour for UI badges
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),

  -- A user cannot have two tags with the same name
  UNIQUE(user_id, name)
);

CREATE INDEX IF NOT EXISTS idx_tags_user_id ON tags(user_id);

-- =============================================================================
-- TABLE: task_tags  (many-to-many: one task can have many tags)
-- =============================================================================
CREATE TABLE IF NOT EXISTS task_tags (
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  tag_id  INTEGER NOT NULL REFERENCES tags(id)  ON DELETE CASCADE,
  PRIMARY KEY (task_id, tag_id)   -- composite PK prevents duplicate joins
);

CREATE INDEX IF NOT EXISTS idx_task_tags_task_id ON task_tags(task_id);
CREATE INDEX IF NOT EXISTS idx_task_tags_tag_id  ON task_tags(tag_id);