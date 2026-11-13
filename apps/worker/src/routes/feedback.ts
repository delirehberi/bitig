import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import {
  CreateFeedbackFormInputSchema,
  FEEDBACK_SUBMISSION_BODY_MAX,
  FEEDBACK_SUBMISSION_TITLE_MAX,
  FEEDBACK_SUBMITTER_EMAIL_MAX,
  FEEDBACK_SUBMITTER_NAME_MAX,
  FeedbackPageUrlSchema,
  FeedbackPublicIdSchema,
  IdSchema,
  NotFoundError,
  UpdateFeedbackFormInputSchema,
  ValidationError,
  feedbackTaskActor,
  hasMinimumOrgRole,
  normalizeAllowedOrigin,
  spamScore,
  taskFromFeedbackSubmission,
  validateFeedbackSubmissionForForm,
  type FeedbackForm,
  type FeedbackSubmission,
  type OrganisationRole,
} from "@bitig/core";
import { D1FeedbackStore, D1Storage, findFormByPublicId } from "@bitig/storage-d1";
import type { Context } from "hono";
import { ForbiddenRoleError } from "../auth";
import type { AppEnv } from "../index";
import { publishRealtimeEvent, withRealtimeBroadcast } from "../realtime";

const HTTP_OK = 200;
const HTTP_CREATED = 201;
const HTTP_NO_CONTENT = 204;
const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;

export interface FeedbackFormResponse extends FeedbackForm {
  readonly publicPath: string;
  readonly publicUrl: string;
  readonly publicLink: string;
  readonly pendingCount: number;
}

const CreateProjectFeedbackFormBodySchema = CreateFeedbackFormInputSchema.omit({
  projectId: true,
  orgId: true,
});

function assertFeedbackRole(c: Context<AppEnv>, minRole: OrganisationRole): void {
  const role = c.get("orgRole");
  if (!role || !hasMinimumOrgRole(role, minRole)) {
    throw new ForbiddenRoleError(`Forbidden: ${minRole} role required`);
  }
}

function createScopedFeedbackStore(c: Context<AppEnv>): D1FeedbackStore {
  return new D1FeedbackStore({
    db: c.env.DB,
    orgId: c.get("orgId"),
  });
}

function resolveFeedbackActor(c: Context<AppEnv>): string | undefined {
  const user = c.get("user");
  if (user) {
    return user.displayName || user.username;
  }
  return c.req.header("X-Bitig-Actor") ?? c.req.header("X-Bitig-Agent") ?? undefined;
}

export function buildFeedbackPublicPath(publicId: string): string {
  return `/f/${encodeURIComponent(publicId)}`;
}

export function buildFeedbackPublicUrl(c: Context<AppEnv>, publicId: string): string {
  const reqOrigin = new URL(c.req.url).origin;
  const publicPath = buildFeedbackPublicPath(publicId);
  return `${reqOrigin}${publicPath}`;
}

export function formatFeedbackFormResponse(
  c: Context<AppEnv>,
  form: FeedbackForm,
  pendingCount: number,
): FeedbackFormResponse {
  const publicPath = buildFeedbackPublicPath(form.publicId);
  const publicUrl = buildFeedbackPublicUrl(c, form.publicId);
  return {
    ...form,
    publicPath,
    publicUrl,
    publicLink: publicUrl,
    pendingCount,
  };
}

// ---------------------------------------------------------------------------
// Public /f/* CSP and Framing Headers
// ---------------------------------------------------------------------------

/**
 * Builds the `Content-Security-Policy` header value for `/f/*` routes:
 * - Replaces the global `frame-ancestors 'none'` with `frame-ancestors` built
 *   from the form's normalized `allowedOrigins` (or `'none'` when empty).
 * - Allows `https://challenges.cloudflare.com` for Cloudflare Turnstile.
 */
export function buildPublicFeedbackCsp(allowedOrigins?: readonly string[]): string {
  const normalizedOrigins: string[] = [];
  for (const raw of allowedOrigins ?? []) {
    const normalized = normalizeAllowedOrigin(raw);
    if (normalized !== null && !normalizedOrigins.includes(normalized)) {
      normalizedOrigins.push(normalized);
    }
  }
  const frameAncestors =
    normalizedOrigins.length > 0 ? normalizedOrigins.join(" ") : "'none'";

  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "connect-src 'self' https://challenges.cloudflare.com",
    "frame-src https://challenges.cloudflare.com",
    `frame-ancestors ${frameAncestors}`,
  ].join("; ");
}

/**
 * Replaces the global `X-Frame-Options: DENY` and `frame-ancestors 'none'` on
 * `/f/*` responses with the form-specific `Content-Security-Policy`.
 */
export function applyPublicFeedbackSecurityHeaders(
  c: Pick<Context<AppEnv>, "res" | "get">,
): void {
  c.res.headers.delete("X-Frame-Options");
  const allowedOrigins = c.get("feedbackAllowedOrigins");
  c.res.headers.set("Content-Security-Policy", buildPublicFeedbackCsp(allowedOrigins));
}

// ---------------------------------------------------------------------------
// Abuse Protection Hook (extended in BIT-178)
// ---------------------------------------------------------------------------

export interface FeedbackAbuseCheckContext {
  readonly c: Context<AppEnv>;
  readonly form: FeedbackForm;
  readonly submission: FeedbackSubmission;
  readonly rawBody: Readonly<Record<string, unknown>>;
  readonly feedbackStore: D1FeedbackStore;
}

export type FeedbackAbuseCheckResult =
  | {
      readonly status: "allow";
      readonly spamScore?: number | undefined;
      readonly ipHash?: string | undefined;
      readonly bodyHash?: string | undefined;
    }
  | {
      readonly status: "drop";
    }
  | {
      readonly status: "reject";
      readonly httpStatus?: 400 | 403 | 429 | undefined;
      readonly message?: string | undefined;
    };

