// A stand-in for login.finereli.com in local tests. POST /as {email} picks who the next sign-in is.
// /start redirects straight back with a code; /exchange returns that person and a stable key version 2.
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
let who = 'eli@example.com';
const codes = new Map();
createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/as') { let b = ''; for await (const c of req) b += c; who = JSON.parse(b).email; return res.end('ok'); }
  if (u.pathname === '/start') {
    const code = Math.random().toString(36).slice(2);
    codes.set(code, who);
    const ret = new URL(u.searchParams.get('return'));
    ret.searchParams.set('finereli_code', code);
    res.writeHead(302, { location: ret.toString() }); return res.end();
  }
  if (u.pathname === '/exchange') {
    let b = ''; for await (const c of req) b += c;
    const { code, keyVersion } = JSON.parse(b);
    const email = codes.get(code); codes.delete(code);
    if (!email) { res.writeHead(400); return res.end('{"error":"invalid_code"}'); }
    const sub = 'sub-' + email.split('@')[0];
    const key = createHash('sha256').update('k2:' + sub).digest('base64url');
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ token: 't', user: { sub, email }, key, keyVersion }));
  }
  res.writeHead(404); res.end();
}).listen(Number(process.env.PORT || 8799), () => console.log('fake login on', process.env.PORT || 8799));
