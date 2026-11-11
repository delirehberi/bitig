import { useCallback, useRef } from "react";

/**
 * How close (in px) to the bottom still counts as "at the bottom". Small gaps come from
 * sub-pixel layout and from content that grows by a few px between frames.
 */
export const STICK_TO_BOTTOM_THRESHOLD_PX = 48;

export function isNearBottom(
  el: Pick<HTMLElement, "scrollHeight" | "scrollTop" | "clientHeight">,
  thresholdPx: number = STICK_TO_BOTTOM_THRESHOLD_PX,
): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= thresholdPx;
}

export interface StickToBottom<T extends HTMLElement> {
  /** Attach to the scrolling element. */
  readonly attach: (el: T | null) => (() => void) | undefined;
  /** Jump to the newest content and keep following it (e.g. after the person posts a message). */
  readonly scrollToBottom: () => void;
}

/**
 * Chat-style scrolling for a container whose newest content is at the bottom (#BIT-172):
 * it opens at the bottom, follows new content while the reader is at the bottom, and stops
 * following once they scroll up to read older content, resuming when they scroll back down.
 *
 * Content changes are detected with a MutationObserver (new messages, async-loaded comments)
 * and a ResizeObserver on the container and its children (images, markdown, collapsibles
 * changing height without a DOM mutation, and the dock resizing the viewport).
 */
export function useStickToBottom<T extends HTMLElement>(): StickToBottom<T> {
  const elementRef = useRef<T | null>(null);
  const stickRef = useRef(true);

  const scrollToBottom = useCallback(() => {
    stickRef.current = true;
    const el = elementRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  const attach = useCallback((el: T | null) => {
    elementRef.current = el;
    if (!el) return undefined;

    stickRef.current = true;
    el.scrollTop = el.scrollHeight;

    function follow() {
      if (el && stickRef.current) el.scrollTop = el.scrollHeight;
    }

    function handleScroll() {
      if (el) stickRef.current = isNearBottom(el);
    }

    el.addEventListener("scroll", handleScroll, { passive: true });

    const resizeObserver =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(follow);

    function observeChildren() {
      if (!resizeObserver || !el) return;
      resizeObserver.disconnect();
      resizeObserver.observe(el);
      for (const child of Array.from(el.children)) resizeObserver.observe(child);
    }

    observeChildren();

    const mutationObserver = new MutationObserver(() => {
      observeChildren();
      follow();
    });
    mutationObserver.observe(el, { childList: true, subtree: true, characterData: true });

    return () => {
      el.removeEventListener("scroll", handleScroll);
      mutationObserver.disconnect();
      resizeObserver?.disconnect();
      if (elementRef.current === el) elementRef.current = null;
    };
  }, []);

  return { attach, scrollToBottom };
}
