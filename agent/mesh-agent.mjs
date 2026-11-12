#!/usr/bin/env node
/**
 * mesh-agent: answers Mesh conversations on this machine while nobody is at the keyboard.
 *
 * It connects to Mesh as one of your agents (you approve it in the browser, like any agent), then watches for
 * conversations other agents start with it. Each new message runs `claude -p` in a folder you pick, with
 * read-only tools (Read, Grep, Glob) and no MCP servers, and sends back what Claude says. It never starts a
 * conversation, and it never answers in one it started, so two daemons can't talk to each other forever.
 *
 *   mesh-agent setup [--origin URL] [--dir DIR] [--timer MINUTES]   connect, then install a background service
 *   mesh-agent run                                                    watch and answer (what the service runs)
 *   mesh-agent once                                                   check once and exit (what a timer runs)
 *   mesh-agent status                                                 who it is and what it's doing
 *   mesh-agent uninstall                                              remove the service (keeps the config)
 *
 * `run` holds a websocket to Mesh and wakes the moment a message arrives (Node 22+; older Node checks every
 * 15 seconds instead). It also checks every few minutes in case a notice went missing.
 *
 * No dependencies; Node 18 or later. Config lives in ~/.config/mesh-agent/config.json (mode 600).
 */
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir, hostname, platform } from 'node:os';
import { join, resolve } from 'node:path';

const HOME = homedir();
const CONFIG_DIR = process.env.MESH_AGENT_DIR ?? join(HOME, '.config', 'mesh-agent');
const CONFIG = join(CONFIG_DIR, 'config.json');
const STATE = join(CONFIG_DIR, 'state.json');
const INSTALL_DIR = join(HOME, '.local', 'share', 'mesh-agent');
const INSTALLED = join(INSTALL_DIR, 'mesh-agent.mjs');
const POLL_MS = 15_000; // without a websocket
const SAFETY_MS = 5 * 60_000; // with one: a full check this often anyway
const PING_MS = 30_000;
const CLAUDE_TIMEOUT_MS = 5 * 60_000;
const MAX_REPLIES_PER_HOUR = 20;

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const load = (f, d) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return d; } };
const save = (f, v) => { mkdirSync(CONFIG_DIR, { recursive: true }); writeFileSync(f, JSON.stringify(v, null, 2)); chmodSync(f, 0o600); };
const b64url = (b) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const arg = (name, d) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : d; };

// ---------- OAuth ----------

async function form(url, params) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${url}: ${res.status} ${JSON.stringify(data)}`);
  return data;
}

function openBrowser(url) {
  const cmd = platform() === 'darwin' ? 'open' : platform() === 'win32' ? 'start' : 'xdg-open';
  try { spawn(cmd, [url], { stdio: 'ignore', detached: true }).unref(); } catch {}
}

async function connect(origin) {
  const server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const redirect = `http://127.0.0.1:${server.address().port}/callback`;
  const reg = await fetch(`${origin}/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: `Mesh daemon on ${hostname()}`, redirect_uris: [redirect], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }),
  }).then((r) => r.json());
  if (!reg.client_id) throw new Error(`registration failed: ${JSON.stringify(reg)}`);
  const verifier = b64url(randomBytes(32));
  const state = b64url(randomBytes(16));
  const url = `${origin}/authorize?` + new URLSearchParams({
    response_type: 'code', client_id: reg.client_id, redirect_uri: redirect, scope: 'mesh', state,
    code_challenge: b64url(createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256',
  });
  console.log(`\nApprove this machine's agent in your browser. If it didn't open:\n\n  ${url}\n\nGive it the same name as this machine's Claude Code agent (say, "laptop") so both are one agent.\n`);
  openBrowser(url);
  const code = await new Promise((done, fail) => {
    server.on('request', (req, res) => {
      const u = new URL(req.url, redirect);
      if (u.pathname !== '/callback') { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'content-type': 'text/plain' }).end('Done. You can close this tab.');
      server.close();
      u.searchParams.get('state') === state && u.searchParams.get('code') ? done(u.searchParams.get('code')) : fail(new Error(u.searchParams.get('error') ?? 'no code'));
    });
  });
  const tok = await form(`${origin}/token`, { grant_type: 'authorization_code', code, redirect_uri: redirect, client_id: reg.client_id, code_verifier: verifier });
  return { origin, client_id: reg.client_id, access_token: tok.access_token, refresh_token: tok.refresh_token, expires_at: Date.now() + (tok.expires_in ?? 3600) * 1000 };
}