export type FeedbackAbuseCheckHook = (
  ctx: FeedbackAbuseCheckContext,
) => Promise<FeedbackAbuseCheckResult> | FeedbackAbuseCheckResult;

let activeFeedbackAbuseCheckHook: FeedbackAbuseCheckHook | undefined;

/**
 * Registers or clears a custom abuse-check hook before task creation.
 */
export function setFeedbackAbuseCheckHook(hook?: FeedbackAbuseCheckHook): void {
  activeFeedbackAbuseCheckHook = hook;
}

/**
 * Hook executed on `POST /f/:publicId` after field validation and before
 * creating the pending task (#BIT-177 / #BIT-178).
 */
export async function runFeedbackAbuseChecks(
  ctx: FeedbackAbuseCheckContext,
): Promise<FeedbackAbuseCheckResult> {
  if (activeFeedbackAbuseCheckHook) {
    return activeFeedbackAbuseCheckHook(ctx);
  }
  return {
    status: "allow",
    spamScore: spamScore(ctx.submission, ctx.form),
  };
}

// ---------------------------------------------------------------------------
// Server-Rendered HTML (Hallmark tokens, light & dark, accent colour, embed)
// ---------------------------------------------------------------------------

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function isEmbedParam(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function buildHallmarkStyles(accentColor?: string): string {
  const accentOverride = accentColor
    ? `
      :root, [data-theme="dark"] {
        --form-accent: ${accentColor};
        --color-accent: ${accentColor};
        --color-accent-ink: ${accentColor};
        --color-focus: ${accentColor};
        --color-accent-soft: color-mix(in oklch, ${accentColor} 14%, var(--color-paper));
      }
      @media (prefers-color-scheme: dark) {
        :root:not([data-theme="light"]) {
          --form-accent: ${accentColor};
          --color-accent: ${accentColor};
          --color-accent-ink: ${accentColor};
          --color-focus: ${accentColor};
          --color-accent-soft: color-mix(in oklch, ${accentColor} 20%, var(--color-paper));
        }
      }`
    : "";

  return `
    :root {
      color-scheme: light dark;
      --color-paper: oklch(97.6% 0.011 80);
      --color-paper-2: oklch(95.4% 0.015 78);
      --color-paper-3: oklch(92.6% 0.02 76);
      --color-ink: oklch(27% 0.024 52);
      --color-ink-2: oklch(43% 0.024 55);
      --color-ink-3: oklch(51% 0.02 60);
      --color-rule: oklch(88.5% 0.02 74);
      --color-rule-strong: oklch(80% 0.026 70);
      --color-accent: oklch(62% 0.12 45);
      --color-accent-ink: oklch(44% 0.11 45);
      --color-accent-soft: oklch(93% 0.035 55);
      --color-ok: oklch(52% 0.1 155);
      --color-ok-soft: oklch(94% 0.035 155);
      --color-danger: oklch(51% 0.15 25);
      --color-danger-soft: oklch(94% 0.03 25);
      --color-focus: oklch(48% 0.13 45);
      --font-display: "Plus Jakarta Sans Variable", "Plus Jakarta Sans", system-ui, sans-serif;
      --font-body: "Atkinson Hyperlegible Next Variable", "Atkinson Hyperlegible Next", system-ui, sans-serif;
      --font-mono: "JetBrains Mono Variable", "JetBrains Mono", ui-monospace, monospace;
      --text-2xs: 0.6875rem;
      --text-xs: 0.75rem;
      --text-sm: 0.875rem;
      --text-base: 1rem;
      --text-lg: 1.125rem;
      --text-xl: 1.375rem;
      --text-2xl: 1.75rem;
      --space-2xs: 4px;
      --space-xs: 8px;
      --space-sm: 12px;
      --space-md: 16px;
      --space-lg: 24px;
      --space-xl: 32px;
      --space-2xl: 48px;
      --radius-sm: 8px;
      --radius-md: 14px;
      --radius-lg: 22px;
      --radius-pill: 999px;
      --rule-hairline: 1px;
      --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
      --dur-short: 120ms;
      --dur-med: 220ms;
      --measure: 62ch;
    }

    @media (prefers-color-scheme: dark) {
      :root:not([data-theme="light"]) {
        --color-paper: oklch(18% 0.014 55);
        --color-paper-2: oklch(22% 0.016 55);
        --color-paper-3: oklch(26% 0.018 55);
        --color-ink: oklch(93% 0.012 78);
        --color-ink-2: oklch(76% 0.016 74);
        --color-ink-3: oklch(62% 0.016 70);
        --color-rule: oklch(30% 0.018 55);
        --color-rule-strong: oklch(38% 0.022 55);
        --color-accent: oklch(68% 0.12 45);
        --color-accent-ink: oklch(80% 0.1 45);
        --color-accent-soft: oklch(27% 0.04 45);
        --color-ok: oklch(68% 0.11 155);
        --color-ok-soft: oklch(25% 0.04 155);
        --color-danger: oklch(68% 0.15 25);
        --color-danger-soft: oklch(26% 0.05 25);
        --color-focus: oklch(72% 0.13 45);
      }
    }

    [data-theme="dark"] {
      --color-paper: oklch(18% 0.014 55);
      --color-paper-2: oklch(22% 0.016 55);
      --color-paper-3: oklch(26% 0.018 55);
      --color-ink: oklch(93% 0.012 78);
      --color-ink-2: oklch(76% 0.016 74);
      --color-ink-3: oklch(62% 0.016 70);
      --color-rule: oklch(30% 0.018 55);
      --color-rule-strong: oklch(38% 0.022 55);
      --color-accent: oklch(68% 0.12 45);
      --color-accent-ink: oklch(80% 0.1 45);
      --color-accent-soft: oklch(27% 0.04 45);
      --color-ok: oklch(68% 0.11 155);
      --color-ok-soft: oklch(25% 0.04 155);
      --color-danger: oklch(68% 0.15 25);
      --color-danger-soft: oklch(26% 0.05 25);
      --color-focus: oklch(72% 0.13 45);
    }
    ${accentOverride}

    *, *::before, *::after {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      font-family: var(--font-body);
      font-size: var(--text-base);
      line-height: 1.55;
      color: var(--color-ink);
      background-color: var(--color-paper);
      -webkit-font-smoothing: antialiased;
    }

    .feedback-shell {
      min-height: 100dvh;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      padding: var(--space-xl) var(--space-md);
    }

    body.is-embed .feedback-shell {
      min-height: auto;
      padding: var(--space-md);
    }

    .feedback-chrome-header {
      max-width: 36rem;
      width: 100%;
      margin: 0 auto var(--space-md);
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-family: var(--font-display);
      font-size: var(--text-xs);
      font-weight: 600;
      letter-spacing: 0.02em;
      color: var(--color-ink-3);
    }

    .feedback-card {
      max-width: 36rem;
      width: 100%;
      margin: 0 auto;
      background-color: var(--color-paper-2);
      border: var(--rule-hairline) solid var(--color-rule);
      border-radius: var(--radius-lg);
      padding: var(--space-xl);
      border-top: 4px solid var(--color-accent);
    }

    body.is-embed .feedback-card {
      max-width: none;
      background-color: var(--color-paper);
      border: none;
      border-radius: 0;
      padding: 0;
    }

    .feedback-title {
      margin: 0 0 var(--space-xs);
      font-family: var(--font-display);
      font-size: var(--text-xl);
      font-weight: 700;
      line-height: 1.25;
      color: var(--color-ink);
    }

    .feedback-intro {
      margin: 0 0 var(--space-lg);
      font-size: var(--text-sm);
      color: var(--color-ink-2);
      white-space: pre-line;
    }

    .feedback-alert {
      margin: 0 0 var(--space-md);
      padding: var(--space-sm) var(--space-md);
      border-radius: var(--radius-sm);
      border: var(--rule-hairline) solid var(--color-danger);
      background-color: var(--color-danger-soft);
      color: var(--color-danger);
      font-size: var(--text-sm);
    }

    .feedback-thank-you {
      padding: var(--space-md) 0;
      font-size: var(--text-base);
      color: var(--color-ink);
      white-space: pre-line;
    }

    .feedback-field {
      margin-bottom: var(--space-md);
    }

    .feedback-label {
      display: block;
      margin-bottom: var(--space-2xs);
      font-family: var(--font-display);
      font-size: var(--text-sm);
      font-weight: 600;
      color: var(--color-ink);
    }

    .feedback-optional {
      font-weight: 400;
      color: var(--color-ink-3);
      font-size: var(--text-xs);
    }

    .feedback-input,
    .feedback-select,
    .feedback-textarea {
      width: 100%;
      font-family: var(--font-body);
      font-size: var(--text-base);
      color: var(--color-ink);
      background-color: var(--color-paper);
      border: var(--rule-hairline) solid var(--color-rule-strong);
      border-radius: var(--radius-sm);
      padding: var(--space-xs) var(--space-sm);
      transition: border-color var(--dur-short) var(--ease-out);
    }

    body.is-embed .feedback-input,
    body.is-embed .feedback-select,
    body.is-embed .feedback-textarea {
      background-color: var(--color-paper-2);
    }

    .feedback-textarea {
      resize: vertical;
      min-height: 7.5rem;
    }

    .feedback-input:focus,
    .feedback-select:focus,
    .feedback-textarea:focus {
      outline: 2px solid var(--color-focus);
      outline-offset: 1px;
      border-color: var(--color-accent);
    }

    .feedback-actions {
      margin-top: var(--space-lg);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-md);
      flex-wrap: wrap;
    }

    .feedback-submit {
      appearance: none;
      border: none;
      border-radius: var(--radius-pill);
      background-color: var(--color-accent);
      color: var(--color-paper);
      font-family: var(--font-display);
      font-size: var(--text-sm);
      font-weight: 600;
      padding: var(--space-sm) var(--space-lg);
      cursor: pointer;
      transition: opacity var(--dur-short) var(--ease-out);
    }

    .feedback-submit:hover {
      opacity: 0.92;
    }

    .feedback-submit:focus-visible {
      outline: 2px solid var(--color-focus);
      outline-offset: 2px;
    }

    .feedback-footer {
      max-width: 36rem;
      width: 100%;
      margin: var(--space-md) auto 0;
      font-size: var(--text-xs);
      color: var(--color-ink-3);
    }

    body.is-embed .feedback-footer {
      max-width: none;
      margin-top: var(--space-sm);
    }

    .feedback-privacy-link {
      color: var(--color-ink-2);
      text-decoration: underline;
      text-underline-offset: 2px;
    }

    .feedback-privacy-note {
      margin: var(--space-2xs) 0 0;
      color: var(--color-ink-3);
      line-height: 1.45;
    }
  `;
}

function buildEmbedResizeScript(publicId: string): string {
  const safePublicId = JSON.stringify(publicId);
  return `<script>
(function () {
  if (!window.parent || window.parent === window) return;
  function reportHeight() {
    var docEl = document.documentElement;
    var body = document.body;
    var height = Math.ceil(
      Math.max(
        body ? body.scrollHeight : 0,
        docEl ? docEl.scrollHeight : 0,
        body ? body.offsetHeight : 0
      )
    );
    window.parent.postMessage(
      { type: "bitig:feedback:resize", publicId: ${safePublicId}, height: height },
      "*"
    );
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", reportHeight);
  } else {
    reportHeight();
  }
  window.addEventListener("load", reportHeight);
  window.addEventListener("resize", reportHeight);
  if (typeof ResizeObserver === "function" && document.body) {
    new ResizeObserver(reportHeight).observe(document.body);
  }
})();
</script>`;
}

export interface RenderPublicFeedbackPageOptions {
  readonly embed?: boolean | undefined;
  readonly pageUrl?: string | undefined;
  readonly errorMessage?: string | undefined;
  readonly values?: {
    readonly title?: string | undefined;
    readonly body?: string | undefined;
    readonly category?: string | undefined;
    readonly submitterName?: string | undefined;
    readonly submitterEmail?: string | undefined;
  } | undefined;
}

export function renderPublicFeedbackPage(
  form: FeedbackForm,
  options?: RenderPublicFeedbackPageOptions,
): string {
  const embed = Boolean(options?.embed);
  const publicPath = buildFeedbackPublicPath(form.publicId);
  const actionUrl = embed ? `${publicPath}?embed=1` : publicPath;
  const privacyHref = `${publicPath}/privacy`;
  const titleVal = options?.values?.title ?? "";
  const bodyVal = options?.values?.body ?? "";
  const categoryVal = options?.values?.category ?? "";
  const nameVal = options?.values?.submitterName ?? "";
  const emailVal = options?.values?.submitterEmail ?? "";

  const introHtml =
    form.intro.trim().length > 0
      ? `<p class="feedback-intro">${escapeHtml(form.intro)}</p>`
      : "";

  const errorHtml =
    options?.errorMessage !== undefined && options.errorMessage.length > 0
      ? `<div class="feedback-alert" role="alert">${escapeHtml(options.errorMessage)}</div>`
      : "";

  const categoryFieldHtml =
    form.fields.categories.length > 0
      ? `<div class="feedback-field">
          <label class="feedback-label" for="feedback-category">Category <span class="feedback-optional">(optional)</span></label>
          <select class="feedback-select" id="feedback-category" name="category">
            <option value="">Select a category</option>
            ${form.fields.categories
              .map(
                (cat) =>
                  `<option value="${escapeHtml(cat)}"${cat === categoryVal ? " selected" : ""}>${escapeHtml(cat)}</option>`,
              )
              .join("\n            ")}
          </select>
        </div>`
      : "";

  const nameFieldHtml = form.fields.name
    ? `<div class="feedback-field">
        <label class="feedback-label" for="feedback-name">Name <span class="feedback-optional">(optional)</span></label>
        <input class="feedback-input" id="feedback-name" name="submitterName" type="text" maxlength="${String(FEEDBACK_SUBMITTER_NAME_MAX)}" value="${escapeHtml(nameVal)}" autocomplete="name" />
      </div>`
    : "";

  const emailMode = form.fields.email;
  const emailFieldHtml =
    emailMode !== "off"
      ? `<div class="feedback-field">
          <label class="feedback-label" for="feedback-email">Email ${
            emailMode === "required"
              ? '<span aria-hidden="true">*</span>'
              : '<span class="feedback-optional">(optional)</span>'
          }</label>
          <input class="feedback-input" id="feedback-email" name="submitterEmail" type="email" maxlength="${String(FEEDBACK_SUBMITTER_EMAIL_MAX)}" value="${escapeHtml(emailVal)}" autocomplete="email"${emailMode === "required" ? " required" : ""} />
        </div>`
      : "";

  const turnstileHtml = form.turnstile
    ? `<div class="feedback-field feedback-turnstile">
        <div class="cf-turnstile" data-action="feedback"></div>
      </div>
      <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>`
    : "";

  const hiddenEmbedHtml = embed ? `<input type="hidden" name="embed" value="1" />` : "";
  const hiddenPageUrlHtml =
    options?.pageUrl !== undefined && options.pageUrl.length > 0
      ? `<input type="hidden" name="pageUrl" value="${escapeHtml(options.pageUrl)}" />`
      : "";

  const chromeHeaderHtml = embed
    ? ""
    : `<header class="feedback-chrome-header">
        <span>${escapeHtml(form.name)}</span>
        <span>Feedback</span>
      </header>`;

  const accentAttr =
    form.accentColor !== undefined ? ` data-accent-color="${escapeHtml(form.accentColor)}"` : "";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(form.title)}</title>
  <style>${buildHallmarkStyles(form.accentColor)}</style>
</head>
<body class="feedback-body${embed ? " is-embed" : ""}" data-embed="${embed ? "true" : "false"}"${accentAttr}>
  <div class="feedback-shell">
    ${chromeHeaderHtml}
    <main class="feedback-card">
      <h1 class="feedback-title">${escapeHtml(form.title)}</h1>
      ${introHtml}
      ${errorHtml}
      <form class="feedback-form" method="post" action="${escapeHtml(actionUrl)}">
        ${hiddenEmbedHtml}
        ${hiddenPageUrlHtml}
        <div class="feedback-field">
          <label class="feedback-label" for="feedback-title">Title <span aria-hidden="true">*</span></label>
          <input class="feedback-input" id="feedback-title" name="title" type="text" required maxlength="${String(FEEDBACK_SUBMISSION_TITLE_MAX)}" value="${escapeHtml(titleVal)}" />
        </div>
        ${categoryFieldHtml}
        <div class="feedback-field">
          <label class="feedback-label" for="feedback-body">Details <span aria-hidden="true">*</span></label>
          <textarea class="feedback-textarea" id="feedback-body" name="body" required maxlength="${String(FEEDBACK_SUBMISSION_BODY_MAX)}" rows="5">${escapeHtml(bodyVal)}</textarea>
        </div>
        ${nameFieldHtml}
        ${emailFieldHtml}
        ${turnstileHtml}
        <div class="feedback-actions">
          <button class="feedback-submit" type="submit">Send feedback</button>
        </div>
      </form>
    </main>
    <footer class="feedback-footer" id="privacy">
      <a class="feedback-privacy-link" href="${escapeHtml(privacyHref)}"${embed ? ' target="_blank" rel="noopener noreferrer"' : ""}>Privacy note</a>
      <p class="feedback-privacy-note">Your submission is reviewed by the project maintainers. Contact details are only visible to organisation members, your raw IP is never stored, and rejected or spam entries are purged after 30 days.</p>
    </footer>
  </div>
  ${embed ? buildEmbedResizeScript(form.publicId) : ""}
</body>
</html>`;
}

export function renderFeedbackThankYouPage(
  form: FeedbackForm,
  options?: { readonly embed?: boolean | undefined },
): string {
  const embed = Boolean(options?.embed);
  const publicPath = buildFeedbackPublicPath(form.publicId);
  const privacyHref = `${publicPath}/privacy`;
  const chromeHeaderHtml = embed
    ? ""
    : `<header class="feedback-chrome-header">
        <span>${escapeHtml(form.name)}</span>
        <span>Feedback</span>
      </header>`;
  const accentAttr =
    form.accentColor !== undefined ? ` data-accent-color="${escapeHtml(form.accentColor)}"` : "";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(form.title)}</title>
  <style>${buildHallmarkStyles(form.accentColor)}</style>
</head>
<body class="feedback-body${embed ? " is-embed" : ""}" data-embed="${embed ? "true" : "false"}"${accentAttr}>
  <div class="feedback-shell">
    ${chromeHeaderHtml}
    <main class="feedback-card" role="status" aria-live="polite">
      <h1 class="feedback-title">${escapeHtml(form.title)}</h1>
      <p class="feedback-thank-you">${escapeHtml(form.thankYouText)}</p>
    </main>
    <footer class="feedback-footer" id="privacy">
      <a class="feedback-privacy-link" href="${escapeHtml(privacyHref)}"${embed ? ' target="_blank" rel="noopener noreferrer"' : ""}>Privacy note</a>
    </footer>
  </div>
  ${embed ? buildEmbedResizeScript(form.publicId) : ""}
</body>
</html>`;
}

