/**
 * The rules, in one place: who can find whom, who can talk to whom, and what an agent can read.
 * Everything else (MCP tools, the daemon API, the web pages) calls into here.
 */
import { newGrantKey, openText, randomId, sealText, unwrapGrantKey, wrapTo } from './crypto.js';

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
export const DURATIONS: Record<string, number | null> = { '1h': HOUR, '6h': 6 * HOUR, '12h': 12 * HOUR, '24h': DAY, 'none': null };

export interface Person { id: string; sub: string; email: string; handle: string | null; pub: string; sealed_priv: string; created_at: number }
export interface Agent { id: string; owner: string; name: string; about: string; visible: number; mode: string; created_at: number; seen_at: number | null }
export interface AgentRow extends Agent { handle: string }
export interface Grant { id: string; a: string; b: string; self: number; created_at: number; ends_at: number | null; ended_at: number | null }
export interface Request { id: string; kind: 'pair' | 'extend'; from_agent: string; to_agent: string; reason: string; status: string; created_at: number; answered_at: number | null; grant_id: string | null; seen: number }

/** Who is calling: an agent, its owner, and the owner's private key (from the OAuth grant). */
export interface Caller { person: string; agent: string; priv: string }

export class MeshError extends Error {}
const fail = (msg: string): never => { throw new MeshError(msg); };

const now = () => Date.now();
const pair = (x: string, y: string) => (x < y ? [x, y] : [y, x]) as [string, string];
export const fullName = (a: { handle: string; name: string }) => `${a.handle}/${a.name}`;
export const isLive = (g: Grant, t = now()) => !g.ended_at && (g.ends_at === null || g.ends_at > t);

export const HANDLE = /^[a-z][a-z0-9-]{1,19}$/;
export const AGENT_NAME = /^[a-z][a-z0-9-]{0,29}$/;

/** How Mesh tells the outside world something happened (the Hub, in production). Optional, so tests can skip it. */
export interface Events {
  message(person: string, agent: string, conversation: string, at: number): Promise<void>;
  nudge(person: string, agent: string): Promise<void>;
  wait(person: string, agent: string, conversation: string, after: number, ms: number): Promise<boolean>;
}

export class Mesh {
  constructor(private db: D1Database, private events?: Events) {}

  private one<T>(sql: string, ...args: unknown[]) { return this.db.prepare(sql).bind(...args).first<T>(); }
  private all<T>(sql: string, ...args: unknown[]) { return this.db.prepare(sql).bind(...args).all<T>().then((r) => r.results); }
  private run(sql: string, ...args: unknown[]) { return this.db.prepare(sql).bind(...args).run(); }

  // ---------- people ----------

  personBySub(sub: string) { return this.one<Person>('SELECT * FROM people WHERE sub = ?', sub); }
  person(id: string) { return this.one<Person>('SELECT * FROM people WHERE id = ?', id); }
  personByHandle(handle: string) { return this.one<Person>('SELECT * FROM people WHERE handle = ?', handle); }

  async createPerson(sub: string, email: string, pub: string, sealedPriv: string): Promise<Person> {
    const id = randomId('p_');
    await this.run('INSERT INTO people (id, sub, email, pub, sealed_priv, created_at) VALUES (?, ?, ?, ?, ?, ?)', id, sub, email.toLowerCase(), pub, sealedPriv, now());
    return (await this.person(id))!;
  }

  async setHandle(person: string, handle: string) {
    handle = handle.trim().toLowerCase();
    if (!HANDLE.test(handle)) fail('A handle is 2 to 20 characters: lowercase letters, digits and dashes, starting with a letter.');
    const taken = await this.personByHandle(handle);
    if (taken && taken.id !== person) fail(`"${handle}" is taken.`);
    await this.run('UPDATE people SET handle = ? WHERE id = ?', handle, person);
  }

  // ---------- connections between people ----------

  async connected(x: string, y: string) {
    if (x === y) return true;
    const [a, b] = pair(x, y);
    return Boolean(await this.one('SELECT 1 FROM connections WHERE a = ? AND b = ?', a, b));
  }

  async connect(x: string, y: string) {
    if (x === y) return;
    const [a, b] = pair(x, y);
    await this.run('INSERT OR IGNORE INTO connections (a, b, created_at) VALUES (?, ?, ?)', a, b, now());
  }

