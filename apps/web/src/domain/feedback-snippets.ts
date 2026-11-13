/**
 * Embed snippets for a feedback form's public page. The page posts `bitig:feedback:resize` messages with its
 * height (see the Worker's embed script), and the script snippet applies them to the matching iframe.
 */

export const FEEDBACK_EMBED_QUERY = "embed=1";
export const FEEDBACK_RESIZE_MESSAGE_TYPE = "bitig:feedback:resize";
export const FEEDBACK_IFRAME_DEFAULT_HEIGHT_PX = 600;
const FEEDBACK_IFRAME_DATA_ATTRIBUTE = "data-bitig-feedback";

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtmlAttribute(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
}

export interface FeedbackSnippetForm {
  readonly publicUrl: string;
  readonly publicId: string;
  readonly name: string;
}

/** An iframe that embeds the form. The `?embed=1` flag gives the chrome-free embed layout. */
export function buildFeedbackIframeSnippet(form: FeedbackSnippetForm): string {
  const src = escapeHtmlAttribute(`${form.publicUrl}?${FEEDBACK_EMBED_QUERY}`);
  const title = escapeHtmlAttribute(form.name);
  const publicId = escapeHtmlAttribute(form.publicId);
  return [
    `<iframe src="${src}"`,
    `  title="${title}"`,
    `  ${FEEDBACK_IFRAME_DATA_ATTRIBUTE}="${publicId}"`,
    `  loading="lazy"`,
    `  style="width: 100%; height: ${String(FEEDBACK_IFRAME_DEFAULT_HEIGHT_PX)}px; border: 0;"></iframe>`,
  ].join("\n");
}

/**
 * A script that sizes the iframe for the form to the height its page reports. The public id is
 * JSON-encoded, so the script stays valid whatever the id holds.
 */
export function buildFeedbackScriptSnippet(form: Pick<FeedbackSnippetForm, "publicId">): string {
  const publicId = JSON.stringify(form.publicId);
  return `<script>
(function () {
  window.addEventListener("message", function (event) {
    var data = event.data;
    if (!data || data.type !== ${JSON.stringify(FEEDBACK_RESIZE_MESSAGE_TYPE)} || data.publicId !== ${publicId}) return;
    if (typeof data.height !== "number" || !isFinite(data.height) || data.height < 0) return;
    var frames = document.querySelectorAll("iframe[${FEEDBACK_IFRAME_DATA_ATTRIBUTE}]");
    for (var i = 0; i < frames.length; i++) {
      if (frames[i].getAttribute("${FEEDBACK_IFRAME_DATA_ATTRIBUTE}") === ${publicId} && frames[i].contentWindow === event.source) {
        frames[i].style.height = data.height + "px";
      }
    }
  });
})();
</script>`;
}