export function renderFeedbackPrivacyPage(form?: FeedbackForm): string {
  const title = form ? `Privacy note — ${form.title}` : "Feedback privacy note";
  const backHref = form ? buildFeedbackPublicPath(form.publicId) : undefined;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>${buildHallmarkStyles(form?.accentColor)}</style>
</head>
<body class="feedback-body">
  <div class="feedback-shell">
    <main class="feedback-card">
      <h1 class="feedback-title">${escapeHtml(title)}</h1>
      <p class="feedback-intro">How feedback submissions are handled and retained:</p>
      <ul>
        <li>Submissions create a pending item for project maintainers to review.</li>
        <li>Optional name and email fields are shown only to organisation members and are never included in public task descriptions.</li>
        <li>Your raw IP address is never stored; only a keyed HMAC hash and truncated user-agent are kept to prevent spam and duplicate posts.</li>
        <li>Rejected and spam submissions are deleted immediately and their metadata rows are automatically purged after 30 days.</li>
      </ul>
      ${backHref ? `<p><a class="feedback-privacy-link" href="${escapeHtml(backHref)}">Back to form</a></p>` : ""}
    </main>
  </div>
</body>
</html>`;
}

function renderFeedbackNotFoundPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Form not found</title>
  <style>${buildHallmarkStyles()}</style>
</head>
<body class="feedback-body">
  <div class="feedback-shell">
    <main class="feedback-card">
      <h1 class="feedback-title">Form not found</h1>
      <p class="feedback-intro">This feedback form does not exist or is no longer accepting submissions.</p>
    </main>
  </div>
</body>
</html>`;
}

