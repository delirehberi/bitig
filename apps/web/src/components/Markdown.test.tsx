import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Markdown } from "./Markdown";

describe("Markdown", () => {
  it("renders headings, lists, blockquotes, code blocks, and inline formatting", () => {
    const sample = [
      "## Overview",
      "",
      "**Finding:** Check `src/index.ts` and *verify* the output.",
      "",
      "- First item",
      "- Second item",
      "",
      "1. Step one",
      "2. Step two",
      "",
      "> Quoted note",
      "",
      "```ts",
      "const ok = true;",
      "```",
    ].join("\n");

    render(<Markdown content={sample} />);

    expect(screen.getByRole("heading", { level: 2, name: "Overview" })).toBeInTheDocument();
    expect(screen.getByText("Finding:")).toHaveProperty("tagName", "STRONG");
    expect(screen.getByText("src/index.ts")).toHaveProperty("tagName", "CODE");
    expect(screen.getByText("verify")).toHaveProperty("tagName", "EM");
    expect(screen.getByText("First item")).toBeInTheDocument();
    expect(screen.getByText("Step two")).toBeInTheDocument();
    expect(screen.getByText("Quoted note")).toBeInTheDocument();
    expect(screen.getByText("const ok = true;")).toHaveProperty("tagName", "CODE");
  });

  it("renders safe http(s) links and refuses unsafe schemes", () => {
    render(
      <Markdown
        content="Visit [Docs](https://example.com/docs) or [Bad](javascript:alert(1))"
      />,
    );

    const safeLink = screen.getByRole("link", { name: "Docs" });
    expect(safeLink).toHaveAttribute("href", "https://example.com/docs");
    expect(safeLink).toHaveAttribute("target", "_blank");
    expect(safeLink).toHaveAttribute("rel", "noopener noreferrer");

    expect(screen.queryByRole("link", { name: "Bad" })).not.toBeInTheDocument();
    expect(screen.getByText(/\[Bad\]\(javascript:alert\(1\)\)/)).toBeInTheDocument();
  });
});

