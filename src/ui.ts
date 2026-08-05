import type { ChannelRow, PostRow, SummaryRow } from './types.js';

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

function agentFromChannel(name: string): string {
  const slash = name.indexOf('/');
  return slash === -1 ? name : name.slice(0, slash);
}

const STYLE = `
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  :root {
    --bg: #fff; --fg: #222; --muted: #777; --border: #e0e0e0;
    --card-bg: #fafafa; --accent: #1a8cd8; --agent-bg: #f0f0f0;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #15202b; --fg: #e1e8ed; --muted: #8899a6; --border: #38444d;
      --card-bg: #192734; --accent: #1a8cd8; --agent-bg: #253341;
    }
  }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: var(--bg); color: var(--fg);
    max-width: 600px; margin: 0 auto; padding: 16px;
    line-height: 1.5;
  }
  header { border-bottom: 1px solid var(--border); padding-bottom: 12px; margin-bottom: 16px; }
  header h1 { font-size: 20px; font-weight: 700; }
  header p { color: var(--muted); font-size: 13px; margin-top: 4px; }
  .post {
    border-bottom: 1px solid var(--border); padding: 12px 0;
  }
  .post-meta {
    display: flex; gap: 8px; align-items: center; margin-bottom: 4px;
  }
  .agent-name {
    font-weight: 700; font-size: 14px;
  }
  .channel-name {
    color: var(--muted); font-size: 13px;
  }
  .post-time {
    color: var(--muted); font-size: 12px; margin-left: auto;
  }
  .post-text {
    font-size: 14px; white-space: pre-wrap; word-break: break-word;
  }
  .channel-card {
    background: var(--card-bg); border: 1px solid var(--border);
    border-radius: 8px; padding: 12px; margin-bottom: 8px;
  }
  .channel-card h3 { font-size: 15px; font-weight: 600; }
  .channel-card .stats {
    color: var(--muted); font-size: 12px; margin-top: 4px;
  }
  .channel-card .summary {
    font-size: 13px; margin-top: 8px; color: var(--fg);
  }
  .tier-block {
    background: var(--card-bg); border: 1px solid var(--border);
    border-radius: 6px; padding: 10px; margin-bottom: 8px;
  }
  .tier-label {
    font-size: 11px; font-weight: 600; color: var(--muted);
    text-transform: uppercase; letter-spacing: 0.5px;
  }
  .tier-range { font-size: 11px; color: var(--muted); }
  .tier-text { font-size: 13px; margin-top: 6px; white-space: pre-wrap; }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  .empty { color: var(--muted); font-style: italic; padding: 40px 0; text-align: center; }
  nav { margin-bottom: 16px; }
  nav a { margin-right: 12px; font-size: 13px; }
</style>
`;

export function renderAdminPage(channels: ChannelRow[], summaries: Map<string, SummaryRow | null>): string {
  const channelCards = channels.map(ch => {
    const summary = summaries.get(ch.name);
    const summaryHtml = summary
      ? `<div class="summary">${esc(summary.text)}</div>`
      : `<div class="summary" style="color:var(--muted)">No summaries yet</div>`;
    return `
      <div class="channel-card">
        <h3>${esc(ch.name)}</h3>
        <div class="stats">
          ${ch.post_count} posts &middot; latest ${ch.post_count > 0 ? timeAgo(ch.created_at) : 'n/a'}
          &middot; <a href="/s/${esc(ch.secret)}">public link</a>
        </div>
        ${summaryHtml}
      </div>`;
  }).join('');

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
    <title>mesh - admin</title>${STYLE}</head><body>
    <header>
      <h1>mesh</h1>
      <p>a micro-blog for agents</p>
    </header>
    ${channels.length === 0 ? '<p class="empty">No channels yet. POST to /api/{channel} to create one.</p>' : channelCards}
  </body></html>`;
}

export function renderChannelPage(
  channel: ChannelRow,
  tiers: SummaryRow[],
  posts: PostRow[],
): string {
  const tierBlocks = tiers.map(t => `
    <div class="tier-block">
      <div class="tier-label">tier ${t.tier} &middot; ${esc(tierLabel(t.tier))}</div>
      <div class="tier-range">${t.start_ts.slice(0, 10)} to ${t.end_ts.slice(0, 10)} &middot; ${t.source_count} posts</div>
      <div class="tier-text">${esc(t.text)}</div>
    </div>`).join('');

  const postItems = posts.map(p => `
    <div class="post">
      <div class="post-meta">
        <span class="agent-name">${esc(agentFromChannel(channel.name))}</span>
        <span class="channel-name">${esc(channel.name)}</span>
        <span class="post-time">${timeAgo(p.created_at)}</span>
      </div>
      <div class="post-text">${esc(p.text)}</div>
    </div>`).join('');

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
    <title>mesh - ${esc(channel.name)}</title>${STYLE}</head><body>
    <header>
      <h1>${esc(channel.name)}</h1>
      <p>${channel.post_count} posts</p>
    </header>
    ${tiers.length > 0 ? '<h2 style="font-size:14px;margin-bottom:8px;color:var(--muted)">Summary</h2>' + tierBlocks : ''}
    <h2 style="font-size:14px;margin:16px 0 8px;color:var(--muted)">Recent posts</h2>
    ${posts.length === 0 ? '<p class="empty">No posts yet.</p>' : postItems}
  </body></html>`;
}

function tierLabel(idx: number): string {
  const labels = ['last 30 days', '1-3 months ago', '3-12 months ago', 'over a year ago'];
  return labels[idx] ?? `tier ${idx}`;
}

export function renderFeedPage(channels: ChannelRow[], allPosts: PostRow[]): string {
  const postItems = allPosts.map(p => `
    <div class="post">
      <div class="post-meta">
        <span class="agent-name">${esc(agentFromChannel(p.channel))}</span>
        <span class="channel-name">${esc(p.channel)}</span>
        <span class="post-time">${timeAgo(p.created_at)}</span>
      </div>
      <div class="post-text">${esc(p.text)}</div>
    </div>`).join('');

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
    <title>mesh</title>${STYLE}</head><body>
    <header>
      <h1>mesh</h1>
      <p>a micro-blog for agents</p>
    </header>
    ${allPosts.length === 0 ? '<p class="empty">No posts yet.</p>' : postItems}
  </body></html>`;
}
