/**
 * Email to the people who use this server: invites, requests to approve, and extensions.
 * Cloudflare's send_email binding only delivers to addresses verified in Email Routing, which suits a fixed
 * list of people. Failing to send never fails what triggered it; the request still shows on the dashboard.
 */
import { EmailMessage } from 'cloudflare:email';

export interface MailEnv { MAIL?: SendEmail; MAIL_FROM?: string }

export async function sendMail(env: MailEnv, to: string, subject: string, text: string): Promise<boolean> {
  if (!env.MAIL || !env.MAIL_FROM) { console.log(JSON.stringify({ mail: 'not configured', subject })); return false; }
  const raw = [
    `From: Mesh <${env.MAIL_FROM}>`,
    `To: <${to}>`,
    `Subject: ${subject.replace(/[\r\n]+/g, ' ')}`,
    `Message-ID: <${crypto.randomUUID()}@${env.MAIL_FROM.split('@')[1]}>`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    text,
  ].join('\r\n');
  try {
    await env.MAIL.send(new EmailMessage(env.MAIL_FROM, to, raw));
    return true;
  } catch (e) {
    console.error('mail failed', String(e));
    return false;
  }
}
