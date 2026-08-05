import type { Env, ChannelRow, PostRow, SummaryRow } from './types.js';
import { SUMMARY_TIERS, REBUILD_THRESHOLD, bucketPosts, buildSynthJob } from './pyramid.js';
import { synthesize } from './synth.js';

const SCHEMA = `
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
);`;

export async function ensureSchema(db: D1Database): Promise<void> {
  for (const stmt of SCHEMA.split(';').map(s => s.trim()).filter(Boolean)) {
    await db.prepare(stmt).run();
  }
}

function genId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

function genSecret(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

export async function createPost(
  db: D1Database,
  channel: string,
  text: string,
): Promise<{ id: string; secret?: string }> {
  const id = genId();
  let secret: string | undefined;

  const existing = await db.prepare('SELECT name FROM channels WHERE name = ?').bind(channel).first<ChannelRow>();
  if (!existing) {
    secret = genSecret();
    await db.prepare(
      'INSERT INTO channels (name, secret, post_count) VALUES (?, ?, 1)'
    ).bind(channel, secret).run();
  } else {
    await db.prepare(
      'UPDATE channels SET post_count = post_count + 1 WHERE name = ?'
    ).bind(channel).run();
  }

  await db.prepare(
    'INSERT INTO posts (id, channel, text) VALUES (?, ?, ?)'
  ).bind(id, channel, text).run();

  return { id, secret };
}

export async function getChannel(db: D1Database, name: string): Promise<ChannelRow | null> {
  return db.prepare('SELECT * FROM channels WHERE name = ?').bind(name).first<ChannelRow>();
}

export async function getChannelBySecret(db: D1Database, secret: string): Promise<ChannelRow | null> {
  return db.prepare('SELECT * FROM channels WHERE secret = ?').bind(secret).first<ChannelRow>();
}

export async function listChannels(db: D1Database): Promise<ChannelRow[]> {
  const result = await db.prepare(
    'SELECT * FROM channels ORDER BY name'
  ).all<ChannelRow>();
  return result.results;
}

export async function getRecentPosts(
  db: D1Database,
  channel: string,
  opts: { limit?: number; since?: string; before?: string } = {},
): Promise<{ posts: PostRow[]; hasMore: boolean }> {
  const limit = Math.min(opts.limit ?? 20, 20);
  const conditions: string[] = ['channel = ?'];
  const params: (string | number)[] = [channel];

  if (opts.since) {
    conditions.push('created_at > ?');
    params.push(opts.since);
  }
  if (opts.before) {
    conditions.push('created_at < ?');
    params.push(opts.before);
  }

  params.push(limit + 1);
  const result = await db.prepare(
    `SELECT * FROM posts WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC LIMIT ?`
  ).bind(...params).all<PostRow>();

  const hasMore = result.results.length > limit;
  const posts = result.results.slice(0, limit);
  return { posts, hasMore };
}

export async function getAllPosts(db: D1Database, channel: string): Promise<PostRow[]> {
  const result = await db.prepare(
    'SELECT * FROM posts WHERE channel = ? ORDER BY created_at ASC'
  ).bind(channel).all<PostRow>();
  return result.results;
}

export async function getSummaries(db: D1Database, channel: string): Promise<SummaryRow[]> {
  const result = await db.prepare(
    'SELECT * FROM summaries WHERE channel = ? ORDER BY tier ASC'
  ).bind(channel).all<SummaryRow>();
  return result.results;
}

export async function getHighestSummary(db: D1Database, channel: string): Promise<SummaryRow | null> {
  return db.prepare(
    'SELECT * FROM summaries WHERE channel = ? ORDER BY tier DESC LIMIT 1'
  ).bind(channel).first<SummaryRow>();
}

export async function maybeSummarize(
  env: Env,
  channel: string,
): Promise<void> {
  const ch = await getChannel(env.DB, channel);
  if (!ch) return;
  if (ch.post_count - ch.last_summarized_count < REBUILD_THRESHOLD) return;

  const posts = await getAllPosts(env.DB, channel);
  if (posts.length === 0) return;

  const buckets = bucketPosts(posts, Date.now());

  for (const bucket of buckets) {
    const job = buildSynthJob(channel, bucket);
    try {
      const text = await synthesize(env.AI, job.system, job.user, { maxTokens: job.maxTokens });
      if (!text) continue;

      await env.DB.prepare(`
        INSERT INTO summaries (id, channel, tier, text, start_ts, end_ts, source_count)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(channel, tier) DO UPDATE SET
          text = excluded.text,
          start_ts = excluded.start_ts,
          end_ts = excluded.end_ts,
          source_count = excluded.source_count,
          created_at = datetime('now')
      `).bind(genId(), channel, job.tier, text, job.startTs, job.endTs, job.sourceCount).run();
    } catch (e) {
      console.error(`Summary generation failed for ${channel} tier ${job.tier}:`, e);
    }
  }

  await env.DB.prepare(
    'UPDATE channels SET last_summarized_count = post_count WHERE name = ?'
  ).bind(channel).run();
}
