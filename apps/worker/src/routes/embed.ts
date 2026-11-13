import type { Context } from "hono";
import { FEEDBACK_PUBLIC_ID_PATTERN } from "@bitig/core";
import type { AppEnv } from "../index";

// ---------------------------------------------------------------------------
// Embeddable Feedback widget served at GET /embed.js (#BIT-182)
//
// Usage on a host page:
//   <script src="https://<bitig-host>/embed.js" data-form="<publicId>" async></script>
//
// The script adds one floating button (and its panel) to the host page. The panel
// hosts an iframe for /f/<publicId>?embed=1, which reports its height via postMessage.
// The Bitig origin is derived from the script's own `src`, so no configuration is needed.
// ---------------------------------------------------------------------------

export const EMBED_SCRIPT_PATH = "/embed.js";
export const EMBED_SCRIPT_CONTENT_TYPE = "text/javascript; charset=utf-8";
export const EMBED_SCRIPT_CACHE_CONTROL = "public, max-age=300";
export const EMBED_SCRIPT_CORP_VALUE = "cross-origin";
export const EMBED_CROSS_ORIGIN_RESOURCE_POLICY_HEADER = "Cross-Origin-Resource-Policy";
export const EMBED_RESIZE_MESSAGE_TYPE = "bitig:feedback:resize";
export const EMBED_DATA_FORM_ATTRIBUTE = "data-form";
export const EMBED_LABEL = "Feedback";
const EMBED_PANEL_TITLE = "Send feedback";

const EMBED_DEFAULT_HEIGHT_PX = 600;
const EMBED_MIN_HEIGHT_PX = 160;
const EMBED_MAX_HEIGHT_PX = 4000;
const EMBED_VIEWPORT_RESERVE_PX = 110;
const EMBED_PANEL_WIDTH_PX = 400;
const EMBED_EDGE_OFFSET_PX = 16;
const EMBED_BUTTON_OFFSET_PX = 72;
const EMBED_Z_INDEX = 2147483000;
const EMBED_ROOT_ID = "bitig-feedback-widget";
const EMBED_STYLE_ID = "bitig-feedback-widget-style";
const EMBED_PANEL_ID = "bitig-feedback-panel";
const EMBED_ERROR_PREFIX = "[bitig] embed.js:";

/**
 * Builds the widget script. Constants are interpolated as JSON so the script stays valid
 * whatever they hold. The widget only trusts resize messages from its own iframe (checked by
 * `event.source`) sent from the Bitig origin (checked by `event.origin`).
 */