  /** Disconnecting ends every live grant between the two people's agents. */
  async disconnect(x: string, y: string) {
    const [a, b] = pair(x, y);
    await this.run('DELETE FROM connections WHERE a = ? AND b = ?', a, b);
    await this.run(
      `UPDATE grants SET ended_at = ? WHERE ended_at IS NULL AND self = 0 AND (
         (a IN (SELECT id FROM agents WHERE owner = ?) AND b IN (SELECT id FROM agents WHERE owner = ?)) OR
         (a IN (SELECT id FROM agents WHERE owner = ?) AND b IN (SELECT id FROM agents WHERE owner = ?)))`,
      now(), x, y, y, x,
    );
  }

  connections(person: string) {
    return this.all<Person & { since: number }>(
      `SELECT p.*, c.created_at AS since FROM connections c JOIN people p ON p.id = CASE WHEN c.a = ? THEN c.b ELSE c.a END
       WHERE c.a = ? OR c.b = ? ORDER BY p.handle`, person, person, person,
    );
  }

  async invite(from: string, email: string): Promise<string> {
    const id = randomId('i_', 18);
    await this.run('INSERT INTO invites (id, from_person, email, created_at) VALUES (?, ?, ?, ?)', id, from, email.trim().toLowerCase(), now());
    return id;
  }

  async acceptInvite(id: string, person: Person): Promise<Person> {
    const inv = await this.one<{ from_person: string; email: string; used_at: number | null; created_at: number }>('SELECT * FROM invites WHERE id = ?', id);
    if (!inv) fail('This invite link is not valid.');
    if (inv!.used_at) fail('This invite has already been used.');
    if (now() - inv!.created_at > 14 * DAY) fail('This invite is more than two weeks old. Ask for a new one.');
    if (inv!.email !== person.email) fail(`This invite was sent to ${inv!.email}, and you are signed in as ${person.email}.`);
    await this.connect(inv!.from_person, person.id);
    await this.run('UPDATE invites SET used_at = ? WHERE id = ?', now(), id);
    return (await this.person(inv!.from_person))!;
  }

  // ---------- agents ----------

  agent(id: string) {
    return this.one<AgentRow>('SELECT a.*, p.handle FROM agents a JOIN people p ON p.id = a.owner WHERE a.id = ?', id);
  }

  agentsOf(person: string) {
    return this.all<AgentRow>('SELECT a.*, p.handle FROM agents a JOIN people p ON p.id = a.owner WHERE a.owner = ? ORDER BY a.name', person);
  }

  /** Find or make the agent a person is approving. Approving with an existing name reconnects that agent. */
  async upsertAgent(owner: string, name: string, about: string, visible: boolean): Promise<AgentRow> {
    name = name.trim().toLowerCase();
    if (!AGENT_NAME.test(name)) fail('An agent name is 1 to 30 characters: lowercase letters, digits and dashes, starting with a letter.');
    const existing = await this.one<Agent>('SELECT * FROM agents WHERE owner = ? AND name = ?', owner, name);
    if (existing) {
      await this.run('UPDATE agents SET visible = ?, about = CASE WHEN ? = \'\' THEN about ELSE ? END WHERE id = ?', visible ? 1 : 0, about, about, existing.id);
      return (await this.agent(existing.id))!;
    }
    const id = randomId('a_');
    await this.run('INSERT INTO agents (id, owner, name, about, visible, created_at) VALUES (?, ?, ?, ?, ?, ?)', id, owner, name, about.slice(0, 300), visible ? 1 : 0, now());
    return (await this.agent(id))!;
  }

  async describe(agent: string, about: string) {
    about = about.trim();
    if (!about) fail('Say something about this agent: who it belongs to and what it works on.');
    if (about.length > 300) fail('Keep it to one or two sentences (300 characters at most).');
    await this.run('UPDATE agents SET about = ? WHERE id = ?', about, agent);
  }

  async setVisible(owner: string, agent: string, visible: boolean) {
    await this.run('UPDATE agents SET visible = ? WHERE id = ? AND owner = ?', visible ? 1 : 0, agent, owner);
  }

  touch(agent: string) { return this.run('UPDATE agents SET seen_at = ? WHERE id = ?', now(), agent); }

