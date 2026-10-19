import type { AnchorHTMLAttributes, MouseEvent } from "react";
import { navigate } from "./router";

interface LinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  readonly href: string;
}

const PRIMARY_BUTTON = 0;

/** An in-app link: a plain left click navigates without reloading; modified clicks keep browser behavior. */
export function Link({ href, onClick, children, ...rest }: LinkProps) {
  function handleClick(event: MouseEvent<HTMLAnchorElement>) {
    onClick?.(event);
    if (
      event.defaultPrevented ||
      event.button !== PRIMARY_BUTTON ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }
    event.preventDefault();
    navigate(href);
  }

  return (
    <a href={href} onClick={handleClick} {...rest}>
      {children}
    </a>
  );
}
