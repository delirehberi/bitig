import { describe, expect, it } from "vitest";
import {
  FEEDBACK_IFRAME_DEFAULT_HEIGHT_PX,
  buildFeedbackIframeSnippet,
  buildFeedbackScriptSnippet,
} from "./feedback-snippets";

const FORM = {
  publicUrl: "https://bitig.example/f/abcdefghijklmnopqrstu",
  publicId: "abcdefghijklmnopqrstu",
  name: "Bug reports",
};

describe("buildFeedbackIframeSnippet", () => {
  it("embeds the public page with the embed flag and a default height", () => {
    const snippet = buildFeedbackIframeSnippet(FORM);
    expect(snippet).toContain(`src="${FORM.publicUrl}?embed=1"`);
    expect(snippet).toContain(`data-bitig-feedback="${FORM.publicId}"`);
    expect(snippet).toContain(`height: ${String(FEEDBACK_IFRAME_DEFAULT_HEIGHT_PX)}px`);
    expect(snippet.startsWith("<iframe ")).toBe(true);
    expect(snippet.endsWith("</iframe>")).toBe(true);
  });

  it("escapes attribute-breaking characters in the form name", () => {
    const snippet = buildFeedbackIframeSnippet({ ...FORM, name: `"><script>alert('x')</script>` });
    expect(snippet).not.toContain("<script>");
    expect(snippet).toContain('title="&quot;&gt;&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;"');
  });
});

describe("buildFeedbackScriptSnippet", () => {
  it("wraps the resize listener in a script tag scoped to the public id", () => {
    const snippet = buildFeedbackScriptSnippet(FORM);
    expect(snippet.startsWith("<script>")).toBe(true);
    expect(snippet.endsWith("</script>")).toBe(true);
    expect(snippet).toContain(`data.publicId !== "${FORM.publicId}"`);
    expect(snippet).toContain('"bitig:feedback:resize"');
  });

  it("only applies numeric heights from the message", () => {
    const snippet = buildFeedbackScriptSnippet(FORM);
    expect(snippet).toContain('typeof data.height !== "number"');
  });
});
