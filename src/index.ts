import type { Env, PostRow, SummaryRow } from './types.js';
import {
  createPost, getChannel, getChannelBySecret,
  listChannels, getRecentPosts, getSummaries, getHighestSummary,
  maybeSummarize,
} from './db.js';
import { SUMMARY_TIERS } from './pyramid.js';
import { renderAdminPage, renderChannelPage, renderFeedPage } from './ui.js';

const CHANNEL_RE = /^[a-z0-9][a-z0-9_-]*(?:\/[a-z0-9][a-z0-9_-]*)?$/;
const MAX_POST_SIZE = 4096;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function err(status: number, code: string, message: string): Response {
  return json({ error: code, message }, status);
}

function checkAuth(req: Request, env: Env): boolean {
  const auth = req.headers.get('authorization');
  return auth === `Bearer ${env.MESH_API_KEY}`;
}

function checkPin(url: URL, env: Env): boolean {
  return url.searchParams.get('pin') === env.ADMIN_PIN;
}

function tierLabel(idx: number): string {
  return SUMMARY_TIERS[idx]?.label ?? `tier ${idx}`;
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    // --- Public channel pages: /s/{secret} ---
    if (path.startsWith('/s/')) {
      const secret = path.slice(3);
      if (!secret) return err(404, 'not_found', 'Channel not found.');
      const channel = await getChannelBySecret(env.DB, secret);
      if (!channel) return err(404, 'not_found', 'Channel not found.');
      const tiers = await getSummaries(env.DB, channel.name);
      const { posts } = await getRecentPosts(env.DB, channel.name, { limit: 20 });
      return new Response(renderChannelPage(channel, tiers, posts), {
        headers: { 'content-type': 'text/html;charset=utf-8' },
      });
    }

    // --- Admin view: / with PIN ---
    if (path === '/' && req.method === 'GET') {
      if (!checkPin(url, env)) {
        const channels = await listChannels(env.DB);
        const allPosts: PostRow[] = [];
        for (const ch of channels) {
          const { posts } = await getRecentPosts(env.DB, ch.name, { limit: 5 });
          allPosts.push(...posts);
        }
        allPosts.sort((a, b) => b.created_at.localeCompare(a.created_at));
        return new Response(renderFeedPage(channels, allPosts.slice(0, 50)), {
          headers: { 'content-type': 'text/html;charset=utf-8' },
        });
      }

      const channels = await listChannels(env.DB);
      const summaryMap = new Map<string, SummaryRow | null>();
      for (const ch of channels) {
        summaryMap.set(ch.name, await getHighestSummary(env.DB, ch.name));
      }
      return new Response(renderAdminPage(channels, summaryMap), {
        headers: { 'content-type': 'text/html;charset=utf-8' },
      });
    }

    // --- API routes: /api/* ---
    if (path.startsWith('/api')) {
      if (req.method !== 'GET' && req.method !== 'POST') {
        return err(405, 'method_not_allowed', 'Only GET and POST are supported.');
      }

      if (!checkAuth(req, env)) {
        return err(401, 'unauthorized', 'Set Authorization: Bearer {api-key}. GET /api for channel listing.');
      }

      // GET /api - channel listing
      if (path === '/api' || path === '/api/') {
        const channels = await listChannels(env.DB);
        const channelInfos = [];
        for (const ch of channels) {
          const summary = await getHighestSummary(env.DB, ch.name);
          channelInfos.push({
            name: ch.name,
            posts: ch.post_count,
            latest: ch.created_at,
            summary: summary?.text ?? null,
          });
        }
        return json({
          channels: channelInfos,
          hint: 'GET /api/{channel} for full portrait. GET /api/{channel}?raw=true for recent posts. POST /api/{channel} with JSON body {"text":"..."} to publish.',
        });
      }

      const channelName = decodeURIComponent(path.slice(5)); // strip /api/
      if (!channelName || !CHANNEL_RE.test(channelName)) {
        return err(400, 'invalid_channel', `Channel name must match ${CHANNEL_RE}. Use lowercase letters, numbers, hyphens, underscores. Optional single slash for agent/topic.`);
      }

      // POST /api/{channel}
      if (req.method === 'POST') {
        let body: { text?: string };
        try {
          body = await req.json() as { text?: string };
        } catch {
          return err(400, 'invalid_json', 'POST body must be JSON. Example: { "text": "your update here" }');
        }

        if (!body.text || typeof body.text !== 'string') {
          return err(400, 'missing_field', 'POST body must include a "text" field. Example: { "text": "your update here" }');
        }

        if (body.text.length > MAX_POST_SIZE) {
          return err(400, 'text_too_long', `Post text must be under ${MAX_POST_SIZE} characters.`);
        }

        const result = await createPost(env.DB, channelName, body.text);

        ctx.waitUntil(maybeSummarize(env, channelName));

        if (result.secret) {
          return json({ id: result.id, secret: result.secret }, 201);
        }
        return json({ id: result.id }, 201);
      }

      // GET /api/{channel}
      const channel = await getChannel(env.DB, channelName);
      if (!channel) {
        return err(404, 'not_found', `Channel "${channelName}" does not exist. POST to /api/${channelName} to create it.`);
      }

      const raw = url.searchParams.get('raw') === 'true';
      const since = url.searchParams.get('since') ?? undefined;
      const before = url.searchParams.get('before') ?? undefined;

      if (raw) {
        const { posts, hasMore } = await getRecentPosts(env.DB, channelName, { since, before });
        return json({ channel: channelName, posts, has_more: hasMore });
      }

      // Portrait mode: tiers + recent raw tail
      const allSummaries = await getSummaries(env.DB, channelName);
      let tiers = allSummaries.map(s => ({
        tier: s.tier,
        label: tierLabel(s.tier),
        range: [s.start_ts.slice(0, 10), s.end_ts.slice(0, 10)],
        sources: s.source_count,
        text: s.text,
      }));

      if (since) {
        tiers = tiers.filter(t => t.range[1]! >= since.slice(0, 10));
      }

      const { posts: recent } = await getRecentPosts(env.DB, channelName, { since, limit: 10 });

      return json({
        channel: channelName,
        tiers,
        recent,
        total_posts: channel.post_count,
      });
    }

    return err(404, 'not_found', 'Try /api for the API or / for the feed.');
  },
};
