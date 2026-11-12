/**
 * A small JSON API for the daemon (agent/mesh-agent.mjs), behind the same OAuth tokens as /mcp.
 * The daemon answers conversations on its owner's machine; it needs structured data, not prose.
 */
import { Mesh, MeshError, fullName, type AgentRow, type Caller } from './mesh.js';
import { GUIDE, STRANGER_RULE } from './mcp.js';
import type { Env } from './index.js';

const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'cache-control': 'no-store' } });
const agentJson = (a: AgentRow, caller: Caller) => ({ name: fullName(a), owner: a.handle, own: a.owner === caller.person, about: a.about });

export async function handleApi(request: Request, env: Env, caller: Caller): Promise<Response> {
  const mesh = new Mesh(env.DB);
  const path = new URL(request.url).pathname;
  try {
    await mesh.touch(caller.agent);
    if (path === '/api/me') {
      const a = (await mesh.agent(caller.agent))!;
      return json({ ...agentJson(a, caller), rule: STRANGER_RULE, guide: GUIDE });
    }
    if (path === '/api/inbox') {
      const { conversations, answered, waiting } = await mesh.inbox(caller);
      return json({
        conversations: conversations.map((c) => ({ id: c.id, topic: c.topic, other: agentJson(c.other, caller), startedByMe: c.startedByMe, unread: c.unread, live: c.live })),
        answered: answered.map((r) => ({ id: r.id, kind: r.kind, status: r.status, to: `${r.to_handle}/${r.to_name}` })),
        waiting: waiting.map((r) => ({ id: r.id, from: `${r.from_handle}/${r.from_name}`, reason: r.reason })),
      });
    }
    const m = /^\/api\/conversations\/([A-Za-z0-9_-]+)(\/reply)?$/.exec(path);
    if (m && !m[2] && request.method === 'GET') {
      const r = await mesh.read(caller, m[1]!);
      return json({
        id: r.id, topic: r.topic, other: agentJson(r.other, caller), startedByMe: r.startedByMe, live: !r.grant.ended_at && (r.grant.ends_at === null || r.grant.ends_at > Date.now()),
        messages: r.messages.map((x) => ({ id: x.id, mine: x.mine, at: x.at, text: x.text })),
      });
    }
    if (m && m[2] && request.method === 'POST') {
      const { text } = (await request.json()) as { text?: string };
      return json(await mesh.post(caller, m[1]!, String(text ?? '')));
    }
    return json({ error: 'not_found' }, 404);
  } catch (e) {
    if (e instanceof MeshError) return json({ error: e.message }, 400);
    throw e;
  }
}
