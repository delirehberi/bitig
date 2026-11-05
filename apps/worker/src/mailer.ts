export interface TransactionalEmail {
  readonly to: string;
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

export interface Mailer {
  send(email: TransactionalEmail): Promise<void>;
}

export class MailerError extends Error {
  readonly status?: number | undefined;

  constructor(message: string, status?: number, options?: ErrorOptions) {
    super(message, options);
    this.name = "MailerError";
    if (status !== undefined) {
      this.status = status;
    }
  }
}

const DEFAULT_MAIL_FROM = "Bitig <noreply@workouse.com>";

export function parseSenderAddress(raw: string): string | EmailAddress {
  const trimmed = raw.trim() || DEFAULT_MAIL_FROM;
  const match = /^(.+?)\s*<([^<>]+)>$/.exec(trimmed);
  if (match?.[1] && match[2]) {
    return {
      name: match[1].trim().replace(/^["']|["']$/g, ""),
      email: match[2].trim(),
    };
  }
  return trimmed;
}

export interface CloudflareEmailMailerOptions {
  readonly binding: SendEmail;
  readonly from: string;
}

/**
 * Sends transactional email through the native Cloudflare Email Sending
 * Workers binding (`env.EMAIL`, configured via `send_email` in wrangler.jsonc).
 */
export class CloudflareEmailMailer implements Mailer {
  readonly #binding: SendEmail;
  readonly #from: string | EmailAddress;

  constructor(options: CloudflareEmailMailerOptions) {
    this.#binding = options.binding;
    this.#from = parseSenderAddress(options.from);
  }

  async send(email: TransactionalEmail): Promise<void> {
    try {
      await this.#binding.send({
        from: this.#from,
        to: email.to,
        subject: email.subject,
        text: email.text,
        html: email.html,
      });
    } catch (error) {
      console.error("cloudflare email sending failed", {
        to: email.to,
        subject: email.subject,
        error,
      });
      throw new MailerError(
        error instanceof Error ? error.message : "Cloudflare Email Sending failed",
        undefined,
        { cause: error },
      );
    }
  }
}

const RESEND_API_URL = "https://api.resend.com/emails";

export interface ResendMailerOptions {
  readonly apiKey: string;
  readonly from: string;
  readonly fetchFn?: typeof fetch | undefined;
}

export class ResendMailer implements Mailer {
  readonly #apiKey: string;
  readonly #from: string;
  readonly #fetch: typeof fetch;

  constructor(options: ResendMailerOptions) {
    this.#apiKey = options.apiKey;
    this.#from = options.from.trim() || DEFAULT_MAIL_FROM;
    this.#fetch = options.fetchFn ?? fetch;
  }

  async send(email: TransactionalEmail): Promise<void> {
    let response: Response;
    try {
      response = await this.#fetch(RESEND_API_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.#apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: this.#from,
          to: [email.to],
          subject: email.subject,
          html: email.html,
          text: email.text,
        }),
      });
    } catch (error) {
      console.error("resend delivery network failure", { to: email.to, subject: email.subject, error });
      throw new MailerError("Failed to contact email provider", undefined, { cause: error });
    }

    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      console.error("resend delivery rejected", {
        to: email.to,
        subject: email.subject,
        status: response.status,
        body: bodyText,
      });
      throw new MailerError(`Email provider rejected delivery (HTTP ${String(response.status)})`, response.status);
    }
  }
}

export class FakeMailer implements Mailer {
  readonly sent: TransactionalEmail[] = [];
  shouldFail = false;

  send(email: TransactionalEmail): Promise<void> {
    if (this.shouldFail) {
      return Promise.reject(new MailerError("Simulated mailer failure", 502));
    }
    this.sent.push(email);
    return Promise.resolve();
  }

  clear(): void {
    this.sent.length = 0;
  }

  lastFor(recipient: string): TransactionalEmail | undefined {
    const normalized = recipient.trim().toLowerCase();
    for (let i = this.sent.length - 1; i >= 0; i--) {
      const item = this.sent[i];
      if (item?.to.trim().toLowerCase() === normalized) {
        return item;
      }
    }
    return undefined;
  }

  lastTo(recipient: string): TransactionalEmail | undefined {
    return this.lastFor(recipient);
  }

  extractLastCode(recipient: string): string | undefined {
    const msg = this.lastFor(recipient);
    if (!msg) return undefined;
    const match = /\b(\d{6})\b/.exec(msg.text);
    return match?.[1];
  }
}

export class ConsoleMailer implements Mailer {
  send(email: TransactionalEmail): Promise<void> {
    console.info("[mailer:dev]", {
      to: email.to,
      subject: email.subject,
      text: email.text,
    });
    return Promise.resolve();
  }
}

export interface CreateMailerInput {
  readonly emailBinding?: SendEmail | undefined;
  readonly resendApiKey?: string | undefined;
  readonly mailFrom?: string | undefined;
  readonly fetchFn?: typeof fetch | undefined;
}

/**
 * Selects the production or development Mailer:
 * 1. Native Cloudflare Email Sending binding (`env.EMAIL`) when configured,
 *    falling back to Resend if the binding fails and `RESEND_API_KEY` is set.
 * 2. Resend HTTP API when `RESEND_API_KEY` is provided.
 * 3. `ConsoleMailer` fallback in local dev when neither is configured.
 */
