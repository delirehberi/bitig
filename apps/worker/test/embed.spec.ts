import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { buildEmbedWidgetScript, EMBED_RESIZE_MESSAGE_TYPE } from "../src/routes/embed";

const BASE_URL = "https://bitig.test";

function request(path: string, init?: RequestInit): Promise<Response> {
  return exports.default.fetch(new Request(`${BASE_URL}${path}`, init));
}

describe("GET /embed.js (#BIT-182)", () => {
  it("serves the widget as cacheable JavaScript that other origins can load", async () => {
    const res = await request("/embed.js");

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    // Overrides the secureHeaders default of same-origin, which would block cross-origin <script src>.
    expect(res.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.text()).toBe(buildEmbedWidgetScript());
  });

  it("is served without an API session and does not set cookies", async () => {
    const res = await request("/embed.js");

    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toBeNull();
  });
});

describe("buildEmbedWidgetScript (#BIT-182)", () => {
  const script = buildEmbedWidgetScript();

  it("reads the form id from data-form and validates it against the shared public-id pattern", () => {
    expect(script).toContain('DATA_FORM_ATTRIBUTE = "data-form"');
    expect(script).toContain('script.getAttribute(DATA_FORM_ATTRIBUTE)');
    expect(script).toContain('new RegExp("^[A-Za-z0-9_-]{16,64}$")');
  });

  it("derives the Bitig origin from the script src and opens /f/<id>?embed=1 with the host page URL", () => {
    expect(script).toContain("new URL(script.src).origin");
    expect(script).toContain('"/f/" + encodeURIComponent(publicId) + "?embed=1"');
    expect(script).toContain('"&pageUrl=" + encodeURIComponent(pageUrl)');
  });

  it("strips query and fragment from the host page URL before sending it", () => {
    expect(script).toContain("window.location.origin + window.location.pathname");
  });

  it("only applies resize messages from its own iframe, the Bitig origin, and its form id", () => {
    expect(script).toContain("event.origin !== bitigOrigin");
    expect(script).toContain("event.source !== frame.contentWindow");
    expect(script).toContain("data.publicId !== publicId");
    expect(script).toContain(`"${EMBED_RESIZE_MESSAGE_TYPE}"`);
  });

  it("clamps the reported height between the minimum and maximum", () => {
    expect(script).toContain("Math.min(Math.max(Math.ceil(data.height), MIN_HEIGHT_PX), MAX_HEIGHT_PX)");
  });

  it("guards against double mounting and a missing data-form", () => {
    expect(script).toContain("document.getElementById(ROOT_ID)");
    expect(script).toContain("is missing or not a valid form id");
  });

  it("waits for document.body when the async script runs before the body is parsed", () => {
    expect(script).toContain('document.addEventListener("DOMContentLoaded", mount)');
  });
});
