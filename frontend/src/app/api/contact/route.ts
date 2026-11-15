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
//   SITE_URL          (optional) your site address, e.g. https://aura-roan-phi.vercel.app,
//                     used to load the logo in the email

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

// Branded HTML for the email that lands in the Aura inbox. Same look as the
// verification and reset-password emails (frosted card, logo, violet/cyan accent).
// Inline styles and tables only, because email apps ignore most other CSS.
function renderEmail(opts: {
  fullName: string;
  email: string;
  message: string;
  logoUrl: string;
  receivedAt: string;
}): string {
  const name = escapeHtml(opts.fullName);
  const email = escapeHtml(opts.email);
  const message = escapeHtml(opts.message);
  const logo = escapeHtml(opts.logoUrl);
  const received = escapeHtml(opts.receivedAt);

  const label =
    'font-size:11px;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;color:#9ca3af;';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="color-scheme" content="light only" />
  <meta name="supported-color-schemes" content="light only" />
  <title>New message from ${name}</title>
</head>
<body style="margin:0;padding:0;background-color:#f0eeff;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;font-size:1px;line-height:1px;color:#f0eeff;">${name} sent a message through the Aura contact form.</div>
<div style="background-color:#f0eeff;background-image:linear-gradient(90deg,#7c3aed 0%,#06b6d4 100%),radial-gradient(circle at 8% 6%,rgba(124,58,237,0.16) 0%,rgba(124,58,237,0) 40%),radial-gradient(circle at 94% 28%,rgba(6,182,212,0.14) 0%,rgba(6,182,212,0) 38%);background-repeat:no-repeat;background-size:100% 3px,100% 100%,100% 100%;padding:72px 16px 40px;font-family:'DM Sans',Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;">

    <!-- Logo -->
    <tr>
      <td align="center" style="padding-bottom:22px;">
        <table role="presentation" cellpadding="0" cellspacing="0">
          <tr>
            <td width="44" height="44" style="width:44px;height:44px;font-size:0;line-height:0;"><img src="${logo}" width="44" height="44" alt="Aura" style="display:block;width:44px;height:44px;border:0;font-size:14px;color:#111827;" /></td>
            <td style="padding-left:12px;vertical-align:middle;font-size:28px;font-weight:700;letter-spacing:-0.6px;color:#111827;">Aura</td>
          </tr>
        </table>
      </td>
    </tr>

    <!-- Card -->
    <tr>
      <td bgcolor="#fbfaff" style="background-color:#fbfaff;background-color:rgba(255,255,255,0.72);border:1.5px solid #ffffff;border-radius:20px;padding:36px 32px;box-shadow:0 10px 30px rgba(17,24,39,0.05);">
        <h1 style="margin:0 0 8px;text-align:center;font-size:28px;font-weight:800;line-height:1.25;color:#111827;">New Contact Message</h1>
        <p style="margin:0 0 28px;text-align:center;font-size:14px;line-height:1.5;color:#4b5563;">
          Someone reached out through the Contact Us form.
        </p>

        <!-- Sender -->
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#ffffff" style="background-color:#ffffff;border:1.5px solid #e4e0f5;border-radius:12px;">
          <tr>
            <td style="padding:16px 18px 4px;${label}">From</td>
          </tr>
          <tr>
            <td style="padding:0 18px 12px;font-size:15px;font-weight:700;color:#111827;">${name}</td>
          </tr>
          <tr>
            <td style="padding:0 18px 4px;${label}">Email</td>
          </tr>
          <tr>
            <td style="padding:0 18px 12px;font-size:14px;"><a href="mailto:${email}" style="color:#7c3aed;text-decoration:none;font-weight:600;">${email}</a></td>
          </tr>
          <tr>
            <td style="padding:0 18px 4px;${label}">Received</td>
          </tr>
          <tr>
            <td style="padding:0 18px 16px;font-size:14px;color:#4b5563;">${received}</td>
          </tr>
        </table>

        <!-- Message -->
        <p style="margin:24px 0 8px;${label}">Message</p>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#ffffff" style="background-color:#ffffff;border:1.5px solid #e4e0f5;border-radius:12px;">
          <tr>
            <td style="padding:16px 18px;font-size:14px;line-height:1.6;color:#111827;white-space:pre-wrap;">${message}</td>
          </tr>
        </table>

        <hr style="border:none;border-top:1px solid #e5e7eb;margin:28px 0;" />

        <p style="margin:0;text-align:center;font-size:12px;line-height:1.5;color:#9ca3af;">
          Press Reply to answer ${name} directly.
        </p>
      </td>
    </tr>

    <!-- Footer -->
    <tr>
      <td style="padding-top:24px;text-align:center;font-size:12px;line-height:1.5;color:#9ca3af;">
        &copy; 2026 Aura. All rights reserved.
      </td>
    </tr>
  </table>
</div>
</body>
</html>`;
}

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

  // Google shows app passwords as "abcd efgh ijkl mnop". Spaces and quote marks pasted
  // into the Vercel field are the most common cause of "535 Username and Password not
  // accepted", so strip them (a real app password has neither).
  const user = process.env.SMTP_USER?.trim().replace(/^["']|["']$/g, '');
  const pass = process.env.SMTP_PASS?.replace(/\s+/g, '').replace(/^["']|["']$/g, '');
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
  // The logo is loaded from the site, so it needs an absolute address. Set SITE_URL on Vercel
  // to your production address; otherwise the address of this request is used.
  const siteUrl = (process.env.SITE_URL || new URL(req.url).origin).replace(/\/+$/, '');
  const receivedAt = new Date().toLocaleString('en-PH', {
    timeZone: 'Asia/Manila',
    dateStyle: 'medium',
    timeStyle: 'short',
  });

  try {
    await transporter.sendMail({
      // Gmail only lets you send as the account you log in with.
      from: { name: 'Aura Contact Form', address: user },
      to,
      // Pressing "Reply" in the inbox answers the visitor directly.
      replyTo: { name: fullName, address: email },
      subject: `[Aura Contact] Message from ${fullName}`,
      text: `${message}\n\n— ${fullName} (${email})`,
      html: renderEmail({
        fullName,
        email,
        message,
        logoUrl: `${siteUrl}/Aura_LogoRaster.png`,
        receivedAt,
      }),
    });
  } catch (err) {
    console.error('[contact] Sending failed:', err);
    if ((err as { code?: string })?.code === 'EAUTH') {
      console.error('[contact] Gmail rejected the login: check SMTP_USER and SMTP_PASS (Google App Password for that same account).');
    }
    return fail("We couldn't send your message right now. Please try again later.", 502);
  }

  return Response.json({ ok: true });
}