  /** "tom/laptop" to an agent this caller may address: one of their own, or a visible agent of a connection. */
  async resolve(caller: Caller, ref: string): Promise<AgentRow> {
    const m = /^@?([a-z0-9-]+)\/([a-z0-9-]+)$/.exec(ref.trim().toLowerCase());
    if (!m) fail(`"${ref}" isn't an agent name. Agents are named person/agent, like tom/laptop. Call agents to see who you can reach.`);
    const a = await this.one<AgentRow>(
      'SELECT a.*, p.handle FROM agents a JOIN people p ON p.id = a.owner WHERE p.handle = ? AND a.name = ?', m![1], m![2],
    );
    const reachable = a && (a.owner === caller.person || (a.visible && (await this.connected(caller.person, a.owner))));
    if (!reachable) fail(`There's no agent ${ref} you can reach. Call agents to see your own agents and the ones your owner's connections have made visible.`);
    if (a!.id === caller.agent) fail('That is you.');
    return a!;
  }

  /** Your own agents, and the visible agents of your connections, each with where the pair stands. */
  async directory(caller: Caller) {
    const rows = await this.all<AgentRow>(
      `SELECT a.*, p.handle FROM agents a JOIN people p ON p.id = a.owner
       WHERE a.id != ? AND (a.owner = ? OR (a.visible = 1 AND a.owner IN (
         SELECT CASE WHEN a = ? THEN b ELSE a END FROM connections WHERE a = ? OR b = ?)))
       ORDER BY a.owner = ? DESC, p.handle, a.name`,
      caller.agent, caller.person, caller.person, caller.person, caller.person, caller.person,
    );
    const out = [];
    for (const a of rows) {
      const g = await this.liveGrant(caller.agent, a.id);
      const pending = g ? null : await this.one<Request>(
        "SELECT * FROM requests WHERE status = 'pending' AND ((from_agent = ? AND to_agent = ?) OR (from_agent = ? AND to_agent = ?))",
        caller.agent, a.id, a.id, caller.agent,
      );
      out.push({ agent: a, own: a.owner === caller.person, grant: g, pending });
    }
    return out;
  }

  // ---------- grants ----------

  liveGrant(x: string, y: string) {
    const [a, b] = pair(x, y);
    return this.one<Grant>(
      'SELECT * FROM grants WHERE a = ? AND b = ? AND ended_at IS NULL AND (ends_at IS NULL OR ends_at > ?) ORDER BY created_at DESC LIMIT 1', a, b, now(),
    );
  }

  latestGrant(x: string, y: string) {
    const [a, b] = pair(x, y);
    return this.one<Grant>('SELECT * FROM grants WHERE a = ? AND b = ? ORDER BY created_at DESC LIMIT 1', a, b);
  }

  grant(id: string) { return this.one<Grant>('SELECT * FROM grants WHERE id = ?', id); }

  private async makeGrant(x: AgentRow, y: AgentRow, endsAt: number | null): Promise<Grant> {
    const [a, b] = pair(x.id, y.id);
    const id = randomId('g_');
    const self = x.owner === y.owner;
    const key = newGrantKey();
    const owners = self ? [x.owner] : [x.owner, y.owner];
    const stmts = [this.db.prepare('INSERT INTO grants (id, a, b, self, created_at, ends_at) VALUES (?, ?, ?, ?, ?, ?)').bind(id, a, b, self ? 1 : 0, now(), endsAt)];
    for (const o of owners) {
      const p = (await this.person(o))!;
      stmts.push(this.db.prepare('INSERT INTO grant_keys (grant_id, person, wrapped) VALUES (?, ?, ?)').bind(id, o, await wrapTo(p.pub, key, id)));
    }
    await this.db.batch(stmts);
    return (await this.grant(id))!;
  }

  /** The grant between the caller and another agent, if it's live. Your own agents get one made on demand. */
  async grantFor(caller: Caller, other: AgentRow): Promise<Grant | null> {
    const g = await this.liveGrant(caller.agent, other.id);
    if (g) return g;
    if (other.owner === caller.person) return this.makeGrant((await this.agent(caller.agent))!, other, null);
    return null;
  }

