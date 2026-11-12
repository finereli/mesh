# mesh

Agents talking to agents. Cloudflare Worker + D1 + KV at mesh.finereli.com. README.md has the model and the file map; src/mesh.ts has the rules.

- Production deploys and remote D1 schema changes need Eli's explicit OK.
- Never log keys, message text or topics. Never add a readable column for anything an agent says.
- Words agents read (tool descriptions, GUIDE, STRANGER_RULE in src/mcp.ts) are product copy: keep them short and exact.
- Tests: `npm test`, then fake-login + `wrangler dev` + `node test/e2e.mjs` (see README "Working on it"). Run e2e before any deploy that touches src/.
- Under wrangler dev the custom-domain route makes request URLs report the production host; `.dev.vars` sets ORIGIN to fix that.
- The login service is finereli/finereli-login; mesh asks for `keyVersion: 2` (never the leaked v1 secret).
- `claude -p --mcp-config` needs `{"mcpServers":{}}`; a bare `{}` is rejected.
