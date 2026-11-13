/**
 * Mesh v2: agents talking to agents.
 *
 * OAuth (workers-oauth-provider) fronts /mcp and /api/. Approving an agent means signing in with Google through
 * the login service, which also hands this server the person's login key; that key opens their private key,
 * which rides in the agent's OAuth grant (encrypted by the library under the token). Browser sessions only say
 * who someone is: approving a pair, accepting an invite and the dashboard need no key.
 */
import { OAuthProvider, type OAuthHelpers } from '@cloudflare/workers-oauth-provider';
import { b64, newPerson, openPerson, randomBytes, randomId, sha256, unb64 } from './crypto.js';
import { handleMcp } from './mcp.js';
import { handleApi } from './api.js';
import { Hub, meshFor } from './hub.js';
import { Mesh, MeshError, AGENT_NAME, DURATIONS, type Caller, type Person } from './mesh.js';
import { agentAppeared, remind, sendInvite } from './notify.js';
import * as pages from './pages.js';
import type { MailEnv } from './email.js';
// @ts-ignore - bundled as text (see "rules" in wrangler.jsonc)
import LOGO_SVG from '../logos/export/logo.svg';
// @ts-ignore - bundled as data (see "rules" in wrangler.jsonc)
import TOUCH_ICON from '../logos/export/logo-180.png';
// @ts-ignore - bundled as text (see "rules" in wrangler.jsonc)
import AGENT_SCRIPT from '../agent/mesh-agent.mjs';

export interface Env extends MailEnv {
  DB: D1Database;
  HUB: DurableObjectNamespace<Hub>;
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  /** Comma-separated emails allowed to sign in. Empty means nobody. */
  ALLOWED_EMAILS?: string;
  LOGIN_URL?: string;
  /** Overrides the request's origin. Local only: under wrangler dev with a custom-domain route the request URL reports the production host. */
  ORIGIN?: string;
}

/** What an agent's OAuth grant carries. */
export interface Props { person: string; agent: string; priv: string }

const SESSION_COOKIE = 'mesh_session';
const PENDING_COOKIE = 'mesh_pending';
const SESSION_DAYS = 30;