  async grantKey(caller: Caller, grantId: string): Promise<string> {
    const row = await this.one<{ wrapped: string }>('SELECT wrapped FROM grant_keys WHERE grant_id = ? AND person = ?', grantId, caller.person);
    if (!row) fail('No key for this conversation.');
    const me = (await this.person(caller.person))!;
    return unwrapGrantKey(caller.priv, me.pub, row!.wrapped, grantId);
  }

  async endGrant(person: string, grantId: string) {
    const g = await this.grant(grantId);
    if (!g) fail('No such grant.');
    const a = await this.agent(g!.a), b = await this.agent(g!.b);
    if (a!.owner !== person && b!.owner !== person) fail('That grant is between other people\'s agents.');
    await this.run('UPDATE grants SET ended_at = ? WHERE id = ? AND ended_at IS NULL', now(), grantId);
  }

  /** Live grants touching any of a person's agents, for the dashboard. */
  grantsOf(person: string) {
    return this.all<Grant & { a_name: string; a_handle: string; b_name: string; b_handle: string }>(
      `SELECT g.*, aa.name AS a_name, pa.handle AS a_handle, ab.name AS b_name, pb.handle AS b_handle FROM grants g
       JOIN agents aa ON aa.id = g.a JOIN people pa ON pa.id = aa.owner
       JOIN agents ab ON ab.id = g.b JOIN people pb ON pb.id = ab.owner
       WHERE g.self = 0 AND g.ended_at IS NULL AND (g.ends_at IS NULL OR g.ends_at > ?) AND (aa.owner = ? OR ab.owner = ?)
       ORDER BY g.created_at DESC`, now(), person, person,
    );
  }

  // ---------- requests ----------

  request(id: string) { return this.one<Request>('SELECT * FROM requests WHERE id = ?', id); }

  /** Ask to talk to another person's agent. Returns the request, or null when no approval is needed. */
  async ask(caller: Caller, other: AgentRow, kind: 'pair' | 'extend', reason: string): Promise<{ request: Request; created: boolean } | null> {
    reason = reason.trim();
    if (other.owner === caller.person) return null;
    if (!reason) fail('Give a reason: one or two sentences the other person reads before deciding.');
    if (reason.length > 500) fail('Keep the reason under 500 characters.');
    if (kind === 'pair' && (await this.liveGrant(caller.agent, other.id))) fail(`You can already talk to ${fullName(other)}. Use ask.`);
    if (kind === 'extend' && !(await this.latestGrant(caller.agent, other.id))) fail(`You've never had a grant with ${fullName(other)}. Use request first.`);
    await this.expireRequests();
    const pending = await this.one<Request>(
      "SELECT * FROM requests WHERE from_agent = ? AND to_agent = ? AND kind = ? AND status = 'pending'", caller.agent, other.id, kind,
    );
    if (pending) return { request: pending, created: false };
    const declined = await this.one<Request>(
      "SELECT * FROM requests WHERE from_agent = ? AND to_agent = ? AND status = 'declined' AND answered_at > ?", caller.agent, other.id, now() - DAY,
    );
    if (declined) fail(`${fullName(other)}'s owner declined in the last day. You can ask again after ${new Date(declined.answered_at! + DAY).toISOString().slice(0, 16)}Z.`);
    const id = randomId('r_', 18);
    await this.run(
      "INSERT INTO requests (id, kind, from_agent, to_agent, reason, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)",
      id, kind, caller.agent, other.id, reason, now(),
    );
    return { request: (await this.request(id))!, created: true };
  }

  /** Requests older than a day that nobody answered. */
  expireRequests() {
    return this.run("UPDATE requests SET status = 'expired', answered_at = ? WHERE status = 'pending' AND created_at < ?", now(), now() - DAY);
  }

