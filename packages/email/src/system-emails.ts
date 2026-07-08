// System-email CONTENT (subject + html + text) for the transactional mailer. Pure
// builders — no I/O — so they're unit-testable and reused by the invite / reset flows.

export interface BuiltEmail {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** A minimal, self-contained branded shell (no external CSS/images). */
function shell(heading: string, bodyHtml: string): string {
  return `<!doctype html><html><body style="margin:0;background:#f5f5f4;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1c1917">
  <div style="max-width:520px;margin:0 auto;padding:32px 20px">
    <div style="background:#fff;border:1px solid #e7e5e4;border-radius:14px;padding:28px 26px">
      <h1 style="margin:0 0 14px;font-size:20px;color:#0c0a09">${esc(heading)}</h1>
      ${bodyHtml}
    </div>
    <p style="margin:16px 4px 0;font-size:12px;color:#a8a29e">On-Grow · this is an automated message, please don't reply.</p>
  </div></body></html>`;
}

function button(url: string, label: string): string {
  return `<p style="margin:22px 0"><a href="${esc(url)}" style="display:inline-block;background:#0d9488;color:#fff;text-decoration:none;font-weight:600;font-size:15px;padding:11px 20px;border-radius:10px">${esc(label)}</a></p>
  <p style="margin:8px 0;font-size:13px;color:#78716c">Or paste this link into your browser:<br><span style="color:#0d9488;word-break:break-all">${esc(url)}</span></p>`;
}

/** Invite email: a new teammate sets a password to join a company. */
export function buildInviteEmail(opts: {
  readonly companyName: string;
  readonly acceptUrl: string;
  readonly inviterName?: string | null;
}): BuiltEmail {
  const by = opts.inviterName ? ` by ${opts.inviterName}` : '';
  const subject = `You've been invited to ${opts.companyName} on On-Grow`;
  const html = shell(
    `Join ${opts.companyName}`,
    `<p style="margin:0;font-size:15px;line-height:1.6">You've been invited${esc(by)} to join <b>${esc(
      opts.companyName,
    )}</b> on On-Grow. Set a password to activate your account and get started.</p>${button(
      opts.acceptUrl,
      'Accept invite & set password',
    )}<p style="margin:14px 0 0;font-size:13px;color:#a8a29e">This invite expires in 7 days.</p>`,
  );
  const text = `You've been invited${by} to join ${opts.companyName} on On-Grow.\nSet your password to activate your account:\n${opts.acceptUrl}\n\nThis invite expires in 7 days.`;
  return { subject, html, text };
}

/** Password-reset email. */
export function buildPasswordResetEmail(opts: { readonly resetUrl: string }): BuiltEmail {
  const subject = 'Reset your On-Grow password';
  const html = shell(
    'Reset your password',
    `<p style="margin:0;font-size:15px;line-height:1.6">We received a request to reset your On-Grow password. Click below to choose a new one. If you didn't request this, you can safely ignore this email.</p>${button(
      opts.resetUrl,
      'Reset password',
    )}<p style="margin:14px 0 0;font-size:13px;color:#a8a29e">This link expires in 1 hour.</p>`,
  );
  const text = `Reset your On-Grow password:\n${opts.resetUrl}\n\nIf you didn't request this, ignore this email. The link expires in 1 hour.`;
  return { subject, html, text };
}