function isJsonRequest(c: Context<AppEnv>): boolean {
  const contentType = (c.req.header("content-type") ?? "").toLowerCase();
  if (contentType.includes("application/json") || contentType.includes("+json")) {
    return true;
  }
  const accept = (c.req.header("accept") ?? "").toLowerCase();
  return accept.includes("application/json") && !accept.includes("text/html");
}

function respondPublicNotFound(c: Context<AppEnv>): Response {
  if (isJsonRequest(c)) {
    return c.json({ error: "not_found" }, HTTP_NOT_FOUND);
  }
  return c.html(renderFeedbackNotFoundPage(), HTTP_NOT_FOUND);
}

const KNOWN_AUXILIARY_FORM_KEYS = new Set([
  "embed",
  "email",
  "name",
  "details",
  "description",
  "url",
  "cf-turnstile-response",
  "turnstileToken",
  "honeypot",
  "website",
  "_hp",
  "timestamp",
  "_ts",
  "signature",
  "_sig",
]);

function asOptionalString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  return undefined;
}

function normalizeRawSubmissionPayload(
  raw: Readonly<Record<string, unknown>>,
  queryPageUrl: string | undefined,
): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};

  if ("title" in raw) {
    normalized.title = raw.title;
  }
  if ("body" in raw) {
    normalized.body = raw.body;
  } else if ("details" in raw) {
    normalized.body = raw.details;
  } else if ("description" in raw) {
    normalized.body = raw.description;
  }

  if ("category" in raw) {
    normalized.category = raw.category;
  }

  if ("submitterEmail" in raw) {
    normalized.submitterEmail = raw.submitterEmail;
  } else if ("email" in raw) {
    normalized.submitterEmail = raw.email;
  }

  if ("submitterName" in raw) {
    normalized.submitterName = raw.submitterName;
  } else if ("name" in raw) {
    normalized.submitterName = raw.name;
  }

  if ("pageUrl" in raw) {
    normalized.pageUrl = raw.pageUrl;
  } else if ("url" in raw) {
    normalized.pageUrl = raw.url;
  } else if (queryPageUrl !== undefined && queryPageUrl.trim().length > 0) {
    normalized.pageUrl = queryPageUrl;
  }

  for (const [key, value] of Object.entries(raw)) {
    if (!(key in normalized) && !KNOWN_AUXILIARY_FORM_KEYS.has(key)) {
      normalized[key] = value;
    }
  }

  return normalized;
}