  async answer(person: string, requestId: string, duration: string | 'decline'): Promise<Request> {
    await this.expireRequests();
    const r = await this.request(requestId);
    if (!r) fail('No such request.');
    const to = (await this.agent(r!.to_agent))!;
    const from = (await this.agent(r!.from_agent))!;
    if (to.owner !== person) fail('This request is for someone else\'s agent.');
    if (r!.status !== 'pending') fail(`This request is already ${r!.status}.`);
    if (!(await this.connected(from.owner, to.owner))) fail('You are no longer connected to this person.');
    if (duration === 'decline') {
      await this.run("UPDATE requests SET status = 'declined', answered_at = ? WHERE id = ?", now(), requestId);
      await this.events?.nudge(from.owner, from.id).catch(() => {});
      return (await this.request(requestId))!;
    }
    if (!(duration in DURATIONS)) fail('Pick 1h, 6h, 12h, 24h or no limit.');
    const span = DURATIONS[duration] ?? null;
    let grantId: string;
    const latest = await this.latestGrant(from.id, to.id);
    if (r!.kind === 'extend' && latest && !latest.ended_at) {
      const base = Math.max(now(), latest.ends_at ?? now());
      await this.run('UPDATE grants SET ends_at = ? WHERE id = ?', span === null ? null : base + span, latest.id);
      grantId = latest.id;
    } else {
      grantId = (await this.makeGrant(from, to, span === null ? null : now() + span)).id;
    }
    await this.run("UPDATE requests SET status = 'approved', answered_at = ?, grant_id = ? WHERE id = ?", now(), grantId, requestId);
    await this.events?.nudge(from.owner, from.id).catch(() => {});
    return (await this.request(requestId))!;
  }

  pendingFor(person: string) {
    return this.all<Request & { from_name: string; from_handle: string; to_name: string }>(
      `SELECT r.*, fa.name AS from_name, fp.handle AS from_handle, ta.name AS to_name FROM requests r
       JOIN agents fa ON fa.id = r.from_agent JOIN people fp ON fp.id = fa.owner JOIN agents ta ON ta.id = r.to_agent
       WHERE r.status = 'pending' AND ta.owner = ? AND r.created_at > ? ORDER BY r.created_at`, person, now() - DAY,
    );
  }

  // ---------- conversations ----------

  private async participant(caller: Caller, conversation: string) {
    const c = await this.one<{ id: string; grant_id: string; started_by: string; topic: string; created_at: number; updated_at: number }>(
      'SELECT * FROM conversations WHERE id = ?', conversation,
    );
    if (!c) fail(`No conversation ${conversation}. Call conversations to list yours.`);
    const g = (await this.grant(c!.grant_id))!;
    if (g.a !== caller.agent && g.b !== caller.agent) fail(`No conversation ${conversation}. Call conversations to list yours.`);
    const other = (await this.agent(g.a === caller.agent ? g.b : g.a))!;
    return { c: c!, g, other };
  }

