import { describe, expect, it } from "vitest";
import { MAX_WORK_QUEUE_ITEMS, parseWorkQueuePrompt, type WorkQueueProjectRef } from "./work-queue-parse";

const PROJECTS: readonly WorkQueueProjectRef[] = [
  { key: "BIT", name: "Bitig" },
  { key: "KMZ", name: "Komuz" },
];

function codes(text: string, projects: readonly WorkQueueProjectRef[] = PROJECTS): string[] {
  return parseWorkQueuePrompt(text, projects).items.map((item) => `${item.key}-${String(item.number)}`);
}

describe("parseWorkQueuePrompt: code formats", () => {
  it.each([
    ["BIT-92", "BIT-92"],
    ["bit-92", "BIT-92"],
    ["Bit 92", "BIT-92"],
    ["#BIT-92", "BIT-92"],
    ["#bit 92", "BIT-92"],
  ])("reads %j as %s", (text, expected) => {
    const result = parseWorkQueuePrompt(text, PROJECTS);
    expect(result.items.map((item) => `${item.key}-${String(item.number)}`)).toEqual([expected]);
  });

  it("drops leading zeros", () => {
    expect(parseWorkQueuePrompt("KMZ-03", PROJECTS).items).toEqual([{ key: "KMZ", number: 3, raw: "KMZ-03" }]);
  });

  it("keeps the raw text that produced the item", () => {
    expect(parseWorkQueuePrompt("start #bit-7", PROJECTS).items).toEqual([{ key: "BIT", number: 7, raw: "#bit-7" }]);
  });

  it("does not read numbers without a key", () => {
    const result = parseWorkQueuePrompt("do 12 and 13", PROJECTS);
    expect(result.items).toEqual([]);
    expect(result.unknownKeys).toEqual([]);
  });

  it("drops references to number zero with a warning", () => {
    const result = parseWorkQueuePrompt("BIT-0", PROJECTS);
    expect(result.items).toEqual([]);
    expect(result.warnings).toEqual(["Ignored BIT-0: work items are numbered from 1."]);
  });

  it("ignores digit runs too long to be a ticket number", () => {
    expect(codes("BIT-1234567890", PROJECTS)).toEqual([]);
  });
});

describe("parseWorkQueuePrompt: ranges", () => {
  it.each([
    "BIT-92 to BIT-102",
    "BIT-92..102",
    "BIT-92-102",
    "BIT-92 through 102",
    "bit 92 thru 102",
    "BIT-92 - 102",
    "BIT-92 till BIT-102",
    "BIT-92 until 102",
  ])("expands %j to 92..102", (text) => {
    const result = parseWorkQueuePrompt(text, PROJECTS);
    expect(result.items.map((item) => item.number)).toEqual([
      92, 93, 94, 95, 96, 97, 98, 99, 100, 101, 102,
    ]);
    expect(result.items.every((item) => item.key === "BIT")).toBe(true);
    expect(result.items[0]?.raw).toBe(text);
    expect(result.warnings).toEqual([]);
  });

  it("does not cross projects", () => {
    const result = parseWorkQueuePrompt("BIT-9 to KMZ-11", PROJECTS);
    expect(result.items.map((item) => `${item.key}-${String(item.number)}`)).toEqual(["BIT-9", "KMZ-11"]);
    expect(result.warnings).toEqual(["Range BIT-9 to KMZ-11 crosses projects; each code was read on its own."]);
  });

  it("reads a backwards range as its endpoints only", () => {
    const result = parseWorkQueuePrompt("BIT-10 to BIT-5", PROJECTS);
    expect(result.items.map((item) => item.number)).toEqual([10, 5]);
    expect(result.warnings).toEqual(["Range BIT-10 to BIT-5 runs backwards; only its endpoints were read."]);
  });

  it("expands a single-number range", () => {
    expect(codes("BIT-4..4", PROJECTS)).toEqual(["BIT-4"]);
  });

  it("caps a single range at the item limit and warns", () => {
    const result = parseWorkQueuePrompt("BIT-1..200", PROJECTS);
    expect(result.items).toHaveLength(MAX_WORK_QUEUE_ITEMS);
    expect(result.items.at(-1)?.number).toBe(MAX_WORK_QUEUE_ITEMS);
    expect(result.warnings).toEqual([`Range BIT-1..200 was truncated to ${String(MAX_WORK_QUEUE_ITEMS)} items.`]);
  });

  it("does not loop over huge ranges", () => {
    const result = parseWorkQueuePrompt("BIT-1..999999999", PROJECTS);
    expect(result.items).toHaveLength(MAX_WORK_QUEUE_ITEMS);
  });
});

