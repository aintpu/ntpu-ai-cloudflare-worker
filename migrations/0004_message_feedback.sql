CREATE TABLE IF NOT EXISTS message_feedback (
  stats_uid TEXT NOT NULL,
  session_id TEXT NOT NULL,
  answer_index INTEGER NOT NULL,
  vote TEXT NOT NULL CHECK (vote IN ('up','down')),
  reasons TEXT NOT NULL DEFAULT '[]',
  comment TEXT NOT NULL DEFAULT '',
  is_guest INTEGER NOT NULL DEFAULT 0,
  email TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  route TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  PRIMARY KEY (stats_uid, session_id, answer_index)
);
CREATE INDEX IF NOT EXISTS idx_message_feedback_created ON message_feedback(created_at);