async function parsePublicSubmissionBody(
  c: Context<AppEnv>,
): Promise<{ ok: true; raw: Record<string, unknown>; isFormPost: boolean } | { ok: false }> {
  const contentType = (c.req.header("content-type") ?? "").toLowerCase();

  if (contentType.includes("application/json") || contentType.includes("+json")) {
    try {
      const parsed: unknown = await c.req.json();
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return { ok: false };
      }
      return { ok: true, raw: parsed as Record<string, unknown>, isFormPost: false };
    } catch {
      return { ok: false };
    }
  }

  if (
    contentType.includes("application/x-www-form-urlencoded") ||
    contentType.includes("multipart/form-data")
  ) {
    try {
      const body = await c.req.parseBody();
      const raw: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(body)) {
        if (typeof val === "string") {
          raw[key] = val;
        }
      }
      return { ok: true, raw, isFormPost: true };
    } catch {
      return { ok: false };
    }
  }

  try {
    const text = await c.req.text();
    const trimmed = text.trim();
    if (trimmed.startsWith("{")) {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return { ok: true, raw: parsed as Record<string, unknown>, isFormPost: false };
      }
      return { ok: false };
    }
    const params = new URLSearchParams(text);
    const raw: Record<string, unknown> = {};
    for (const [key, value] of params.entries()) {
      raw[key] = value;
    }
    return { ok: true, raw, isFormPost: true };
  } catch {
    return { ok: false };
  }
}