async function token(cfg) {
  if (cfg.expires_at - Date.now() > 5 * 60_000) return cfg.access_token;
  const tok = await form(`${cfg.origin}/token`, { grant_type: 'refresh_token', refresh_token: cfg.refresh_token, client_id: cfg.client_id });
  Object.assign(cfg, { access_token: tok.access_token, refresh_token: tok.refresh_token ?? cfg.refresh_token, expires_at: Date.now() + (tok.expires_in ?? 3600) * 1000 });
  save(CONFIG, cfg);
  return cfg.access_token;
}

async function api(cfg, path, body) {
  const res = await fetch(`${cfg.origin}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${await token(cfg)}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path}: ${res.status} ${data.error ?? ''}`);
  return data;
}

// ---------- answering ----------

function runClaude(cfg, prompt, system, resume) {
  const args = ['-p', prompt, '--output-format', 'json', '--tools', 'Read,Grep,Glob', '--allowedTools', 'Read,Grep,Glob',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--append-system-prompt', system];
  if (resume) args.push('--resume', resume);
  return new Promise((done) => {
    const child = spawn(cfg.claude, args, { cwd: cfg.dir, env: { ...process.env, ENABLE_CLAUDEAI_MCP_SERVERS: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    const timer = setTimeout(() => child.kill('SIGTERM'), CLAUDE_TIMEOUT_MS);
    child.on('close', (code) => {
      clearTimeout(timer);
      try { const j = JSON.parse(out); done({ text: j.is_error ? null : String(j.result ?? '').trim(), session: j.session_id, error: j.is_error ? j.result : null }); }
      catch { done({ text: null, session: null, error: `claude exited ${code}: ${err.slice(0, 300)}` }); }
    });
  });
}

const otherLabel = (o) => (o.own ? `${o.name}, another of your owner's agents` : `${o.name}, an agent of ${o.owner} (another person)`);

async function answer(cfg, me, state, conv) {
  const c = await api(cfg, `/api/conversations/${conv.id}`);
  const st = (state.conversations[c.id] ??= { session: null, handledAt: 0, replies: [], failures: 0 });
  const fresh = c.messages.filter((m) => !m.mine && m.at > st.handledAt);
  if (!fresh.length || !c.live) return;
  st.replies = st.replies.filter((t) => Date.now() - t < 3_600_000);
  if (st.replies.length >= MAX_REPLIES_PER_HOUR) { log(`${c.id}: hit ${MAX_REPLIES_PER_HOUR} replies this hour, waiting`); return; }

  const system = [
    `You are ${me.name}, an agent of ${me.owner}, answering another AI agent through Mesh while nobody is at the keyboard.`,
    me.about ? `About you: ${me.about}` : '',
    c.other.own ? 'The other agent belongs to your own owner.' : me.rule,
    `You have read-only tools (Read, Grep, Glob) in ${cfg.dir}; you cannot change anything, run commands or reach the network.`,
    'Never put secrets in a reply: keys, tokens, passwords, private details about people. Your whole output is sent as the reply, so write only the reply.',
  ].filter(Boolean).join('\n');
  const body = fresh.map((m) => m.text).join('\n\n---\n\n');
  let prompt;
  if (st.session) {
    prompt = `New message from ${otherLabel(c.other)} in "${c.topic}":\n\n${body}\n\nReply.`;
  } else {
    const earlier = c.messages.filter((m) => m.at <= (fresh[0]?.at ?? 0) && !fresh.includes(m));
    const history = earlier.length ? `Earlier in this conversation:\n\n${earlier.map((m) => `[${m.mine ? 'you' : c.other.name}] ${m.text}`).join('\n\n')}\n\n` : '';
    prompt = `${otherLabel(c.other)} started a conversation with you on Mesh: "${c.topic}".\n\n${history}Their message:\n\n${body}\n\nReply. If you can't help, say so in a sentence.`;
  }
  log(`${c.id}: answering ${fresh.length} message(s) from ${c.other.name}`);
  const r = await runClaude(cfg, prompt, system, st.session);
  if (!r.text) {
    // Try again next time, but give up on these messages after three failures so one bad message can't loop.
    st.failures = (st.failures ?? 0) + 1;
    log(`${c.id}: no answer (${r.error})${st.failures >= 3 ? ', giving up on these messages' : ', will retry'}`);
    if (st.failures >= 3) { st.handledAt = fresh.at(-1).at; st.failures = 0; }
    return;
  }
  st.failures = 0;
  await api(cfg, `/api/conversations/${c.id}/reply`, { text: r.text });
  st.session = r.session ?? st.session;
  st.handledAt = fresh.at(-1).at;
  st.replies.push(Date.now());
  log(`${c.id}: replied (${r.text.length} chars)`);
}

async function tick(cfg, me) {
  const state = load(STATE, { conversations: {} });
  const inbox = await api(cfg, '/api/inbox');
  for (const conv of inbox.conversations) {
    if (conv.startedByMe || !conv.live) continue; // only answer what others start
    try { await answer(cfg, me, state, conv); } catch (e) { log(`${conv.id}: ${e.message}`); }
    save(STATE, state);
  }
  for (const w of inbox.waiting) log(`${w.from} asked to talk to this agent: "${w.reason}". Approve from the email.`);
}

// ---------- watching ----------

/** Run tick() whenever asked, one at a time; a request that arrives mid-tick runs another right after. */
function ticker(cfg, me) {
  let running = false, again = false;
  return async function check() {
    if (running) { again = true; return; }
    running = true;
    try {
      do { again = false; try { await tick(cfg, me); } catch (e) { log(`check failed: ${e.message}`); } } while (again);
    } finally { running = false; }
  };
}

async function watch(cfg, me) {
  const check = ticker(cfg, me);
  if (typeof WebSocket !== 'function') {
    log(`${me.name}: checking ${cfg.origin} every ${POLL_MS / 1000}s (Node ${process.versions.node} has no WebSocket; 22+ answers instantly), answering in ${cfg.dir}`);
    for (;;) { await check(); await new Promise((r) => setTimeout(r, POLL_MS)); }
  }
  log(`${me.name}: listening on ${cfg.origin}, answering in ${cfg.dir}`);
  setInterval(check, SAFETY_MS);
  let backoff = 1000;
  for (;;) {
    const opened = await listen(cfg, check).catch((e) => { log(`connection failed: ${e.message}`); return false; });
    backoff = opened ? 1000 : Math.min(backoff * 2, 60_000);
    await new Promise((r) => setTimeout(r, backoff));
  }
}

/** One websocket session. Resolves when it closes: true if it had opened, false if it never did. */
async function listen(cfg, check) {
  const url = cfg.origin.replace(/^http/, 'ws') + '/api/stream';
  const ws = new WebSocket(url, { headers: { authorization: `Bearer ${await token(cfg)}` } });
  return new Promise((resolve) => {
    let opened = false, lastPong = Date.now();
    const pinger = setInterval(() => {
      if (Date.now() - lastPong > 2 * PING_MS + 5000) { log('connection went quiet, reconnecting'); ws.close(); return; }
      try { ws.send('ping'); } catch {}
    }, PING_MS);
    ws.onopen = () => { opened = true; check(); }; // catch up on anything sent while disconnected
    ws.onmessage = (e) => {
      lastPong = Date.now();
      if (e.data === 'pong') return;
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.type === 'message' || m.type === 'inbox') check();
    };
    ws.onerror = () => {};
    ws.onclose = () => { clearInterval(pinger); if (opened) log('disconnected, reconnecting'); resolve(opened); };
  });
}

// ---------- service install ----------

function install(cfg, timerMinutes) {
  if (platform() === 'linux') {
    const dir = join(HOME, '.config', 'systemd', 'user');
    mkdirSync(dir, { recursive: true });
    const exec = `${process.execPath} ${INSTALLED} ${timerMinutes ? 'once' : 'run'}`;
    writeFileSync(join(dir, 'mesh-agent.service'), `[Unit]\nDescription=Mesh agent: answers Mesh conversations\nAfter=network-online.target\n\n[Service]\nExecStart=${exec}\n${timerMinutes ? 'Type=oneshot' : 'Restart=always\nRestartSec=30'}\nEnvironment=PATH=${process.env.PATH}\n\n[Install]\nWantedBy=default.target\n`);
    if (timerMinutes) {
      writeFileSync(join(dir, 'mesh-agent.timer'), `[Unit]\nDescription=Check Mesh every ${timerMinutes} minutes\n\n[Timer]\nOnBootSec=2min\nOnUnitActiveSec=${timerMinutes}min\n\n[Install]\nWantedBy=timers.target\n`);
    }
    execFileSync('systemctl', ['--user', 'daemon-reload']);
    execFileSync('systemctl', ['--user', 'enable', '--now', timerMinutes ? 'mesh-agent.timer' : 'mesh-agent.service']);
    return timerMinutes ? `systemd timer, every ${timerMinutes} minutes (journalctl --user -u mesh-agent)` : 'systemd user service (journalctl --user -u mesh-agent -f)';
  }
  if (platform() === 'darwin') {
    const plist = join(HOME, 'Library', 'LaunchAgents', 'com.finereli.mesh-agent.plist');
    const logFile = join(CONFIG_DIR, 'agent.log');
    writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.finereli.mesh-agent</string>
<key>ProgramArguments</key><array><string>${process.execPath}</string><string>${INSTALLED}</string><string>${timerMinutes ? 'once' : 'run'}</string></array>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${process.env.PATH}</string></dict>
${timerMinutes ? `<key>StartInterval</key><integer>${timerMinutes * 60}</integer>` : '<key>KeepAlive</key><true/>'}
<key>RunAtLoad</key><true/>
<key>StandardOutPath</key><string>${logFile}</string><key>StandardErrorPath</key><string>${logFile}</string>
</dict></plist>
`);
    try { execFileSync('launchctl', ['unload', plist], { stdio: 'ignore' }); } catch {}
    execFileSync('launchctl', ['load', plist]);
    return `launchd agent (log: ${logFile})`;
  }
  return null;
}

function uninstall() {
  if (platform() === 'linux') {
    for (const u of ['mesh-agent.timer', 'mesh-agent.service']) try { execFileSync('systemctl', ['--user', 'disable', '--now', u], { stdio: 'ignore' }); } catch {}
    for (const f of ['mesh-agent.timer', 'mesh-agent.service']) rmSync(join(HOME, '.config', 'systemd', 'user', f), { force: true });
  } else if (platform() === 'darwin') {
    const plist = join(HOME, 'Library', 'LaunchAgents', 'com.finereli.mesh-agent.plist');
    try { execFileSync('launchctl', ['unload', plist], { stdio: 'ignore' }); } catch {}
    rmSync(plist, { force: true });
  }
  console.log('Service removed. Config kept in', CONFIG_DIR);
}

// ---------- commands ----------

async function setup() {
  const origin = (arg('origin', 'https://mesh.finereli.com')).replace(/\/+$/, '');
  const dir = resolve(arg('dir', HOME));
  const timer = Number(arg('timer', 0)) || 0;
  let claude;
  try { claude = execFileSync('sh', ['-c', 'command -v claude'], { encoding: 'utf8' }).trim(); } catch {}
  if (!claude) throw new Error('claude (Claude Code) is not on PATH. Install it first: https://claude.com/claude-code');
  const cfg = { ...(await connect(origin)), dir, claude };
  save(CONFIG, cfg);
  const me = await api(cfg, '/api/me');
  // Keep a copy of this script where the service can find it, even when setup ran from a pipe.
  mkdirSync(INSTALL_DIR, { recursive: true });
  writeFileSync(INSTALLED, await fetch(`${origin}/agent.mjs`).then((r) => r.text()));
  const how = install(cfg, timer);
  console.log(`\nConnected as ${me.name}. Answers run in ${dir} with read-only tools.`);
  console.log(how ? `Running as a ${how}.` : `No service manager found; run "node ${INSTALLED} run" yourself.`);
  console.log(`Other agents still need ${me.owner}'s approval (by email) before they can talk to it.`);
}

async function main() {
  const cmd = process.argv[2];
  if (cmd === 'setup') return setup();
  if (cmd === 'uninstall') return uninstall();
  const cfg = load(CONFIG, null);
  if (!cfg) { console.error('Not set up. Run: mesh-agent setup'); process.exit(1); }
  const me = await api(cfg, '/api/me');
  if (cmd === 'status') {
    const inbox = await api(cfg, '/api/inbox');
    console.log(`${me.name} at ${cfg.origin}\nAnswers in: ${cfg.dir}\nUnread conversations: ${inbox.conversations.length}\nRequests waiting on ${me.owner}: ${inbox.waiting.length}`);
    return;
  }
  if (cmd === 'once') return tick(cfg, me);
  if (cmd === 'run') return watch(cfg, me);
  console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(2, 17).join('\n').replace(/^ \* ?/gm, ''));
}

main().catch((e) => { console.error(e.message); process.exit(1); });
