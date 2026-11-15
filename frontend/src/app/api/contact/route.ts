// src/app/api/contact/route.ts
//
// Receives the Contact Us form from the home page and emails it to the Aura inbox.
//
// WHY HERE AND NOT IN THE FASTAPI BACKEND: Render's free tier blocks outbound SMTP
// ports (25, 465, 587), so the backend cannot send mail through Gmail. This route
// runs on Vercel, where SMTP works.
//
// Environment variables (Vercel > Project > Settings > Environment Variables,
// and .env.local when running locally):
//   SMTP_USER         the Gmail address that sends the mail, e.g. analyzeaura@gmail.com
//   SMTP_PASS         that account's 16-character Google App Password (not the normal password)
//   CONTACT_TO_EMAIL  (optional) where messages are delivered; defaults to SMTP_USER
//   SMTP_HOST / SMTP_PORT  (optional) default smtp.gmail.com / 465

import nodemailer from 'nodemailer';

// nodemailer needs Node APIs, so this route must not run on the Edge runtime.
export const runtime = 'nodejs';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_NAME = 50;
const MAX_EMAIL = 254;
const MAX_MESSAGE = 2000;

// Simple spam brake: at most 3 messages per IP every 10 minutes. This memory is per
// serverless instance, so it is a speed bump, not a hard limit.
const RATE_LIMIT = 3;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const recentHits = new Map<string, number[]>();

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const hits = (recentHits.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (hits.length >= RATE_LIMIT) {
    recentHits.set(ip, hits);
    return true;
  }
  hits.push(now);
  recentHits.set(ip, hits);
  return false;
}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
// Names and the subject go into mail headers, so strip any line breaks.
const oneLine = (value: string): string => value.replace(/[\r\n]+/g, ' ');
const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const fail = (error: string, status: number) => Response.json({ error }, { status });

export async function POST(req: Request) {
  let data: Record<string, unknown>;
  try {
    data = await req.json();
  } catch {
    return fail('Invalid request.', 400);
  }

  // Honeypot: the form has a hidden "website" field that people never see but bots
  // fill in. Pretend it worked and drop the message.
  if (text(data.website) !== '') return Response.json({ ok: true });

  const firstName = oneLine(text(data.firstName));
  const lastName = oneLine(text(data.lastName));
  const email = text(data.email);
  const message = text(data.message);

  if (!firstName || !lastName) return fail('Please enter your first and last name.', 400);
  if (firstName.length > MAX_NAME || lastName.length > MAX_NAME) {
    return fail('That name is too long.', 400);
  }
  if (!email || !EMAIL_RE.test(email) || email.length > MAX_EMAIL) {
    return fail('Please enter a valid email address.', 400);
  }
  if (!message) return fail('Please enter a message.', 400);
  if (message.length > MAX_MESSAGE) {
    return fail(`Your message is too long (maximum ${MAX_MESSAGE} characters).`, 400);
  }

  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  if (isRateLimited(ip)) {
    return fail('Too many messages. Please wait a few minutes and try again.', 429);
  }

  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const to = process.env.CONTACT_TO_EMAIL || user;
  if (!user || !pass || !to) {
    console.error('[contact] SMTP_USER / SMTP_PASS / CONTACT_TO_EMAIL are not configured.');
    return fail("We couldn't send your message right now. Please try again later.", 500);
  }

  const port = Number(process.env.SMTP_PORT ?? 465);
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST ?? 'smtp.gmail.com',
    port,
    secure: port === 465,
    auth: { user, pass },
  });

  const fullName = `${firstName} ${lastName}`;

  try {
    await transporter.sendMail({
      // Gmail only lets you send as the account you log in with.
      from: { name: 'Aura Contact Form', address: user },
      to,
      // Pressing "Reply" in the inbox answers the visitor directly.
      replyTo: { name: fullName, address: email },
      subject: `[Aura Contact] Message from ${fullName}`,
      text: `${message}\n\n— ${fullName} (${email})`,
      html:
        `<p style="white-space:pre-wrap;margin:0 0 16px;">${escapeHtml(message)}</p>` +
        `<p style="margin:0;color:#6b7280;">— ${escapeHtml(fullName)} (${escapeHtml(email)})</p>`,
    });
  } catch (err) {
    console.error('[contact] Sending failed:', err);
    return fail("We couldn't send your message right now. Please try again later.", 502);
  }

  return Response.json({ ok: true });
}