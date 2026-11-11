import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useCallback } from "react";
import { describe, expect, it } from "vitest";
import { isNearBottom, STICK_TO_BOTTOM_THRESHOLD_PX, useStickToBottom } from "./useStickToBottom";

const ROW_HEIGHT_PX = 100;
const VIEWPORT_HEIGHT_PX = 300;

/** jsdom has no layout, so give the scroller a scrollHeight derived from its row count. */
function fakeLayout(el: HTMLElement) {
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => VIEWPORT_HEIGHT_PX });
  Object.defineProperty(el, "scrollHeight", {
    configurable: true,
    get: () => el.children.length * ROW_HEIGHT_PX,
  });
  let top = 0;
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => top,
    set: (value: number) => {
      top = Math.max(0, Math.min(value, el.scrollHeight - el.clientHeight));
    },
  });
}

function Thread({ rows }: { readonly rows: number }) {
  const { attach: attachScroller, scrollToBottom } = useStickToBottom<HTMLDivElement>();
  // Must stay stable like the real hook's ref: a new callback each render would re-attach.
  const attach = useCallback(
    (el: HTMLDivElement | null) => {
      if (el) fakeLayout(el);
      return attachScroller(el);
    },
    [attachScroller],
  );
  return (
    <>
      <div
        data-testid="scroller"
        ref={attach}
      >
        {Array.from({ length: rows }, (_, i) => (
          <p key={i}>row {i}</p>
        ))}
      </div>
      <button type="button" onClick={scrollToBottom}>
        bottom
      </button>
    </>
  );
}

function scroller() {
  return screen.getByTestId("scroller");
}

function scrollTo(top: number) {
  const el = scroller();
  el.scrollTop = top;
  fireEvent.scroll(el);
}

describe("isNearBottom", () => {
  it("is true within the threshold and false beyond it", () => {
    expect(isNearBottom({ scrollHeight: 1000, clientHeight: 300, scrollTop: 700 })).toBe(true);
    expect(
      isNearBottom({ scrollHeight: 1000, clientHeight: 300, scrollTop: 700 - STICK_TO_BOTTOM_THRESHOLD_PX }),
    ).toBe(true);
    expect(
      isNearBottom({ scrollHeight: 1000, clientHeight: 300, scrollTop: 699 - STICK_TO_BOTTOM_THRESHOLD_PX }),
    ).toBe(false);
  });
});

describe("useStickToBottom", () => {
  it("opens scrolled to the newest content", () => {
    render(<Thread rows={10} />);
    expect(scroller().scrollTop).toBe(700);
  });

  it("follows new content while the reader is at the bottom", async () => {
    const { rerender } = render(<Thread rows={10} />);
    rerender(<Thread rows={12} />);
    await waitFor(() => {
      expect(scroller().scrollTop).toBe(900);
    });
  });

  it("stops following after the reader scrolls up, and resumes when they return", async () => {
    const { rerender } = render(<Thread rows={10} />);
    scrollTo(100);

    rerender(<Thread rows={12} />);
    // Give the MutationObserver a chance to run; the position must not jump.
    await act(async () => {
      await Promise.resolve();
    });
    expect(scroller().scrollTop).toBe(100);

    scrollTo(900);
    rerender(<Thread rows={14} />);
    await waitFor(() => {
      expect(scroller().scrollTop).toBe(1100);
    });
  });

  it("scrollToBottom jumps down and re-enables following", async () => {
    const { rerender } = render(<Thread rows={10} />);
    scrollTo(0);
    fireEvent.click(screen.getByRole("button", { name: "bottom" }));
    expect(scroller().scrollTop).toBe(700);

    rerender(<Thread rows={11} />);
    await waitFor(() => {
      expect(scroller().scrollTop).toBe(800);
    });
  });
});