export const publicFeedbackRouter = new Hono<AppEnv>()
  .get("/privacy", (c) => {
    return c.html(renderFeedbackPrivacyPage(), HTTP_OK);
  })
  .get("/:publicId/privacy", async (c) => {
    const rawPublicId = c.req.param("publicId");
    const parsedPublicId = FeedbackPublicIdSchema.safeParse(rawPublicId);
    if (!parsedPublicId.success) {
      return respondPublicNotFound(c);
    }
    const orgId = await findFormByPublicId(c.env.DB, parsedPublicId.data);
    if (!orgId) {
      return respondPublicNotFound(c);
    }
    const store = new D1FeedbackStore({ db: c.env.DB, orgId });
    const form = await store.getFormByPublicId(parsedPublicId.data, {
      signal: c.req.raw.signal,
    });
    if (!form?.enabled) {
      return respondPublicNotFound(c);
    }
    c.set("feedbackAllowedOrigins", form.allowedOrigins);
    return c.html(renderFeedbackPrivacyPage(form), HTTP_OK);
  })
  .get("/:publicId", async (c) => {
    const rawPublicId = c.req.param("publicId");
    const parsedPublicId = FeedbackPublicIdSchema.safeParse(rawPublicId);
    if (!parsedPublicId.success) {
      return respondPublicNotFound(c);
    }

    const orgId = await findFormByPublicId(c.env.DB, parsedPublicId.data);
    if (!orgId) {
      return respondPublicNotFound(c);
    }

    const store = new D1FeedbackStore({ db: c.env.DB, orgId });
    const form = await store.getFormByPublicId(parsedPublicId.data, {
      signal: c.req.raw.signal,
    });
    if (!form?.enabled) {
      return respondPublicNotFound(c);
    }

    c.set("feedbackAllowedOrigins", form.allowedOrigins);

    const embed = isEmbedParam(c.req.query("embed"));
    const rawPageUrl = c.req.query("pageUrl") ?? c.req.query("url");
    const parsedPageUrl =
      rawPageUrl !== undefined ? FeedbackPageUrlSchema.safeParse(rawPageUrl.trim()) : undefined;

    return c.html(
      renderPublicFeedbackPage(form, {
        embed,
        ...(parsedPageUrl?.success ? { pageUrl: parsedPageUrl.data } : {}),
      }),
      HTTP_OK,
    );
  })
  .post("/:publicId", async (c) => {
    const rawPublicId = c.req.param("publicId");
    const parsedPublicId = FeedbackPublicIdSchema.safeParse(rawPublicId);
    if (!parsedPublicId.success) {
      return respondPublicNotFound(c);
    }

    const orgId = await findFormByPublicId(c.env.DB, parsedPublicId.data);
    if (!orgId) {
      return respondPublicNotFound(c);
    }

    const feedbackStore = new D1FeedbackStore({ db: c.env.DB, orgId });
    let storage = c.get("storage");
    if (!c.get("customStorageFactory")) {
      storage = withRealtimeBroadcast(
        new D1Storage({ db: c.env.DB, bucket: c.env.ATTACHMENTS, orgId }),
        (event) => publishRealtimeEvent(c.env, event, orgId),
      );
    }

    const form = await feedbackStore.getFormByPublicId(parsedPublicId.data, {
      signal: c.req.raw.signal,
    });
    if (!form?.enabled) {
      return respondPublicNotFound(c);
    }

    c.set("feedbackAllowedOrigins", form.allowedOrigins);

    const parsedBody = await parsePublicSubmissionBody(c);
    if (!parsedBody.ok) {
      return c.json(
        { error: "validation_error", message: "Invalid submission body" },
        HTTP_BAD_REQUEST,
      );
    }

    const raw = parsedBody.raw;
    const embed =
      isEmbedParam(c.req.query("embed")) || isEmbedParam(asOptionalString(raw.embed));
    const rawQueryPageUrl = c.req.query("pageUrl") ?? c.req.query("url");
    const submissionCandidate = normalizeRawSubmissionPayload(raw, rawQueryPageUrl);

    let submission: FeedbackSubmission;
    try {
      submission = validateFeedbackSubmissionForForm(form, submissionCandidate);
    } catch (err) {
      if (err instanceof ValidationError) {
        if (!parsedBody.isFormPost || isJsonRequest(c)) {
          return c.json(
            {
              error: "validation_error",
              message: err.message,
              details: err.issues,
            },
            HTTP_BAD_REQUEST,
          );
        }
        return c.html(
          renderPublicFeedbackPage(form, {
            embed,
            errorMessage: err.message,
            values: {
              title: asOptionalString(submissionCandidate.title),
              body: asOptionalString(submissionCandidate.body),
              category: asOptionalString(submissionCandidate.category),
              submitterName: asOptionalString(submissionCandidate.submitterName),
              submitterEmail: asOptionalString(submissionCandidate.submitterEmail),
            },
          }),
          HTTP_BAD_REQUEST,
        );
      }
      throw err;
    }

    // Abuse and spam protection hook before task creation (#BIT-178)
    const abuseResult = await runFeedbackAbuseChecks({
      c,
      form,
      submission,
      rawBody: raw,
      feedbackStore,
    });

    if (abuseResult.status === "drop") {
      if (!parsedBody.isFormPost && isJsonRequest(c)) {
        return c.json(
          {
            ok: true,
            status: "submitted",
            thankYouText: form.thankYouText,
            message: form.thankYouText,
          },
          HTTP_OK,
        );
      }
      return c.html(renderFeedbackThankYouPage(form, { embed }), HTTP_OK);
    }

    if (abuseResult.status === "reject") {
      const status = abuseResult.httpStatus ?? HTTP_BAD_REQUEST;
      const message = abuseResult.message ?? "Could not process feedback submission.";
      if (!parsedBody.isFormPost || isJsonRequest(c)) {
        return c.json({ error: "submission_rejected", message }, status);
      }
      return c.html(
        renderPublicFeedbackPage(form, {
          embed,
          errorMessage: message,
          values: {
            title: submission.title,
            body: submission.body,
            category: submission.category,
            submitterName: submission.submitterName,
            submitterEmail: submission.submitterEmail,
          },
        }),
        status,
      );
    }

    const taskInput = taskFromFeedbackSubmission(form, submission);
    const actor = feedbackTaskActor(form);
    const task = await storage.saveTask(taskInput, {
      actor,
      signal: c.req.raw.signal,
    });

    const userAgent = c.req.header("user-agent")?.trim();
    const entry = await feedbackStore.createEntry(
      {
        taskId: task.id,
        formId: form.id,
        outcome: "pending",
        ...(submission.category !== undefined ? { category: submission.category } : {}),
        ...(submission.submitterEmail !== undefined
          ? { submitterEmail: submission.submitterEmail }
          : {}),
        ...(submission.submitterName !== undefined
          ? { submitterName: submission.submitterName }
          : {}),
        ...(submission.pageUrl !== undefined ? { pageUrl: submission.pageUrl } : {}),
        ...(abuseResult.ipHash !== undefined ? { ipHash: abuseResult.ipHash } : {}),
        ...(abuseResult.bodyHash !== undefined ? { bodyHash: abuseResult.bodyHash } : {}),
        ...(userAgent !== undefined && userAgent.length > 0 ? { userAgent } : {}),
        spamScore: abuseResult.spamScore ?? spamScore(submission, form),
      },
      { signal: c.req.raw.signal },
    );

    await feedbackStore.recordFormSubmission(form.id, {
      signal: c.req.raw.signal,
    });

    if (!parsedBody.isFormPost && isJsonRequest(c)) {
      return c.json(
        {
          ok: true,
          status: "submitted",
          thankYouText: form.thankYouText,
          message: form.thankYouText,
          taskId: task.id,
          entryId: entry.id,
        },
        HTTP_OK,
      );
    }

    return c.html(renderFeedbackThankYouPage(form, { embed }), HTTP_OK);
  });

