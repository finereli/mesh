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

class Browser {
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
async function agent(browser, email, name, extra = {}) {
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
async function call(token, name, args = {}) {
  const res = await fetch(`${O}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }) });
  const j = await res.json();
  if (j.error) throw new Error(JSON.stringify(j.error));
  return { text: j.result.content[0].text, error: Boolean(j.result.isError) };
}
const api = (token, path, body) => fetch(`${O}${path}`, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json());
const sql = (q) => JSON.parse(execFileSync('npx', ['wrangler', 'd1', 'execute', 'mesh-v2', '--local', '--json', '--command', q], { encoding: 'utf8' }))[0].results;

// --- unauthenticated MCP starts the OAuth dance
const anon = await fetch(`${O}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
ok(anon.status === 401 && /resource_metadata|Bearer/.test(anon.headers.get('www-authenticate') ?? ''), 'unauthenticated /mcp gets 401 with WWW-Authenticate');

// --- someone not on the list is turned away
const stranger = new Browser();
await as('nobody@example.com');
const turned = await stranger.go(`${O}/signin`);
ok(turned.status === 403, 'an email not on the list is refused');

// --- people and agents
const eliB = new Browser(), tomB = new Browser();
const eliLaptop = await agent(eliB, 'eli@example.com', 'laptop', { handle: 'eli' });
const eliGlopus = await agent(eliB, 'eli@example.com', 'glopus');
const tomLaptop = await agent(tomB, 'tom@example.com', 'laptop', { handle: 'tom' });
ok((await call(eliLaptop, 'whoami')).text.includes('eli/laptop'), 'agent knows its name');

// --- own agents talk with no approval
const own = await call(eliLaptop, 'ask', { agent: 'eli/glopus', topic: 'hello', message: 'Note to self: hi glopus' });
ok(!own.error && own.text.includes('Sent'), 'own agents talk without approval');
ok((await call(eliGlopus, 'inbox')).text.includes('1 unread'), 'the other own agent sees it in inbox');

// --- not connected: tom's agents are invisible
ok((await call(eliLaptop, 'request', { agent: 'tom/laptop', reason: 'x' })).error, 'cannot reach an agent of someone you are not connected to');

// --- invite by email, accepted by signing in
await eliB.post(`${O}/do/invite`, { email: 'tom@example.com' });
const [inv] = sql("SELECT id FROM invites WHERE email = 'tom@example.com'");
await as('tom@example.com');
const accepted = await tomB.go(`${O}/i/${inv.id}`);
ok((await accepted.text()).includes('connected'), 'invite accepted');
ok((await call(eliLaptop, 'agents')).text.includes('tom/laptop'), 'connected person\'s visible agent shows up');

// --- talking needs approval
ok((await call(eliLaptop, 'ask', { agent: 'tom/laptop', topic: 't', message: 'hi' })).error, 'cannot talk before approval');
const req = await call(eliLaptop, 'request', { agent: 'tom/laptop', reason: 'Eli wants to compare Omarchy setups.' });
ok(!req.error && req.text.includes('Asked'), 'request sent');
ok((await call(tomLaptop, 'inbox')).text.includes('asked to talk to you'), 'target agent sees the pending request');
const [r] = sql("SELECT id FROM requests WHERE status = 'pending'");
ok((await eliB.post(`${O}/r/${r.id}`, { choice: '1h' })).status === 404, 'the requester\'s owner cannot approve');
const approve = await tomB.post(`${O}/r/${r.id}`, { choice: '1h' });
ok((await approve.text()).includes('Approved'), 'target owner approves for 1h');
ok((await call(eliLaptop, 'inbox')).text.includes('approved'), 'requester learns it was approved');
ok((await call(eliGlopus, 'ask', { agent: 'tom/laptop', topic: 't', message: 'hi' })).error, 'approval covers one pair only');

// --- a daemon's websocket hears about new messages
const events = [];
const sock = new WebSocket(`${O.replace('http', 'ws')}/api/stream`, { headers: { authorization: `Bearer ${tomLaptop}` } });
sock.onmessage = (e) => events.push(e.data);
await new Promise((res, rej) => { sock.onopen = res; sock.onerror = () => rej(new Error('websocket failed')); });
const refused = await new Promise((res) => { const w = new WebSocket(`${O.replace('http', 'ws')}/api/stream`); w.onopen = () => res(false); w.onerror = () => res(true); });
ok(refused, 'the stream refuses a connection without a token');

// --- a conversation, with a reply arriving while the asker waits
const asked = call(eliLaptop, 'ask', { agent: 'tom/laptop', topic: 'Power settings', message: 'How does your lid suspend work?', wait_seconds: 20 });
await new Promise((res) => setTimeout(res, 2500));
ok(events.some((x) => x.includes('"message"')), 'the target agent\'s websocket was told about the new message');
sock.send('ping');
await new Promise((res) => setTimeout(res, 300));
ok(events.includes('pong'), 'pings get a pong');
sock.close();
const tomInbox = await api(tomLaptop, '/api/inbox');
const conv = tomInbox.conversations[0];
ok(conv && !conv.startedByMe && conv.other.name === 'eli/laptop' && !conv.other.own, 'daemon API sees a conversation started by another person\'s agent');
const thread = await api(tomLaptop, `/api/conversations/${conv.id}`);
ok(thread.messages[0].text === 'How does your lid suspend work?', 'message decrypts for the other side');
const repliedAt = Date.now();
await api(tomLaptop, `/api/conversations/${conv.id}/reply`, { text: 'logind suspends on lid close; ignored when docked.' });
const answered = await asked;
ok(Date.now() - repliedAt < 1500, `a waiting ask wakes as soon as the reply lands (${Date.now() - repliedAt}ms)`);
ok(answered.text.includes('logind suspends') && answered.text.includes("tom's agent, another person"), 'asker gets the answer in the same call, labeled as another person\'s agent');
ok((await call(eliLaptop, 'search', { words: 'logind docked' })).text.includes('logind'), 'search finds words in decrypted messages');
ok((await call(eliLaptop, 'conversations')).text.includes('Power settings'), 'conversations lists it');

// --- owner's view in the browser
const dash = await (await eliB.go(`${O}/`)).text();
ok(dash.includes('Power settings') && dash.includes('tom/laptop'), 'owner dashboard shows the conversation and the pair');
const page = await (await tomB.go(`${O}/c/${conv.id}`)).text();
ok(page.includes('logind suspends'), 'other owner can read the conversation in the browser');

// --- nothing readable at rest
const rows = sql('SELECT body FROM messages UNION ALL SELECT topic FROM conversations');
ok(rows.every((x) => !/lid|logind|Power|glopus/i.test(x.body)), 'messages and topics are ciphertext in the database');

// --- ending a grant stops new messages and keeps history
await call(tomLaptop, 'end', { agent: 'eli/laptop' });
const after = await call(eliLaptop, 'reply', { conversation: conv.id, message: 'one more thing' });
ok(after.error && after.text.includes('extend'), 'after the grant ends, replies are refused with how to extend');
ok((await call(eliLaptop, 'read', { conversation: conv.id })).text.includes('logind'), 'history stays readable');

// --- a declined agent can't ask again the same day
const ext = await call(eliLaptop, 'extend', { agent: 'tom/laptop', reason: 'Need more time' });
ok(!ext.error, 'extend request sent');
const [e] = sql("SELECT id FROM requests WHERE status = 'pending' AND kind = 'extend'");
await tomB.post(`${O}/r/${e.id}`, { choice: 'decline' });
ok((await call(eliLaptop, 'request', { agent: 'tom/laptop', reason: 'please' })).error, 'declined: no asking again for a day');

console.log(`\n${pass} passed`);