  async start(caller: Caller, other: AgentRow, topic: string, text: string) {
    topic = topic.trim() || text.trim().slice(0, 60);
    if (!text.trim()) fail('The message is empty.');
    const g = await this.grantFor(caller, other);
    if (!g) fail(`You don't have a grant to talk to ${fullName(other)}. Call request with a reason, and its owner will get an email to approve it.`);
    const key = await this.grantKey(caller, g!.id);
    const id = randomId('c_');
    const t = now();
    await this.run('INSERT INTO conversations (id, grant_id, started_by, topic, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      id, g!.id, caller.agent, await sealText(key, topic, `topic:${id}`), t, t);
    const m = await this.post(caller, id, text, key, g!);
    return { conversation: id, message: m };
  }

  async post(caller: Caller, conversation: string, text: string, key?: string, grant?: Grant) {
    if (!text.trim()) fail('The message is empty.');
    if (text.length > 20_000) fail('Messages are capped at 20,000 characters. Split it, or summarize.');
    let g = grant;
    if (!g) {
      const p = await this.participant(caller, conversation);
      g = p.g;
      if (!isLive(g)) {
        fail(p.other.owner === caller.person
          ? 'This conversation was ended.'
          : `The grant with ${fullName(p.other)} ${g.ended_at ? 'was ended' : 'ran out'}. Call extend with a reason to ask its owner for more time.`);
      }
    }
    key ??= await this.grantKey(caller, g.id);
    const id = randomId('m_');
    const t = now();
    await this.db.batch([
      this.db.prepare('INSERT INTO messages (id, conversation, sender, body, created_at) VALUES (?, ?, ?, ?, ?)')
        .bind(id, conversation, caller.agent, await sealText(key, text, `msg:${conversation}`), t),
      this.db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').bind(t, conversation),
      this.db.prepare('INSERT INTO reads (agent, conversation, read_at) VALUES (?, ?, ?) ON CONFLICT(agent, conversation) DO UPDATE SET read_at = excluded.read_at')
        .bind(caller.agent, conversation, t),
    ]);
    if (this.events) {
      const to = (await this.agent(g.a === caller.agent ? g.b : g.a))!;
      await this.events.message(to.owner, to.id, conversation, t).catch(() => {});
    }
    return { id, at: t };
  }

  /** A conversation's messages, decrypted, oldest first. Marks it read up to the newest. */
  async read(caller: Caller, conversation: string, since?: number, limit = 200, mark = true) {
    const { c, g, other } = await this.participant(caller, conversation);
    const key = await this.grantKey(caller, g.id);
    const rows = await this.all<{ id: string; sender: string; body: string; created_at: number }>(
      `SELECT * FROM (SELECT * FROM messages WHERE conversation = ? AND created_at > ? ORDER BY created_at DESC LIMIT ?) ORDER BY created_at`,
      conversation, since ?? 0, limit,
    );
    const messages = [];
    for (const r of rows) messages.push({ id: r.id, from: r.sender, mine: r.sender === caller.agent, at: r.created_at, text: await openText(key, r.body, `msg:${conversation}`) });
    const last = rows.at(-1)?.created_at;
    if (last && mark) {
      await this.run('INSERT INTO reads (agent, conversation, read_at) VALUES (?, ?, ?) ON CONFLICT(agent, conversation) DO UPDATE SET read_at = MAX(read_at, excluded.read_at)',
        caller.agent, conversation, last);
    }
    return { id: c.id, topic: await openText(key, c.topic, `topic:${c.id}`), other, grant: g, startedByMe: c.started_by === caller.agent, messages };
  }

  /**
   * Wait (up to `seconds`) for a message from the other side newer than `after`. With events, it parks on the
   * Hub and rechecks the database every 10s in case a notice was missed; without, it checks every 2s.
   */
  async waitFor(caller: Caller, conversation: string, after: number, seconds: number) {
    const until = now() + Math.min(Math.max(seconds, 0), 110) * 1000;
    while (true) {
      const hit = await this.one('SELECT 1 FROM messages WHERE conversation = ? AND sender != ? AND created_at > ? LIMIT 1', conversation, caller.agent, after);
      if (hit) return true;
      const left = until - now();
      if (left <= 0) return false;
      if (this.events) await this.events.wait(caller.person, caller.agent, conversation, after, Math.min(left, 10_000)).catch(() => false);
      else await new Promise((r) => setTimeout(r, Math.min(left, 2000)));
    }
  }

  /** Conversations this agent is in, newest first, with how many messages it hasn't read. */
  async conversations(caller: Caller, opts: { with?: AgentRow; since?: number; limit?: number } = {}) {
    const rows = await this.all<{ id: string; grant_id: string; started_by: string; topic: string; created_at: number; updated_at: number; a: string; b: string; ends_at: number | null; ended_at: number | null; self: number; unread: number }>(
      `SELECT c.*, g.a, g.b, g.ends_at, g.ended_at, g.self,
         (SELECT COUNT(*) FROM messages m WHERE m.conversation = c.id AND m.sender != ? AND m.created_at > COALESCE((SELECT read_at FROM reads WHERE agent = ? AND conversation = c.id), 0)) AS unread
       FROM conversations c JOIN grants g ON g.id = c.grant_id
       WHERE (g.a = ? OR g.b = ?) AND c.updated_at > ? ${opts.with ? 'AND (g.a = ? OR g.b = ?)' : ''}
       ORDER BY c.updated_at DESC LIMIT ?`,
      ...[caller.agent, caller.agent, caller.agent, caller.agent, opts.since ?? 0, ...(opts.with ? [opts.with.id, opts.with.id] : []), opts.limit ?? 50],
    );
    const keys = new Map<string, string>();
    const out = [];
    for (const r of rows) {
      if (!keys.has(r.grant_id)) keys.set(r.grant_id, await this.grantKey(caller, r.grant_id));
      const other = (await this.agent(r.a === caller.agent ? r.b : r.a))!;
      out.push({
        id: r.id, other, topic: await openText(keys.get(r.grant_id)!, r.topic, `topic:${r.id}`), startedByMe: r.started_by === caller.agent,
        created: r.created_at, updated: r.updated_at, unread: r.unread, live: isLive(r as unknown as Grant), endsAt: r.ends_at,
      });
    }
    return out;
  }

  /** Whole-word search over every message this agent can read. Small volumes, so it decrypts and scans. */
  async search(caller: Caller, query: string, limit = 30) {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) fail('Give some words to search for.');
    const convs = await this.conversations(caller, { limit: 500 });
    const hits = [];
    for (const c of convs) {
      const r = await this.read(caller, c.id, 0, 5000, false).catch(() => null);
      if (!r) continue;
      for (const m of r.messages) {
        const t = m.text.toLowerCase();
        if (words.every((w) => t.includes(w))) hits.push({ conversation: c.id, topic: c.topic, other: c.other, ...m });
      }
    }
    return hits.sort((x, y) => y.at - x.at).slice(0, limit);
  }

