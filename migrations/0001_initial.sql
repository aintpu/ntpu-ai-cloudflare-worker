PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  uid TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  is_admin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  last_login_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS magic_links (
  token_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  uid TEXT NOT NULL,
  session_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '對話',
  history_json TEXT NOT NULL DEFAULT '[]',
  question_count INTEGER NOT NULL DEFAULT 0,
  memory_pending_since TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (uid, session_id),
  FOREIGN KEY (uid) REFERENCES users(uid) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_sessions_uid_updated ON sessions(uid, updated_at DESC);

CREATE TABLE IF NOT EXISTS profiles (
  uid TEXT PRIMARY KEY,
  system_prompt TEXT NOT NULL DEFAULT '',
  memory TEXT NOT NULL DEFAULT '',
  memory_updated_at TEXT,
  FOREIGN KEY (uid) REFERENCES users(uid) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS usage_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stats_uid TEXT NOT NULL,
  email TEXT NOT NULL DEFAULT '',
  session_id TEXT NOT NULL,
  access_type TEXT NOT NULL,
  model TEXT NOT NULL,
  route TEXT NOT NULL,
  score REAL NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  guest_id_encrypted TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_created ON usage_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_usage_stats_uid ON usage_logs(stats_uid);

CREATE TABLE IF NOT EXISTS feedback (
  stats_uid TEXT NOT NULL,
  session_id TEXT NOT NULL,
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  is_guest INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  PRIMARY KEY (stats_uid, session_id)
);

CREATE TABLE IF NOT EXISTS shares (
  share_id TEXT PRIMARY KEY,
  owner_uid TEXT NOT NULL,
  session_id TEXT NOT NULL,
  title TEXT NOT NULL,
  history_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_config (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rate_limits (
  limiter_key TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (limiter_key, window_start)
);