describe("parseWorkQueuePrompt: lists", () => {
  it("reads commas, and, & and new lines", () => {
    expect(codes("BIT-1, BIT-2 and BIT-3 & KMZ-4\nBIT-5", PROJECTS)).toEqual([
      "BIT-1",
      "BIT-2",
      "BIT-3",
      "KMZ-4",
      "BIT-5",
    ]);
  });

  it("mixes ranges and single codes", () => {
    expect(codes("BIT-1 to 3, KMZ-2", PROJECTS)).toEqual(["BIT-1", "BIT-2", "BIT-3", "KMZ-2"]);
  });

  it("removes duplicates and warns once per duplicate", () => {
    const result = parseWorkQueuePrompt("BIT-1, bit-1, BIT-2 and BIT-1", PROJECTS);
    expect(result.items.map((item) => `${item.key}-${String(item.number)}`)).toEqual(["BIT-1", "BIT-2"]);
    expect(result.items[0]?.raw).toBe("BIT-1");
    expect(result.warnings).toEqual(["BIT-1 was listed more than once; kept one."]);
  });

  it("caps the total at the item limit", () => {
    const text = "BIT-1..50, KMZ-1..10";
    const result = parseWorkQueuePrompt(text, PROJECTS);
    expect(result.items).toHaveLength(MAX_WORK_QUEUE_ITEMS);
    expect(result.items.at(-1)).toEqual({ key: "BIT", number: 50, raw: "BIT-1..50" });
    expect(result.warnings).toEqual(["Kept the first 50 items; 10 dropped."]);
  });
});

describe("parseWorkQueuePrompt: exclusions", () => {
  it("removes an excluded code from a range", () => {
    expect(codes("BIT-92 to BIT-96 except BIT-94", PROJECTS)).toEqual(["BIT-92", "BIT-93", "BIT-95", "BIT-96"]);
  });

  it("supports but not", () => {
    expect(codes("BIT-1, BIT-2 but not BIT-2", PROJECTS)).toEqual(["BIT-1"]);
  });

  it("carries the exclusion across list connectors", () => {
    expect(codes("BIT-1 to BIT-5 except BIT-2 and BIT-3, BIT-4", PROJECTS)).toEqual(["BIT-1", "BIT-5"]);
  });

  it("ends the exclusion at a new line", () => {
    expect(codes("BIT-1 except BIT-2\nBIT-3", PROJECTS)).toEqual(["BIT-1", "BIT-3"]);
  });

  it("ends the exclusion at a meaningful word", () => {
    expect(codes("BIT-1 except BIT-2 urgent BIT-3", PROJECTS)).toEqual(["BIT-1", "BIT-3"]);
  });

  it("supports excluding, without, minus and other than", () => {
    expect(codes("BIT-1 to 3 excluding BIT-1", PROJECTS)).toEqual(["BIT-2", "BIT-3"]);
    expect(codes("BIT-1 to 3 without BIT-3", PROJECTS)).toEqual(["BIT-1", "BIT-2"]);
    expect(codes("BIT-1 to 3 minus BIT-2", PROJECTS)).toEqual(["BIT-1", "BIT-3"]);
    expect(codes("BIT-1, BIT-2 other than BIT-2", PROJECTS)).toEqual(["BIT-1"]);
  });

  it("warns when an excluded code was never selected", () => {
    const result = parseWorkQueuePrompt("BIT-1 except BIT-9", PROJECTS);
    expect(result.items.map((item) => `${item.key}-${String(item.number)}`)).toEqual(["BIT-1"]);
    expect(result.warnings).toEqual(["BIT-9 was excluded but was not selected."]);
  });

  it("excludes a code that was also selected before the exclusion", () => {
    expect(codes("BIT-1, BIT-2 except BIT-2", PROJECTS)).toEqual(["BIT-1"]);
  });
});