export const projectFeedbackFormsRouter = new Hono<AppEnv>()
  .get("/:id/feedback-forms", async (c) => {
    assertFeedbackRole(c, "viewer");
    const projectId = c.req.param("id");
    if (!IdSchema.safeParse(projectId).success) {
      throw new NotFoundError("project", projectId);
    }
    const project = await c.get("storage").getProject(projectId);
    if (!project) {
      throw new NotFoundError("project", projectId);
    }
    const store = createScopedFeedbackStore(c);
    const forms = await store.listFormsByProject(project.id, {
      signal: c.req.raw.signal,
    });
    const pendingCounts = await store.getPendingCountsByFormIds(
      forms.map((form) => form.id),
      { signal: c.req.raw.signal },
    );
    return c.json(
      forms.map((form) =>
        formatFeedbackFormResponse(c, form, pendingCounts.get(form.id) ?? 0),
      ),
    );
  })
  .post(
    "/:id/feedback-forms",
    zValidator("json", CreateProjectFeedbackFormBodySchema, (result, c) => {
      if (!result.success) {
        return c.json(
          { error: "validation_error", details: result.error.issues },
          HTTP_BAD_REQUEST,
        );
      }
      return undefined;
    }),
    async (c) => {
      assertFeedbackRole(c, "editor");
      const projectId = c.req.param("id");
      if (!IdSchema.safeParse(projectId).success) {
        throw new NotFoundError("project", projectId);
      }
      const project = await c.get("storage").getProject(projectId);
      if (!project) {
        throw new NotFoundError("project", projectId);
      }
      const input = c.req.valid("json");
      const actor = resolveFeedbackActor(c);
      const store = createScopedFeedbackStore(c);
      const created = await store.createForm(
        {
          ...input,
          projectId: project.id,
        },
        {
          signal: c.req.raw.signal,
          ...(actor !== undefined ? { actor } : {}),
        },
      );
      return c.json(formatFeedbackFormResponse(c, created, 0), HTTP_CREATED);
    },
  );

