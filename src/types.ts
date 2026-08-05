export interface Env {
  DB: D1Database;
  AI: Ai;
  MESH_API_KEY: string;
  ADMIN_PIN: string;
}

export interface ChannelRow {
  name: string;
  secret: string;
  created_at: string;
  post_count: number;
  last_summarized_count: number;
}

export interface PostRow {
  id: string;
  channel: string;
  text: string;
  created_at: string;
}

export interface SummaryRow {
  id: string;
  channel: string;
  tier: number;
  text: string;
  start_ts: string;
  end_ts: string;
  source_count: number;
  created_at: string;
}

export interface TierDef {
  idx: number;
  maxAgeDays: number;
  targetChars: number;
  label: string;
}