export function createMailer(input: CreateMailerInput): Mailer {
  const from = input.mailFrom !== undefined && input.mailFrom.trim().length > 0 ? input.mailFrom.trim() : DEFAULT_MAIL_FROM;
  const cfMailer =
    input.emailBinding && typeof input.emailBinding.send === "function"
      ? new CloudflareEmailMailer({
          binding: input.emailBinding,
          from,
        })
      : null;
  const resendKey = input.resendApiKey?.trim();
  const resendMailer =
    resendKey && resendKey.length > 0
      ? new ResendMailer({
          apiKey: resendKey,
          from,
          fetchFn: input.fetchFn,
        })
      : null;

  if (cfMailer && resendMailer) {
    return {
      async send(email: TransactionalEmail): Promise<void> {
        try {
          await cfMailer.send(email);
        } catch (cfError) {
          console.warn("Cloudflare Email Sending failed, falling back to Resend", {
            to: email.to,
            error: cfError,
          });
          await resendMailer.send(email);
        }
      },
    };
  }
  if (cfMailer) return cfMailer;
  if (resendMailer) return resendMailer;
  return new ConsoleMailer();
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function buildSignInCodeEmail(to: string, code: string, expiresMinutes = 10): TransactionalEmail {
  const safeCode = escapeHtml(code);
  return {
    to,
    subject: `${code} is your Bitig verification code`,
    text: `Your Bitig verification code is: ${code}\n\nThis code expires in ${String(expiresMinutes)} minutes. If you did not request this email, you can safely ignore it.`,
    html: `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#111827">
  <h2 style="margin:0 0 16px;font-size:20px">Sign in to Bitig</h2>
  <p style="margin:0 0 16px;line-height:1.5">Enter the following verification code to continue:</p>
  <div style="font-family:monospace;font-size:28px;font-weight:700;letter-spacing:6px;padding:16px;background:#f3f4f6;border-radius:8px;text-align:center;margin:0 0 16px">${safeCode}</div>
  <p style="margin:0;color:#6b7280;font-size:13px">This code expires in ${String(expiresMinutes)} minutes. If you did not request this email, you can safely ignore it.</p>
</div>`,
  };
}

export function buildInvitationEmail(input: {
  to: string;
  orgName?: string | undefined;
  organisationName?: string | undefined;
  inviterName: string;
  role: string;
  acceptUrl: string;
}): TransactionalEmail {
  const orgName = input.orgName ?? input.organisationName ?? "Organisation";
  const safeOrg = escapeHtml(orgName);
  const safeInviter = escapeHtml(input.inviterName);
  const safeRole = escapeHtml(input.role);
  const safeUrl = escapeHtml(input.acceptUrl);
  return {
    to: input.to,
    subject: `You have been invited to join ${orgName} on Bitig`,
    text: `${input.inviterName} invited you to join ${orgName} on Bitig as ${input.role}.\n\nAccept your invitation: ${input.acceptUrl}`,
    html: `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#111827">
  <h2 style="margin:0 0 16px;font-size:20px">Join ${safeOrg} on Bitig</h2>
  <p style="margin:0 0 16px;line-height:1.5"><strong>${safeInviter}</strong> invited you to join <strong>${safeOrg}</strong> as <strong>${safeRole}</strong>.</p>
  <p style="margin:0 0 20px"><a href="${safeUrl}" style="display:inline-block;padding:10px 18px;background:#111827;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:600">Accept invitation</a></p>
  <p style="margin:0;color:#6b7280;font-size:13px">Or copy and paste this URL: ${safeUrl}</p>
</div>`,
  };
}

export function buildEmailChangeEmail(to: string, code: string, expiresMinutes = 10): TransactionalEmail {
  const safeCode = escapeHtml(code);
  return {
    to,
    subject: `${code} — Confirm your new Bitig email address`,
    text: `Confirm your new Bitig email address with this code: ${code}\n\nThis code expires in ${String(expiresMinutes)} minutes.`,
    html: `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#111827">
  <h2 style="margin:0 0 16px;font-size:20px">Confirm your new email address</h2>
  <p style="margin:0 0 16px;line-height:1.5">Enter this verification code in Bitig to confirm your new email address:</p>
  <div style="font-family:monospace;font-size:28px;font-weight:700;letter-spacing:6px;padding:16px;background:#f3f4f6;border-radius:8px;text-align:center;margin:0 0 16px">${safeCode}</div>
  <p style="margin:0;color:#6b7280;font-size:13px">This code expires in ${String(expiresMinutes)} minutes.</p>
</div>`,
  };
}

export function buildAccountDeleteEmail(to: string, code: string, expiresMinutes = 10): TransactionalEmail {
  const safeCode = escapeHtml(code);
  return {
    to,
    subject: `${code} — Confirm Bitig account deletion`,
    text: `Use this code to confirm deleting your Bitig account: ${code}\n\nThis code expires in ${String(expiresMinutes)} minutes. If you did not request this, keep your account safe by ignoring this message.`,
    html: `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#111827">
  <h2 style="margin:0 0 16px;font-size:20px">Confirm account deletion</h2>
  <p style="margin:0 0 16px;line-height:1.5">Enter this code to permanently delete your Bitig account:</p>
  <div style="font-family:monospace;font-size:28px;font-weight:700;letter-spacing:6px;padding:16px;background:#fef2f2;color:#991b1b;border-radius:8px;text-align:center;margin:0 0 16px">${safeCode}</div>
  <p style="margin:0;color:#6b7280;font-size:13px">This code expires in ${String(expiresMinutes)} minutes.</p>
</div>`,
  };
}