export const feedbackFormsRouter = new Hono<AppEnv>()
  .get("/", async (c) => {
    assertFeedbackRole(c, "viewer");
    const projectId = c.req.query("projectId")?.trim();
    if (projectId !== undefined && projectId !== "") {
      if (!IdSchema.safeParse(projectId).success) {
        throw new NotFoundError("project", projectId);
      }
      const project = await c.get("storage").getProject(projectId);
      if (!project) {
        throw new NotFoundError("project", projectId);
      }
    }
    const store = createScopedFeedbackStore(c);
    const forms = await store.listForms(
      projectId !== undefined && projectId !== "" ? { projectId } : undefined,
      { signal: c.req.raw.signal },
    );
    const pendingCounts = await store.getPendingCountsByFormIds(
      forms.map((form) => form.id),
      { signal: c.req.raw.signal },
    );
    return c.json(
      forms.map((form) =>
        formatFeedbackFormResponse(c, form, pendingCounts.get(form.id) ?? 0),
      ),
    );
  })
  .post(
    "/",
    zValidator("json", CreateFeedbackFormInputSchema.omit({ orgId: true }), (result, c) => {
      if (!result.success) {
        return c.json(
          { error: "validation_error", details: result.error.issues },
          HTTP_BAD_REQUEST,
        );
      }
      return undefined;
    }),
    async (c) => {
      assertFeedbackRole(c, "editor");
      const input = c.req.valid("json");
      const project = await c.get("storage").getProject(input.projectId);
      if (!project) {
        throw new NotFoundError("project", input.projectId);
      }
      const actor = resolveFeedbackActor(c);
      const store = createScopedFeedbackStore(c);
      const created = await store.createForm(
        {
          ...input,
          projectId: project.id,
        },
        {
          signal: c.req.raw.signal,
          ...(actor !== undefined ? { actor } : {}),
        },
      );
      return c.json(formatFeedbackFormResponse(c, created, 0), HTTP_CREATED);
    },
  )
  .get("/:id", async (c) => {
    assertFeedbackRole(c, "viewer");
    const id = c.req.param("id");
    if (!IdSchema.safeParse(id).success) {
      return c.json({ error: "not_found" }, HTTP_NOT_FOUND);
    }
    const store = createScopedFeedbackStore(c);
    const form = await store.getForm(id, { signal: c.req.raw.signal });
    if (!form) {
      return c.json({ error: "not_found" }, HTTP_NOT_FOUND);
    }
    const pendingCount = await store.getPendingCount(form.id, {
      signal: c.req.raw.signal,
    });
    return c.json(formatFeedbackFormResponse(c, form, pendingCount));
  })
  .patch(
    "/:id",
    zValidator("json", UpdateFeedbackFormInputSchema, (result, c) => {
      if (!result.success) {
        return c.json(
          { error: "validation_error", details: result.error.issues },
          HTTP_BAD_REQUEST,
        );
      }
      return undefined;
    }),
    async (c) => {
      assertFeedbackRole(c, "editor");
      const id = c.req.param("id");
      if (!IdSchema.safeParse(id).success) {
        throw new NotFoundError("feedback_form", id);
      }
      const store = createScopedFeedbackStore(c);
      const updated = await store.updateForm(id, c.req.valid("json"), {
        signal: c.req.raw.signal,
      });
      const pendingCount = await store.getPendingCount(updated.id, {
        signal: c.req.raw.signal,
      });
      return c.json(formatFeedbackFormResponse(c, updated, pendingCount));
    },
  )
  .delete("/:id", async (c) => {
    assertFeedbackRole(c, "editor");
    const id = c.req.param("id");
    if (!IdSchema.safeParse(id).success) {
      throw new NotFoundError("feedback_form", id);
    }
    const store = createScopedFeedbackStore(c);
    await store.deleteForm(id, { signal: c.req.raw.signal });
    return c.body(null, HTTP_NO_CONTENT);
  })
  .post("/:id/rotate", async (c) => {
    assertFeedbackRole(c, "editor");
    const id = c.req.param("id");
    if (!IdSchema.safeParse(id).success) {
      throw new NotFoundError("feedback_form", id);
    }
    const store = createScopedFeedbackStore(c);
    const rotated = await store.rotatePublicId(id, {
      signal: c.req.raw.signal,
    });
    const pendingCount = await store.getPendingCount(rotated.id, {
      signal: c.req.raw.signal,
    });
    return c.json(formatFeedbackFormResponse(c, rotated, pendingCount));
  });

export const feedbackRouter = new Hono<AppEnv>()
  .route("/projects", projectFeedbackFormsRouter)
  .route("/feedback-forms", feedbackFormsRouter);

