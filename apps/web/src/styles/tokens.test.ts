import indexCss from "../index.css?inline";
import tokensCss from "./tokens.css?inline";
import { describe, expect, it } from "vitest";

describe("typography tokens", () => {
  it("defines --text-2xs in tokens.css and emits the .text-2xs utility from index.css", () => {
    expect(tokensCss).toMatch(/--text-2xs:\s*0\.6875rem\s*;/);
    expect(indexCss).toContain(".text-2xs");
    expect(indexCss).toMatch(/font-size:\s*var\(--text-2xs\)/);
  });
});