export function buildEmbedWidgetScript(): string {
  const publicIdPattern = FEEDBACK_PUBLIC_ID_PATTERN.source;
  return `(function () {
  "use strict";
  var ROOT_ID = ${JSON.stringify(EMBED_ROOT_ID)};
  var STYLE_ID = ${JSON.stringify(EMBED_STYLE_ID)};
  var PANEL_ID = ${JSON.stringify(EMBED_PANEL_ID)};
  var DATA_FORM_ATTRIBUTE = ${JSON.stringify(EMBED_DATA_FORM_ATTRIBUTE)};
  var PUBLIC_ID_PATTERN = new RegExp(${JSON.stringify(publicIdPattern)});
  var RESIZE_MESSAGE_TYPE = ${JSON.stringify(EMBED_RESIZE_MESSAGE_TYPE)};
  var LABEL = ${JSON.stringify(EMBED_LABEL)};
  var PANEL_TITLE = ${JSON.stringify(EMBED_PANEL_TITLE)};
  var ERROR_PREFIX = ${JSON.stringify(EMBED_ERROR_PREFIX)};
  var DEFAULT_HEIGHT_PX = ${String(EMBED_DEFAULT_HEIGHT_PX)};
  var MIN_HEIGHT_PX = ${String(EMBED_MIN_HEIGHT_PX)};
  var MAX_HEIGHT_PX = ${String(EMBED_MAX_HEIGHT_PX)};

  var script = document.currentScript;
  if (!script || !script.src) {
    console.error(ERROR_PREFIX + " must be loaded with a src attribute");
    return;
  }
  var publicId = script.getAttribute(DATA_FORM_ATTRIBUTE);
  if (!publicId || !PUBLIC_ID_PATTERN.test(publicId)) {
    console.error(ERROR_PREFIX + " " + DATA_FORM_ATTRIBUTE + " is missing or not a valid form id");
    return;
  }
  if (document.getElementById(ROOT_ID)) return;

  var bitigOrigin = new URL(script.src).origin;

  // Host page URL without query and fragment, so tokens or other sensitive values in the URL are not sent.
  function currentPageUrl() {
    var url = window.location.origin + window.location.pathname;
    return /^https?:\\/\\//.test(url) ? url : "";
  }

  function formUrl() {
    var base = bitigOrigin + "/f/" + encodeURIComponent(publicId) + "?embed=1";
    var pageUrl = currentPageUrl();
    return pageUrl ? base + "&pageUrl=" + encodeURIComponent(pageUrl) : base;
  }

  var style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = [
    ".bitig-fb { position: fixed; right: ${String(EMBED_EDGE_OFFSET_PX)}px; bottom: ${String(EMBED_EDGE_OFFSET_PX)}px; z-index: ${String(EMBED_Z_INDEX)}; font-family: system-ui, -apple-system, 'Segoe UI', sans-serif; }",
    ".bitig-fb-button { all: initial; box-sizing: border-box; cursor: pointer; padding: 10px 16px; border-radius: 999px; background: #1f2937; color: #ffffff; font: 600 14px/1 system-ui, -apple-system, 'Segoe UI', sans-serif; box-shadow: 0 4px 16px rgba(0, 0, 0, 0.2); }",
    ".bitig-fb-button:focus-visible { outline: 2px solid #2563eb; outline-offset: 2px; }",
    ".bitig-fb-panel { position: absolute; right: 0; bottom: ${String(EMBED_BUTTON_OFFSET_PX)}px; width: min(${String(EMBED_PANEL_WIDTH_PX)}px, calc(100vw - ${String(EMBED_EDGE_OFFSET_PX * 2)}px)); overflow: hidden; border-radius: 12px; background: #ffffff; box-shadow: 0 8px 32px rgba(0, 0, 0, 0.25); }",
    ".bitig-fb-header { display: flex; align-items: center; justify-content: space-between; padding: 8px 12px; border-bottom: 1px solid #e5e7eb; font: 600 13px/1.2 system-ui, -apple-system, 'Segoe UI', sans-serif; color: #111827; }",
    ".bitig-fb-close { all: initial; cursor: pointer; padding: 2px 6px; font: 600 18px/1 system-ui, sans-serif; color: #4b5563; }",
    ".bitig-fb-close:focus-visible { outline: 2px solid #2563eb; outline-offset: 2px; }",
    ".bitig-fb-frame { display: block; box-sizing: border-box; width: 100%; border: 0; max-height: calc(100vh - ${String(EMBED_VIEWPORT_RESERVE_PX)}px); background: #ffffff; }"
  ].join("\\n");
  (document.head || document.documentElement).appendChild(style);

  var root = document.createElement("div");
  root.id = ROOT_ID;
  root.className = "bitig-fb";

  var panel = document.createElement("div");
  panel.id = PANEL_ID;
  panel.className = "bitig-fb-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", PANEL_TITLE);
  panel.hidden = true;

  var header = document.createElement("div");
  header.className = "bitig-fb-header";
  var heading = document.createElement("span");
  heading.textContent = PANEL_TITLE;
  var closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "bitig-fb-close";
  closeButton.setAttribute("aria-label", "Close feedback");
  closeButton.textContent = "\\u00d7";
  header.appendChild(heading);
  header.appendChild(closeButton);
  panel.appendChild(header);

  var button = document.createElement("button");
  button.type = "button";
  button.className = "bitig-fb-button";
  button.textContent = LABEL;
  button.setAttribute("aria-expanded", "false");
  button.setAttribute("aria-controls", PANEL_ID);

  var frame = null;
  var frameHeightPx = DEFAULT_HEIGHT_PX;

  // The iframe is created on first open so the host page does not load the form until it is used.
  function ensureFrame() {
    if (frame) return;
    frame = document.createElement("iframe");
    frame.className = "bitig-fb-frame";
    frame.title = PANEL_TITLE;
    frame.src = formUrl();
    frame.style.height = frameHeightPx + "px";
    panel.appendChild(frame);
  }

  // Focus moves to the close button on open so Escape (handled on the panel) works straight away.
  function setOpen(open) {
    if (open) ensureFrame();
    panel.hidden = !open;
    button.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) closeButton.focus();
  }

  button.addEventListener("click", function () {
    setOpen(panel.hidden);
  });
  closeButton.addEventListener("click", function () {
    setOpen(false);
    button.focus();
  });
  panel.addEventListener("keydown", function (event) {
    if (event.key === "Escape") {
      setOpen(false);
      button.focus();
    }
  });

  window.addEventListener("message", function (event) {
    if (event.origin !== bitigOrigin || !frame || event.source !== frame.contentWindow) return;
    var data = event.data;
    if (!data || typeof data !== "object") return;
    if (data.type !== RESIZE_MESSAGE_TYPE || data.publicId !== publicId) return;
    if (typeof data.height !== "number" || !isFinite(data.height)) return;
    frameHeightPx = Math.min(Math.max(Math.ceil(data.height), MIN_HEIGHT_PX), MAX_HEIGHT_PX);
    frame.style.height = frameHeightPx + "px";
  });

  root.appendChild(panel);
  root.appendChild(button);

  function mount() {
    document.body.appendChild(root);
  }
  if (document.body) {
    mount();
  } else {
    document.addEventListener("DOMContentLoaded", mount);
  }
})();
`;
}

/** Handler for GET /embed.js: serves the widget script with the cacheable JavaScript headers. */
export function serveEmbedScript(c: Context<AppEnv>): Response {
  c.header("Content-Type", EMBED_SCRIPT_CONTENT_TYPE);
  c.header("Cache-Control", EMBED_SCRIPT_CACHE_CONTROL);
  return c.body(buildEmbedWidgetScript());
}

/**
 * Lets other origins load the script. Hono's default `Cross-Origin-Resource-Policy: same-origin`
 * would block `<script src>` on host pages. Must be registered before `secureHeaders`, which sets
 * its headers after the handler, so this override is applied last.
 */
export function applyEmbedScriptResourcePolicy(c: Pick<Context<AppEnv>, "res">): void {
  c.res.headers.set(EMBED_CROSS_ORIGIN_RESOURCE_POLICY_HEADER, EMBED_SCRIPT_CORP_VALUE);
}
