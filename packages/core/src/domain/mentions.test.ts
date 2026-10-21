import { describe, expect, it } from "vitest";
import { extractTaskMentions, taskMentions } from "./mentions";

function codes(text: string): string[] {
  return extractTaskMentions(text).map((mention) => mention.code);
}

describe("extractTaskMentions", () => {
  it("finds a mention at the start and end of the text", () => {
    expect(extractTaskMentions("#BIT-1 blocks #OPS-20")).toEqual([
      { code: "BIT-1", key: "BIT", number: 1, ranges: [{ start: 0, end: 6 }] },
      { code: "OPS-20", key: "OPS", number: 20, ranges: [{ start: 14, end: 21 }] },
    ]);
  });

  it("finds a mention that is the whole text", () => {
    expect(codes("#BIT-85")).toEqual(["BIT-85"]);
  });

  it.each([
    ["(#BIT-62)", 1],
    ["See #BIT-62.", 4],
    ["#BIT-62, then more", 0],
    ["**#BIT-62**", 2],
    ["- [ ] #BIT-62: do it", 6],
    ["#BIT-62!", 0],
    ["'#BIT-62'", 1],
    ["line one\n#BIT-62\n", 9],
  ])("finds the mention in %j", (text, start) => {
    expect(extractTaskMentions(text)).toEqual([
      { code: "BIT-62", key: "BIT", number: 62, ranges: [{ start, end: start + 7 }] },
    ]);
  });

  it("drops zero padding and merges padded and plain codes", () => {
    expect(extractTaskMentions("#BIT-01 and #BIT-1 and #BIT-001")).toEqual([
      {
        code: "BIT-1",
        key: "BIT",
        number: 1,
        ranges: [
          { start: 0, end: 7 },
          { start: 12, end: 18 },
          { start: 23, end: 31 },
        ],
      },
    ]);
  });

  it("lists distinct codes in order of first appearance", () => {
    expect(codes("#B2-3 #AB-1 #B2-3 #AB-2")).toEqual(["B2-3", "AB-1", "AB-2"]);
  });

  it.each([
    "UTF-8",
    "ISO-9001",
    "BIT-12 without a hash",
    "#bit-12 in lower case",
    "#Bit-12 in mixed case",
    "#B-1 has a one-letter key",
    "#1BIT-2 starts with a digit",
    "#ABCDEFGHIJK-1 has an eleven-letter key",
    "#BIT-0 is not a number a task can have",
    "#BIT- has no number",
    "#BIT-12a runs into letters",
    "#BIT-12_x runs into an underscore",
    "#BIT-12-rc1 runs into a suffix",
    "issue#BIT-12 follows a word",
    "&#BIT-12 follows an ampersand",
    "##BIT-12 follows another hash",
  ])("ignores %j", (text) => {
    expect(extractTaskMentions(text)).toEqual([]);
  });

  it("allows a trailing hyphen that does not start a word", () => {
    expect(codes("#BIT-12- next")).toEqual(["BIT-12"]);
  });

  it("skips inline code spans", () => {
    expect(codes("Use `#BIT-1` or ``a ` #BIT-2`` but #BIT-3")).toEqual(["BIT-3"]);
  });

  it("treats an unclosed backtick as literal text", () => {
    expect(codes("a ` stray #BIT-4")).toEqual(["BIT-4"]);
  });

  it("only closes a code span with a run of the same length", () => {
    expect(codes("``#BIT-1 ` #BIT-2`` #BIT-3")).toEqual(["BIT-3"]);
  });

  it("skips fenced code blocks", () => {
    const text = ["#BIT-1", "```ts", "// #BIT-2", "```", "~~~~", "#BIT-3", "~~~", "~~~~", "#BIT-4"].join("\n");
    expect(codes(text)).toEqual(["BIT-1", "BIT-4"]);
  });

  it("skips an unclosed fenced code block to the end", () => {
    expect(codes("#BIT-1\n```\n#BIT-2\n")).toEqual(["BIT-1"]);
  });

  it("does not let backticks inside a fence open a code span", () => {
    expect(codes("```\n`\n```\n#BIT-1 ` #BIT-2")).toEqual(["BIT-1", "BIT-2"]);
  });

  it.each([
    "https://example.com/tasks#BIT-1",
    "https://example.com/#BIT-1",
    "https://example.com/?q=#BIT-1",
    "<https://example.com/#BIT-1>",
    "www.example.com/#BIT-1",
    "[a link](/tasks/#BIT-1)",
    "[a link](https://example.com/#BIT-1 \"title\")",
    "![an image](img.png#BIT-1)",
  ])("skips mentions inside the URL %j", (text) => {
    expect(extractTaskMentions(text)).toEqual([]);
  });

  it("keeps a mention in link text and after a URL", () => {
    expect(codes("[#BIT-1](https://example.com) https://example.com #BIT-2")).toEqual(["BIT-1", "BIT-2"]);
  });

  it("returns nothing for empty text", () => {
    expect(extractTaskMentions("")).toEqual([]);
  });
});

describe("taskMentions", () => {
  it("collects mentions from the description and every checklist item without duplicates", () => {
    expect(
      taskMentions({
        description: "Needs #BIT-2 and #OPS-1",
        checklist: [
          { text: "Wait for #BIT-02", done: false },
          { text: "Then #BIT-3", done: true },
        ],
      }),
    ).toEqual(["BIT-2", "OPS-1", "BIT-3"]);
  });

  it("leaves out the task's own code, padded or not", () => {
    expect(
      taskMentions({
        code: "BIT-85",
        description: "#BIT-85 is this task, #BIT-085 too, #BIT-86 is next",
        checklist: [{ text: "#BIT-85", done: false }],
      }),
    ).toEqual(["BIT-86"]);
  });

  it("works without a checklist or a code", () => {
    expect(taskMentions({ description: "#BIT-1" })).toEqual(["BIT-1"]);
    expect(taskMentions({ description: "" })).toEqual([]);
  });
});