describe("parseWorkQueuePrompt: unknown keys", () => {
  it("reports unknown keys with suggestions and never substitutes them", () => {
    const result = parseWorkQueuePrompt("KOM-12", PROJECTS);
    expect(result.items).toEqual([]);
    expect(result.unknownKeys).toEqual([{ key: "KOM", suggestions: ["KMZ"] }]);
  });

  it("suggests keys by project name prefix, initials and edit distance", () => {
    const projects: readonly WorkQueueProjectRef[] = [
      { key: "KMZ", name: "Komuz" },
      { key: "WQ", name: "Work Queue" },
      { key: "BITIG", name: "Bitig Core" },
      { key: "PAYS", name: "Payments" },
    ];
    const result = parseWorkQueuePrompt("WQX-1 BITG-2 PAY-3 QQQQ-4", projects);
    expect(result.unknownKeys).toEqual([
      { key: "WQX", suggestions: ["WQ"] },
      { key: "BITG", suggestions: ["BITIG"] },
      { key: "PAY", suggestions: ["PAYS"] },
      { key: "QQQQ", suggestions: [] },
    ]);
  });

  it("limits suggestions and orders the best match first", () => {
    const projects: readonly WorkQueueProjectRef[] = [
      { key: "KMZ", name: "Komuz" },
      { key: "KOA", name: "Kosmos" },
      { key: "KOB", name: "Kolbe" },
      { key: "KOC", name: "Koncert" },
    ];
    const result = parseWorkQueuePrompt("KOM-1", projects);
    expect(result.unknownKeys).toEqual([{ key: "KOM", suggestions: ["KMZ", "KOA", "KOB"] }]);
  });

  it("reports each unknown key once", () => {
    const result = parseWorkQueuePrompt("KOM-1, KOM-2 to 4", PROJECTS);
    expect(result.unknownKeys.map((unknown) => unknown.key)).toEqual(["KOM"]);
  });

  it("treats an unknown spaced key as ordinary text", () => {
    const result = parseWorkQueuePrompt("step 3 and BIT-2", PROJECTS);
    expect(result.items.map((item) => `${item.key}-${String(item.number)}`)).toEqual(["BIT-2"]);
    expect(result.unknownKeys).toEqual([]);
    expect(result.unparsed).toEqual(["step"]);
  });

  it("returns no suggestions when there are no projects", () => {
    expect(parseWorkQueuePrompt("BIT-1", [])).toEqual({
      items: [],
      unknownKeys: [{ key: "BIT", suggestions: [] }],
      unparsed: [],
      warnings: [],
    });
  });
});

describe("parseWorkQueuePrompt: unparsed words", () => {
  it("returns leftover meaningful words", () => {
    const result = parseWorkQueuePrompt("start the login bugs in BIT-3", PROJECTS);
    expect(result.items.map((item) => `${item.key}-${String(item.number)}`)).toEqual(["BIT-3"]);
    expect(result.unparsed).toEqual(["login", "bugs"]);
  });

  it("returns nothing when every word is understood", () => {
    expect(parseWorkQueuePrompt("start BIT-1 and BIT-2", PROJECTS).unparsed).toEqual([]);
  });

  it("de-duplicates unparsed words case-insensitively", () => {
    expect(parseWorkQueuePrompt("Login login LOGIN", PROJECTS).unparsed).toEqual(["Login"]);
  });

  it("keeps an unknown bare key with no number as unparsed text", () => {
    expect(parseWorkQueuePrompt("KOM and BIT-1", PROJECTS).unparsed).toEqual(["KOM"]);
  });
});

describe("parseWorkQueuePrompt: empty input", () => {
  it("returns empty results for empty text", () => {
    expect(parseWorkQueuePrompt("", PROJECTS)).toEqual({
      items: [],
      unknownKeys: [],
      unparsed: [],
      warnings: [],
    });
  });
});