const html = (body: string, status = 200, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...headers } });
const redirect = (location: string, cookies: string[] = []) => {
  const r = new Response(null, { status: 302, headers: { location } });
  for (const c of cookies) r.headers.append('set-cookie', c);
  return r;
};
const cookie = (r: Request, name: string) => r.headers.get('cookie')?.split(/;\s*/).find((c) => c.startsWith(`${name}=`))?.slice(name.length + 1);
const setCookie = (name: string, value: string, maxAge: number, path = '/') => `${name}=${value}; Path=${path}; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
const loginService = (env: Env) => (env.LOGIN_URL ?? 'https://login.finereli.com').replace(/\/+$/, '');
const allowed = (env: Env, email: string) => (env.ALLOWED_EMAILS ?? '').toLowerCase().split(',').map((s) => s.trim()).includes(email.toLowerCase());
const message = (title: string, text: string, status = 200) => html(pages.message(title, text), status);
const safeNext = (n: string | null) => (n && n.startsWith('/') && !n.startsWith('//') ? n : '/');

// ---------- pending sign-ins (KV, 15 minutes) ----------
// A pending sign-in remembers where to go afterwards, and for an agent approval, the OAuth request. After the
// login service vouches for the person, it also holds their private key, sealed under a key derived from the
// cookie token, so KV alone can't open it.

interface Pending { next?: string; oauth?: unknown; person?: string; sealedPriv?: string }

async function tokenKey(token: string) {
  const raw = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`mesh-pending:${token}`)));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
async function sealFor(token: string, s: string) {
  const iv = randomBytes(12);
  const body = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await tokenKey(token), new TextEncoder().encode(s)));
  return b64(iv) + '.' + b64(body);
}
async function openFor(token: string, sealed: string) {
  const [iv = '', body = ''] = sealed.split('.');
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, await tokenKey(token), unb64(body)));
}
const pendingKey = async (token: string) => `pending:${await sha256(token)}`;
async function putPending(env: Env, token: string, p: Pending) { await env.OAUTH_KV.put(await pendingKey(token), JSON.stringify(p), { expirationTtl: 900 }); }
async function getPending(env: Env, token: string | undefined): Promise<Pending | null> {
  if (!token) return null;
  const v = await env.OAUTH_KV.get(await pendingKey(token));
  return v ? JSON.parse(v) : null;
}

// ---------- browser sessions (D1) ----------

async function session(env: Env, request: Request): Promise<{ person: Person; priv: string } | null> {
  const token = cookie(request, SESSION_COOKIE);
  if (!token) return null;
  const row = await env.DB.prepare('SELECT person, sealed_priv FROM sessions WHERE id = ? AND expires_at > ?').bind(await sha256(token), Date.now()).first<{ person: string; sealed_priv: string }>();
  if (!row) return null;
  const person = await meshFor(env).person(row.person);
  return person ? { person, priv: await openFor(token, row.sealed_priv) } : null;
}
const sessionPerson = async (env: Env, request: Request) => (await session(env, request))?.person ?? null;
async function newSession(env: Env, person: string, priv: string) {
  const token = randomId('s_', 24);
  await env.DB.prepare('INSERT INTO sessions (id, person, sealed_priv, expires_at) VALUES (?, ?, ?, ?)')
    .bind(await sha256(token), person, await sealFor(token, priv), Date.now() + SESSION_DAYS * 86_400_000).run();
  await env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(Date.now()).run();
  return setCookie(SESSION_COOKIE, token, SESSION_DAYS * 86400);
}

/** Start a sign-in through the login service, coming back to /auth/callback. */
async function startSignIn(env: Env, origin: string, p: Pending) {
  const token = randomId('t_', 24);
  await putPending(env, token, p);
  const ret = `${origin}/auth/callback`;
  return redirect(`${loginService(env)}/start?return=${encodeURIComponent(ret)}`, [setCookie(PENDING_COOKIE, token, 900, '/')]);
}

async function redeem(env: Env, code: string) {
  const res = await fetch(`${loginService(env)}/exchange`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, key: true, keyVersion: 2 }),
  });
  if (!res.ok) return null;
  const d = (await res.json()) as { key?: string; keyVersion?: number; user?: { sub: string; email: string } };
  return d.key && d.keyVersion === 2 && d.user ? { key: d.key, sub: d.user.sub, email: d.user.email } : null;
}

async function requireSession(env: Env, request: Request, url: URL): Promise<Person | Response> {
  const person = await sessionPerson(env, request);
  if (person) return person;
  return startSignIn(env, url.origin, { next: url.pathname + url.search });
}

const appHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (env.ORIGIN) { const o = new URL(env.ORIGIN); url.protocol = o.protocol; url.host = o.host; }
    const path = url.pathname;
    const mesh = meshFor(env);
    const form = async () => (request.method === 'POST' ? await request.formData() : new FormData());

    try {
      if (path === '/agent.mjs') return new Response(AGENT_SCRIPT, { headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'public, max-age=300' } });
      if (path === '/favicon.svg') return new Response(LOGO_SVG, { headers: { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=86400' } });
      if (path === '/favicon.ico' || path === '/apple-touch-icon.png') return new Response(TOUCH_ICON, { headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' } });
      if (path === '/llms.txt') return new Response(pages.llmsTxt(url.origin), { headers: { 'content-type': 'text/plain; charset=utf-8' } });
      if (path === '/signin') return startSignIn(env, url.origin, { next: safeNext(url.searchParams.get('next')) });
      if (path === '/signout') return redirect('/', [setCookie(SESSION_COOKIE, '', 0)]);

      // An MCP client (Claude Code, claude.ai, the daemon) wants to connect as an agent.
      if (path === '/authorize') {
        const oauth = await env.OAUTH_PROVIDER.parseAuthRequest(request);
        return startSignIn(env, url.origin, { oauth });
      }

      if (path === '/auth/callback') {
        const token = cookie(request, PENDING_COOKIE);
        const pending = await getPending(env, token);
        if (!pending || !token) return message('Sign-in expired', 'Start again from where you were.', 400);
        const code = url.searchParams.get('finereli_code');
        const who = code && (await redeem(env, code));
        if (!who) return message('Sign-in failed', 'The login service did not accept that sign-in. Start again.', 400);
        if (!allowed(env, who.email)) return message('Not on the list yet', `Mesh is open to a few people while we test it, and ${who.email} isn't one of them.`, 403);
        let person = await mesh.personBySub(who.sub);
        let priv: string | null;
        if (!person) {
          const made = await newPerson(who.key);
          person = await mesh.createPerson(who.sub, who.email, made.stored.pub, made.stored.sealedPriv);
          priv = made.priv;
        } else {
          priv = await openPerson(who.key, { pub: person.pub, sealedPriv: person.sealed_priv });
          if (!priv) return message('Key mismatch', 'The login service gave a different key than this account was made with, so it can\'t be opened.', 500);
        }
        const sess = await newSession(env, person.id, priv);
        if (pending.oauth) {
          await putPending(env, token, { ...pending, person: person.id, sealedPriv: await sealFor(token, priv) });
          return redirect('/connect', [sess]);
        }
        return redirect(person.handle ? safeNext(pending.next ?? '/') : `/handle?next=${encodeURIComponent(safeNext(pending.next ?? '/'))}`, [sess, setCookie(PENDING_COOKIE, '', 0)]);
      }

      // Naming the agent being approved. Comes right after signing in from /authorize.
      if (path === '/connect') {
        const token = cookie(request, PENDING_COOKIE);
        const pending = await getPending(env, token);
        if (!pending?.oauth || !pending.person || !pending.sealedPriv || !token) return message('Approval expired', 'Start again from the app that asked.', 400);
        const person = (await mesh.person(pending.person))!;
        const existing = await mesh.agentsOf(person.id);
        const client = await env.OAUTH_PROVIDER.lookupClient((pending.oauth as any).clientId);
        if (request.method !== 'POST') return html(pages.connect({ person, existing, clientName: client?.clientName ?? 'An app' }));
        const f = await form();
        try {
          if (!person.handle) await mesh.setHandle(person.id, String(f.get('handle') ?? ''));
          const pick = String(f.get('agent') ?? '');
          const name = pick && pick !== '__new' ? pick : String(f.get('name') ?? '');
          const agent = await mesh.upsertAgent(person.id, name, String(f.get('about') ?? ''), f.get('visible') === 'on');
          if (agent.visible && !existing.some((a) => a.visible)) await agentAppeared(env, mesh, agent, url.origin);
          const props: Props = { person: person.id, agent: agent.id, priv: await openFor(token, pending.sealedPriv) };
          const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
            request: pending.oauth as any, userId: person.id, scope: ['mesh'], metadata: { agent: agent.id, name: agent.name }, props,
          });
          await env.OAUTH_KV.delete(await pendingKey(token));
          return redirect(redirectTo, [setCookie(PENDING_COOKIE, '', 0)]);
        } catch (e) {
          if (!(e instanceof MeshError)) throw e;
          const fresh = (await mesh.person(person.id))!;
          return html(pages.connect({ person: fresh, existing, clientName: client?.clientName ?? 'An app', error: e.message }), 400);
        }
      }

      if (path === '/handle') {
        const s = await requireSession(env, request, url);
        if (s instanceof Response) return s;
        const next = safeNext(url.searchParams.get('next'));
        if (request.method !== 'POST') return html(pages.handle(s, next));
        try { await mesh.setHandle(s.id, String((await form()).get('handle') ?? '')); }
        catch (e) { if (e instanceof MeshError) return html(pages.handle(s, next, e.message), 400); throw e; }
        return redirect(next);
      }

      // The page an approval email links to.
      if (path.startsWith('/r/')) {
        const s = await requireSession(env, request, url);
        if (s instanceof Response) return s;
        if (!s.handle) return redirect(`/handle?next=${encodeURIComponent(path)}`);
        const id = path.slice(3);
        await mesh.expireRequests();
        const r = await mesh.request(id);
        const to = r && (await mesh.agent(r.to_agent));
        if (!r || !to || to.owner !== s.id) return message('Not found', 'There\'s no request here for you.', 404);
        const from = (await mesh.agent(r.from_agent))!;
        if (request.method === 'POST') {
          const choice = String((await form()).get('choice') ?? '');
          if (choice !== 'decline' && !(choice in DURATIONS)) return message('Pick one', 'Choose a time or decline.', 400);
          const done = await mesh.answer(s.id, id, choice as any);
          return html(pages.answered(done, from, to, choice));
        }
        return html(pages.request(r, from, to));
      }

      // Accepting an emailed invite.
      if (path.startsWith('/i/')) {
        const s = await requireSession(env, request, url);
        if (s instanceof Response) return s;
        if (!s.handle) return redirect(`/handle?next=${encodeURIComponent(path)}`);
        const inviter = await mesh.acceptInvite(path.slice(3), s);
        return html(pages.accepted(inviter, await mesh.agentsOf(s.id), url.origin));
      }

      if (path === '/') {
        const s = await session(env, request);
        if (!s) return html(pages.landing(url.origin));
        if (!s.person.handle) return redirect('/handle?next=/');
        return html(await pages.dashboard(mesh, s.person, s.priv, url.origin, url.searchParams.get('note') ?? undefined));
      }

      // The owner reading one conversation. Same key as the agents, carried by the browser session.
      if (path.startsWith('/c/')) {
        const s = await session(env, request);
        if (!s) return startSignIn(env, url.origin, { next: path });
        return html(pages.conversation(await mesh.ownerRead(s.person.id, s.priv, path.slice(3))));
      }

      // Dashboard actions. Forms post here with a session; SameSite=Lax keeps other sites from posting as you.
      if (path.startsWith('/do/') && request.method === 'POST') {
        const s = await sessionPerson(env, request);
        if (!s) return redirect('/');
        const f = await form();
        const back = (note: string) => redirect(`/?note=${encodeURIComponent(note)}`);
        if (path === '/do/invite') {
          const email = String(f.get('email') ?? '').trim().toLowerCase();
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return back('That doesn\'t look like an email address.');
          if (!allowed(env, email)) return back(`${email} isn't on the test list yet.`);
          const id = await mesh.invite(s.id, email);
          await sendInvite(env, s.handle!, s.email, email, `${url.origin}/i/${id}`);
          return back(`Invite sent to ${email}.`);
        }
        if (path === '/do/remind') return back(await remind(env, s, await mesh.connection(s.id, String(f.get('person'))), url.origin));
        if (path === '/do/visible') {
          const before = await mesh.agentsOf(s.id);
          const id = String(f.get('agent')), show = f.get('visible') === '1';
          await mesh.setVisible(s.id, id, show);
          const shown = show && !before.some((a) => a.visible) && before.find((a) => a.id === id);
          if (shown) await agentAppeared(env, mesh, (await mesh.agent(id))!, url.origin);
          return back('Saved.');
        }
        if (path === '/do/end') { await mesh.endGrant(s.id, String(f.get('grant'))); return back('Ended.'); }
        if (path === '/do/disconnect') { await mesh.disconnect(s.id, String(f.get('person'))); return back('Disconnected.'); }
        if (path === '/do/forget') {
          // Disconnect every OAuth grant of one agent. The agent's name and conversations stay.
          const agent = String(f.get('agent'));
          for (let cursor: string | undefined; ;) {
            const page = await env.OAUTH_PROVIDER.listUserGrants(s.id, { cursor });
            for (const g of page.items) if ((g.metadata as any)?.agent === agent) await env.OAUTH_PROVIDER.revokeGrant(g.id, s.id);
            if (!page.cursor) break;
            cursor = page.cursor;
          }
          return back('Disconnected that agent. It needs approving again to come back.');
        }
      }

      return message('Not found', 'Nothing here.', 404);
    } catch (e) {
      if (e instanceof MeshError) return message('Can\'t do that', e.message, 400);
      throw e;
    }
  },
};

const oauth = new OAuthProvider({
  apiRoute: ['/mcp', '/api/'],
  apiHandler: {
    fetch: (request: Request, env: Env, ctx: ExecutionContext & { props: Props }) => {
      const caller: Caller = ctx.props;
      if (new URL(request.url).pathname === '/api/stream') {
        // A daemon's websocket, handed to its owner's Hub once the token checks out.
        const url = new URL(request.url);
        url.search = `?agent=${encodeURIComponent(caller.agent)}`;
        return env.HUB.get(env.HUB.idFromName(caller.person)).fetch(new Request(url, request));
      }
      return new URL(request.url).pathname === '/mcp' ? handleMcp(request, env, caller) : handleApi(request, env, caller);
    },
  } as any,
  defaultHandler: appHandler as any,
  authorizeEndpoint: '/authorize',
  tokenEndpoint: '/token',
  clientRegistrationEndpoint: '/register',
  scopesSupported: ['mesh'],
  refreshTokenTTL: 365 * 24 * 60 * 60,
});

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => oauth.fetch(request, env, ctx),
};

export { AGENT_NAME, Hub };
