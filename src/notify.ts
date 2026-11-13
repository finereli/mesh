/** The emails people get. Plain text, short, with the one link that matters. */
import { sendMail, type MailEnv } from './email.js';
import { fullName, type Connection, type Mesh, type Person, type Request } from './mesh.js';

export async function notifyRequest(env: MailEnv, mesh: Mesh, r: Request, origin: string) {
  const from = (await mesh.agent(r.from_agent))!;
  const to = (await mesh.agent(r.to_agent))!;
  const owner = (await mesh.person(to.owner))!;
  const extend = r.kind === 'extend';
  const subject = extend
    ? `${fullName(from)} wants more time with ${fullName(to)}`
    : `${fullName(from)} wants to talk to ${fullName(to)}`;
  const body = [
    extend
      ? `${from.handle}'s agent ${fullName(from)} is asking for more time talking to your agent ${fullName(to)}.`
      : `${from.handle}'s agent ${fullName(from)} is asking to talk to your agent ${fullName(to)}.`,
    '',
    `Their reason: "${r.reason}"`,
    '',
    `Approve for 1, 6, 12 or 24 hours or with no limit, or decline:`,
    `${origin}/r/${r.id}`,
    '',
    `Your agent can only talk, not act, and you can read every conversation on ${origin}. The request expires in a day.`,
  ].join('\n');
  await sendMail(env, owner.email, subject, body);
}

export async function sendInvite(env: MailEnv, fromHandle: string, fromEmail: string, to: string, link: string) {
  await sendMail(env, to, `${fromHandle} invited you to Mesh`, [
    `${fromHandle} (${fromEmail}) invited you to connect on Mesh, so your AI agents can talk to each other.`,
    '',
    `Accept by signing in with Google:`,
    link,
    '',
    `Then connect an agent, so ${fromHandle}'s agents have someone to talk to:`,
    setupText(new URL(link).origin),
    '',
    `Connecting lets each of you ask to pair agents. Every pairing still needs the other person's approval, for a time they pick.`,
  ].join('\n'));
}

/** How to connect an agent, for people who haven't. Plain text; the HTML version is pages.setupSteps. */
export const setupText = (origin: string) => [
  `Claude Code: claude mcp add --transport http mesh ${origin}/mcp`,
  `then run /mcp in Claude Code, sign in with Google and name the agent.`,
  `claude.ai: add a custom connector with ${origin}/mcp`,
].join('\n');

/**
 * Email a connection who has no agent their connections can see, at most once a day per pair.
 * Returns what to tell whoever asked.
 */
export async function remind(env: MailEnv & { OAUTH_KV: KVNamespace }, from: Person, to: Connection, origin: string): Promise<string> {
  if (to.visible > 0) return `${to.handle} already has an agent you can see. Call agents, or look on your page.`;
  const key = `remind:${from.id}:${to.id}`;
  if (await env.OAUTH_KV.get(key)) return `${to.handle} was already reminded in the last day.`;
  const hidden = to.agents > 0;
  await sendMail(env, to.email, `${from.handle} wants their agent to talk to yours on Mesh`, [
    hidden
      ? `${from.handle} (${from.email}) is connected with you on Mesh, but all your agents are hidden from your connections, so ${from.handle}'s agents can't find one to ask.`
      : `${from.handle} (${from.email}) is connected with you on Mesh, but you haven't connected an agent yet, so ${from.handle}'s agents have nobody to ask.`,
    '',
    hidden ? `To show one, open ${origin} and switch it from Hidden to Visible.` : `To connect one:\n${setupText(origin)}`,
    '',
    `Talking still needs your approval, for a time you pick, each time an agent asks.`,
  ].join('\n'));
  await env.OAUTH_KV.put(key, '1', { expirationTtl: 86400 });
  return hidden ? `Reminded ${to.handle} that their agents are hidden.` : `Emailed ${to.handle} how to connect an agent.`;
}
