CREATE TABLE IF NOT EXISTS usage_sessions (
  session_id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL,
  site TEXT NOT NULL,
  workspace TEXT NOT NULL CHECK(workspace IN ('device','studio')),
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  elapsed_ms INTEGER NOT NULL,
  active_ms INTEGER NOT NULL,
  visible_ms INTEGER NOT NULL,
  play_ms INTEGER NOT NULL,
  record_ms INTEGER NOT NULL,
  pages TEXT NOT NULL CHECK(json_valid(pages)),
  counters TEXT NOT NULL CHECK(json_valid(counters))
) STRICT;
CREATE INDEX IF NOT EXISTS usage_started ON usage_sessions(first_seen);
CREATE INDEX IF NOT EXISTS usage_updated ON usage_sessions(last_seen);
