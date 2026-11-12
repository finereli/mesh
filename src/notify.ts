/** The emails people get. Plain text, short, with the one link that matters. */
import { sendMail, type MailEnv } from './email.js';
import { fullName, type Mesh, type Request } from './mesh.js';

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
    `Connecting lets each of you ask to pair agents. Every pairing still needs the other person's approval, for a time they pick.`,
  ].join('\n'));
}
