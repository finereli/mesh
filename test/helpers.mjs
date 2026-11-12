// Helpers shared by tests. (Header from e2e.mjs.)
// End to end against `wrangler dev` (port 8787) and test/fake-login.mjs (port 8799).
// Two people, an invite, three agents, a pairing approved by email link, a conversation, the owner's view,
// and the refusals that matter. Run: node test/e2e.mjs
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const O = 'http://localhost:8787';
const LOGIN = 'http://127.0.0.1:8799';
const b64url = (b) => b.toString('base64url');
let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); pass++; console.log('PASS', msg); };

export class Browser {
  jar = new Map();
  cookies() { return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; '); }
  take(res) {
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [kv, ...attrs] = c.split(';');
      const [k, v] = kv.split('=');
      if (/max-age=0/i.test(attrs.join(';'))) this.jar.delete(k.trim()); else this.jar.set(k.trim(), v);
    }
  }
  async go(url, init = {}, follow = true) {
    for (let i = 0; i < 10; i++) {
      const res = await fetch(url, { ...init, redirect: 'manual', headers: { ...(init.headers ?? {}), cookie: url.startsWith(O) ? this.cookies() : '' } });
      if (url.startsWith(O)) this.take(res);
      const loc = res.headers.get('location');
      if (!follow || !loc || res.status < 300 || res.status >= 400) return res;
      if (loc.startsWith('http://127.0.0.1:9/')) return res; // the OAuth client's redirect: stop here
      url = new URL(loc, url).toString();
      init = {};
    }
    throw new Error('too many redirects');
  }
  post(url, fields) { return this.go(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields) }); }
}

const as = (email) => fetch(`${LOGIN}/as`, { method: 'POST', body: JSON.stringify({ email }) });

/** Connect an MCP-style agent: register, authorize, sign in, name it, swap the code for a token. */
export async function agentToken(browser, email, name, extra = {}) {
  await as(email);
  const reg = await fetch(`${O}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: `test ${name}`, redirect_uris: ['http://127.0.0.1:9/cb'], token_endpoint_auth_method: 'none' }) }).then((r) => r.json());
  const verifier = b64url(randomBytes(32));
  const q = new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: 'http://127.0.0.1:9/cb', scope: 'mesh', state: 's', code_challenge: b64url(createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256' });
  const page = await browser.go(`${O}/authorize?${q}`);
  assert.equal(page.status, 200, 'connect page');
  const html = await page.text();
  const fields = { name, about: `${name} test agent`, visible: 'on', ...extra };
  if (html.includes('name="handle"')) fields.handle = email.split('@')[0];
  const done = await browser.post(`${O}/connect`, fields);
  const code = new URL(done.headers.get('location')).searchParams.get('code');
  const tok = await fetch(`${O}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: 'http://127.0.0.1:9/cb', client_id: reg.client_id, code_verifier: verifier }) }).then((r) => r.json());
  assert.ok(tok.access_token, 'token');
  return tok.access_token;
}

let rpcId = 0;
export async function call(token, name, args = {}) {
  const res = await fetch(`${O}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }) });
  const j = await res.json();
  if (j.error) throw new Error(JSON.stringify(j.error));
  return { text: j.result.content[0].text, error: Boolean(j.result.isError) };
}
const api = (token, path, body) => fetch(`${O}${path}`, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json());
export const sql = (q) => JSON.parse(execFileSync('npx', ['wrangler', 'd1', 'execute', 'mesh-v2', '--local', '--json', '--command', q], { encoding: 'utf8' }))[0].results;


export const eliBrowser = new Browser();
export const tomBrowser = new Browser();
