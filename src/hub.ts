/**
 * One Durable Object per person: the place a new message announces itself, so nothing has to poll.
 *
 * - Daemons hold a websocket here, tagged with their agent id. The object hibernates between messages, so an
 *   idle socket costs nothing. Pings get an automatic pong without waking it.
 * - An `ask` or `reply` waiting for an answer parks here until the answer arrives or its time runs out.
 * - When a message is posted, the recipient's object hears `message(agent, conversation, at)` and wakes both.
 *
 * It carries ids and times only, never message text. Losing it loses nothing: daemons still check every few
 * minutes, and waiters recheck the database.
 */
import { DurableObject } from 'cloudflare:workers';
import { Mesh, type Events } from './mesh.js';
import type { Env } from './index.js';

interface Waiter { agent: string; conversation: string; after: number; done: (hit: boolean) => void }

export class Hub extends DurableObject<Env> {
  private waiters = new Set<Waiter>();
  /** Newest message time per agent+conversation, while the object is awake. */
  private latest = new Map<string, number>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  /** A daemon's websocket. The Worker has already checked its token and passes its agent id. */
  async fetch(request: Request) {
    const agent = new URL(request.url).searchParams.get('agent');
    if (request.headers.get('upgrade') !== 'websocket' || !agent) return new Response('Expected a websocket', { status: 426 });
    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server, [agent]);
    server.send(JSON.stringify({ type: 'hello' }));
    return new Response(null, { status: 101, webSocket: client });
  }

  async message(agent: string, conversation: string, at: number) {
    const k = `${agent}:${conversation}`;
    this.latest.set(k, Math.max(at, this.latest.get(k) ?? 0));
    for (const ws of this.ctx.getWebSockets(agent)) {
      try { ws.send(JSON.stringify({ type: 'message', conversation })); } catch {}
    }
    for (const w of this.waiters) if (w.agent === agent && w.conversation === conversation && at > w.after) w.done(true);
  }

  /** Something other than a message changed for this agent (a request answered, a pair approved). */
  async nudge(agent: string) {
    for (const ws of this.ctx.getWebSockets(agent)) {
      try { ws.send(JSON.stringify({ type: 'inbox' })); } catch {}
    }
  }

  /** Resolves true when a message newer than `after` reaches this agent in this conversation, false after `ms`. */
  async wait(agent: string, conversation: string, after: number, ms: number): Promise<boolean> {
    if ((this.latest.get(`${agent}:${conversation}`) ?? 0) > after) return true;
    return new Promise((resolve) => {
      const w: Waiter = { agent, conversation, after, done: (hit) => { clearTimeout(t); this.waiters.delete(w); resolve(hit); } };
      const t = setTimeout(() => w.done(false), ms);
      this.waiters.add(w);
    });
  }

  async webSocketMessage() {}
  async webSocketClose(ws: WebSocket, code: number) { try { ws.close(code, 'bye'); } catch {} }
  async webSocketError() {}
}

/** Mesh events go to the recipient's Hub (one Durable Object per person). */
export const hubEvents = (env: Env): Events => {
  const hub = (person: string) => env.HUB.get(env.HUB.idFromName(person));
  return {
    message: (person, agent, conversation, at) => hub(person).message(agent, conversation, at),
    nudge: (person, agent) => hub(person).nudge(agent),
    wait: (person, agent, conversation, after, ms) => hub(person).wait(agent, conversation, after, ms),
  };
};
export const meshFor = (env: Env) => new Mesh(env.DB, hubEvents(env));
