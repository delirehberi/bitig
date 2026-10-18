import { describe, expect, it } from "vitest";
import {
  FrontmatterError,
  parseFrontmatter,
  parseYamlMapping,
  stringifyFrontmatter,
  stringifyYamlMapping,
} from "./frontmatter";

const NO_QUOTES: ReadonlySet<string> = new Set();

describe("parseYamlMapping", () => {
  it("keeps ISO dates as strings (YAML 1.2 core schema)", () => {
    expect(parseYamlMapping("due: 2026-10-20\nat: 2026-10-08T13:00:00.000Z\n")).toEqual({
      due: "2026-10-20",
      at: "2026-10-08T13:00:00.000Z",
    });
  });

  it("treats an empty document as an empty mapping", () => {
    expect(parseYamlMapping("")).toEqual({});
  });

  it("strips a byte order mark", () => {
    expect(parseYamlMapping("\uFEFFname: x\n")).toEqual({ name: "x" });
  });

  it.each([
    ["a sequence", "- a\n- b\n"],
    ["a scalar", "hello\n"],
  ])("rejects %s", (_label, text) => {
    expect(() => parseYamlMapping(text)).toThrow(FrontmatterError);
  });

  it("rejects malformed YAML", () => {
    expect(() => parseYamlMapping("a: [unclosed\n")).toThrow(/invalid YAML/);
  });

  it("rejects duplicate keys", () => {
    expect(() => parseYamlMapping("a: 1\na: 2\n")).toThrow(FrontmatterError);
  });

  it("rejects aliases (entity expansion)", () => {
    expect(() => parseYamlMapping("a: &x [1, 2]\nb: *x\n")).toThrow();
  });
});

describe("stringifyYamlMapping", () => {
  it("double-quotes the requested keys only", () => {
    const text = stringifyYamlMapping({ due: "2026-10-20", name: "plain" }, new Set(["due"]));
    expect(text).toBe('due: "2026-10-20"\nname: plain\n');
  });

  it("does not fold long lines", () => {
    const long = "word ".repeat(60).trim();
    expect(stringifyYamlMapping({ long }, NO_QUOTES)).toBe(`long: ${long}\n`);
  });
});

describe("frontmatter documents", () => {
  it.each([
    ["empty body", ""],
    ["single line", "Details"],
    ["leading newline", "\nstarts blank"],
    ["trailing newline", "ends blank\n"],
    ["markdown with fences", "# Title\n\n---\n\n```yaml\n---\n```"],
    ["unicode", "Görev açıklaması 🚀"],
  ])("round-trips the body verbatim: %s", (_label, body) => {
    const text = stringifyFrontmatter({ title: "T" }, body, NO_QUOTES);
    expect(parseFrontmatter(text)).toEqual({ data: { title: "T" }, body });
  });

  it("ends non-empty files with exactly one newline", () => {
    expect(stringifyFrontmatter({ title: "T" }, "Body", NO_QUOTES)).toBe("---\ntitle: T\n---\nBody\n");
    expect(stringifyFrontmatter({ title: "T" }, "", NO_QUOTES)).toBe("---\ntitle: T\n---\n");
  });

  it("accepts CRLF line endings and the ... end marker", () => {
    expect(parseFrontmatter("---\r\ntitle: T\r\n...\r\nBody\r\n")).toEqual({
      data: { title: "T" },
      body: "Body\r",
    });
  });

  it("rejects a file without an opening fence", () => {
    expect(() => parseFrontmatter("title: T\n")).toThrow(/must start with/);
  });

  it("rejects a file without a closing fence", () => {
    expect(() => parseFrontmatter("---\ntitle: T\n")).toThrow(/closing/);
  });
});