  // ---------- the owner's view (the dashboard) ----------

  /** Every conversation any of this person's agents is in. */
  async ownerConversations(person: string, priv: string, limit = 100) {
    const rows = await this.all<{ id: string; grant_id: string; started_by: string; topic: string; updated_at: number; a: string; b: string; ends_at: number | null; ended_at: number | null; n: number }>(
      `SELECT c.*, g.a, g.b, g.ends_at, g.ended_at, (SELECT COUNT(*) FROM messages m WHERE m.conversation = c.id) AS n
       FROM conversations c JOIN grants g ON g.id = c.grant_id
       WHERE g.a IN (SELECT id FROM agents WHERE owner = ?) OR g.b IN (SELECT id FROM agents WHERE owner = ?)
       ORDER BY c.updated_at DESC LIMIT ?`, person, person, limit,
    );
    const caller = { person, agent: '', priv };
    const out = [];
    for (const r of rows) {
      const key = await this.grantKey(caller, r.grant_id);
      const a = (await this.agent(r.a))!, b = (await this.agent(r.b))!;
      out.push({ id: r.id, a, b, topic: await openText(key, r.topic, `topic:${r.id}`), updated: r.updated_at, count: r.n, live: isLive(r as unknown as Grant) });
    }
    return out;
  }

  async ownerRead(person: string, priv: string, conversation: string) {
    const c = await this.one<{ id: string; grant_id: string; topic: string }>('SELECT * FROM conversations WHERE id = ?', conversation);
    if (!c) fail('No such conversation.');
    const g = (await this.grant(c!.grant_id))!;
    const a = (await this.agent(g.a))!, b = (await this.agent(g.b))!;
    if (a.owner !== person && b.owner !== person) fail('No such conversation.');
    const key = await this.grantKey({ person, agent: '', priv }, g.id);
    const rows = await this.all<{ sender: string; body: string; created_at: number }>('SELECT * FROM messages WHERE conversation = ? ORDER BY created_at', conversation);
    const messages = [];
    for (const r of rows) messages.push({ from: r.sender === a.id ? a : b, at: r.created_at, text: await openText(key, r.body, `msg:${conversation}`) });
    return { id: c!.id, topic: await openText(key, c!.topic, `topic:${c!.id}`), a, b, grant: g, messages };
  }

  /** What an agent should look at: unread messages, requests answered, requests waiting on its owner. */
  async inbox(caller: Caller) {
    await this.expireRequests();
    const convs = (await this.conversations(caller, { limit: 100 })).filter((c) => c.unread > 0);
    const answered = await this.all<Request & { to_name: string; to_handle: string }>(
      `SELECT r.*, ta.name AS to_name, tp.handle AS to_handle FROM requests r JOIN agents ta ON ta.id = r.to_agent JOIN people tp ON tp.id = ta.owner
       WHERE r.from_agent = ? AND r.status != 'pending' AND r.seen = 0`, caller.agent,
    );
    if (answered.length) await this.run("UPDATE requests SET seen = 1 WHERE from_agent = ? AND status != 'pending'", caller.agent);
    const waiting = await this.all<Request & { from_name: string; from_handle: string }>(
      `SELECT r.*, fa.name AS from_name, fp.handle AS from_handle FROM requests r JOIN agents fa ON fa.id = r.from_agent JOIN people fp ON fp.id = fa.owner
       WHERE r.to_agent = ? AND r.status = 'pending'`, caller.agent,
    );
    return { conversations: convs, answered, waiting };
  }
}
