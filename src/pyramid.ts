import type { TierDef, PostRow } from './types.js';

const DAY_MS = 86_400_000;
const MAX_INPUT_CHARS = 14_000;

export const SUMMARY_TIERS: TierDef[] = [
  { idx: 0, maxAgeDays: 30, targetChars: 1200, label: 'last 30 days' },
  { idx: 1, maxAgeDays: 90, targetChars: 900, label: '1-3 months ago' },
  { idx: 2, maxAgeDays: 365, targetChars: 700, label: '3-12 months ago' },
  { idx: 3, maxAgeDays: Infinity, targetChars: 500, label: 'over a year ago' },
];

export const REBUILD_THRESHOLD = 8;

export function tierForAgeDays(ageDays: number): number {
  for (const t of SUMMARY_TIERS) if (ageDays < t.maxAgeDays) return t.idx;
  return SUMMARY_TIERS.length - 1;
}

export interface TierBucket {
  tier: TierDef;
  posts: PostRow[];
}

export function bucketPosts(posts: PostRow[], now: number): TierBucket[] {
  const byTier = new Map<number, PostRow[]>();
  for (const p of posts) {
    const ageDays = (now - new Date(p.created_at).getTime()) / DAY_MS;
    const t = tierForAgeDays(ageDays);
    (byTier.get(t) ?? byTier.set(t, []).get(t)!).push(p);
  }
  return SUMMARY_TIERS
    .filter(t => byTier.has(t.idx))
    .map(t => ({ tier: t, posts: byTier.get(t.idx)!.sort((a, b) => a.created_at.localeCompare(b.created_at)) }));
}

function isoDate(ts: string): string { return ts.slice(0, 10); }

const SYNTH_SYSTEM = `You synthesize an AI agent's activity log into one compact narrative. Preserve names, decisions, numbers, dates, and specific details. Trace the arc: what developed, what shifted, what's still open. Output ONLY the synthesis prose, no preamble or headers. Hold to the target length - older windows compress harder.`;

export interface SynthJob {
  system: string;
  user: string;
  maxTokens: number;
  startTs: string;
  endTs: string;
  sourceCount: number;
  tier: number;
}

export function buildSynthJob(channelName: string, bucket: TierBucket): SynthJob {
  const posts = bucket.posts;
  const selected: PostRow[] = [];
  let used = 0;
  for (let i = posts.length - 1; i >= 0; i--) {
    const line = `- [${isoDate(posts[i]!.created_at)}] ${posts[i]!.text}`;
    if (used + line.length > MAX_INPUT_CHARS && selected.length > 0) break;
    selected.push(posts[i]!);
    used += line.length + 1;
  }
  selected.reverse();
  const omitted = posts.length - selected.length;
  const body = selected.map(p => `- [${isoDate(p.created_at)}] ${p.text}`).join('\n');
  const omittedNote = omitted > 0 ? `\n(${omitted} older posts in this window omitted for length.)` : '';

  const startTs = posts[0]!.created_at;
  const endTs = posts[posts.length - 1]!.created_at;
  const user = `Channel: ${channelName}\nWindow: ${bucket.tier.label} (${isoDate(startTs)} – ${isoDate(endTs)})\n\nPosts (oldest first):\n${body}${omittedNote}\n\nWrite a ~${bucket.tier.targetChars}-character synthesis capturing the arc of this window.`;

  return {
    system: SYNTH_SYSTEM,
    user,
    maxTokens: Math.ceil(bucket.tier.targetChars / 3.3) + 50,
    startTs,
    endTs,
    sourceCount: posts.length,
    tier: bucket.tier.idx,
  };
}
