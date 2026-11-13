# Feedback forms

A feedback form lets people outside your team send feedback into a project. Each submission becomes a task
in **Awaiting approval** (`pendingApproval: true`). A project member approves it, and it then becomes a normal
backlog task. Rejected and spam submissions are kept only for a short retention period (see Privacy and retention).

## Create a form

1. Open the project and go to the **Feedback** tab.
2. Create a form. Set its name, the title shown to submitters, which fields to ask for (email, name, categories),
   whether Turnstile applies, and the allowed origins (see below).
3. Copy the public link, the iframe snippet, or the `embed.js` snippet from the same tab.

Forms can also be managed through the REST API, for example `POST /api/projects/:projectId/feedback-forms`.

## Ways to publish a form

Replace `https://bitig.example.com` with your Bitig host and `<publicId>` with the form's public ID.

### Direct link

```text
https://bitig.example.com/f/<publicId>
```

The privacy note for the form is at `https://bitig.example.com/f/<publicId>/privacy`.

### Iframe

Use the iframe when you want to place the form inline. Set the height to match the content, or use the
Feedback tab's snippet, which includes a small script that resizes the iframe from the form's `postMessage`.

```html
<iframe src="https://bitig.example.com/f/<publicId>?embed=1"
  title="Send feedback"
  loading="lazy"
  style="width: 100%; height: 600px; border: 0;"></iframe>
```

The `embed=1` flag selects the chrome-free layout for embedded use.

### Floating button (`embed.js`)

Add one script tag to the host page. It adds a floating **Feedback** button in the bottom-right corner. Clicking it
opens the form in a panel.

```html
<script src="https://bitig.example.com/embed.js" data-form="<publicId>" async></script>
```

What the script does on the host page:

- Adds one button and one panel, both inside a single `div#bitig-feedback-widget` with its own styles. It does not
  change other elements on the page.
- Loads the form in an iframe the first time the panel opens.
- Passes the host page URL to the form as `pageUrl`, without its query string or fragment, so tokens in the URL are
  not sent.
- Resizes the panel from the form's height messages. Only messages from its own iframe and the Bitig origin are used.
- Closes with the close button or the Escape key.

The Bitig origin is taken from the script's own `src`, so no other configuration is needed.

## Allowed origins

Allowed origins are the host sites that may show the form in an iframe.

- The browser only lets listed origins frame `/f/<publicId>`. Other sites are blocked by `frame-ancestors`.
- The form is served with `X-Frame-Options` removed, and the allowed origins replace the default `frame-ancestors 'none'`.
  A form with no allowed origins cannot be embedded.
- Enter origins as scheme plus host, for example `https://www.example.com`. Paths, user info and query strings are rejected.

The direct link does not depend on allowed origins. Submissions from the embedded form are accepted because the form
runs on the Bitig host. Submissions from any other origin must come from one of the allowed origins.

## Turnstile

Turnstile is Cloudflare's bot challenge. It is optional and set per form.

1. Create a Turnstile widget in the Cloudflare dashboard and add your Bitig host to its hostnames.
2. Set the site key in `apps/worker/wrangler.jsonc` under `vars.TURNSTILE_SITE_KEY`.
3. Store the secret key as a Worker secret, never in the repository:

   ```text
   pnpm --filter @bitig/worker exec wrangler secret put TURNSTILE_SECRET_KEY
   ```

4. Enable Turnstile on the form.

If the secret key is empty, server-side verification is skipped even for forms that enable Turnstile. Submissions
are then checked only by the other abuse controls below.

## Abuse protection

Submissions pass these checks before a task is created:

- A honeypot field. Submissions that fill it are dropped silently.
- A signed form timestamp. Submissions must take at least 3 seconds and at most 2 hours to fill in.
- Rate limits per IP and form: 5 submissions per 10 minutes and 60 per hour.
- A duplicate check that drops repeats within 24 hours.
- A spam score. High-score submissions are recorded as spam and do not create a task.
- A cap of 500 pending submissions per form. New submissions are refused while the cap is reached.

Members can block and unblock an IP hash for a form through the feedback forms API.

## Privacy and retention

- Submitter IP addresses are never stored in plain text. They are stored as an HMAC keyed by `FEEDBACK_IP_SECRET`,
  or by a key derived from `SESSION_SECRET` when `FEEDBACK_IP_SECRET` is not set.
- A submission keeps the fields the form asks for, the page URL it was sent from, and the timestamp.
- Pending submissions stay in Awaiting approval until a member approves, rejects or marks them as spam.
- Rejected and spam submissions are deleted after 30 days by the daily scheduled cleanup (03:00 UTC).
- Approved submissions become normal tasks and are kept with the project.
- The privacy note for each form is served at `/f/<publicId>/privacy`.

## Verify a form end to end

1. Submit the public link.
2. Open the project. The submission appears in **Awaiting approval**.
3. Approve it. It moves to the backlog as a normal task, and its feedback entry shows the outcome as approved.

The automated version of these steps is the `end to end` test in `apps/worker/test/feedback.spec.ts`.
