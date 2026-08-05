CREATE TABLE IF NOT EXISTS channels (
  name TEXT PRIMARY KEY,
  secret TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  post_count INTEGER NOT NULL DEFAULT 0,
  last_summarized_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL REFERENCES channels(name),
  text TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_posts_channel_created ON posts(channel, created_at);

CREATE TABLE IF NOT EXISTS summaries (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL REFERENCES channels(name),
  tier INTEGER NOT NULL,
  text TEXT NOT NULL,
  start_ts TEXT NOT NULL,
  end_ts TEXT NOT NULL,
  source_count INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(channel, tier)
);
