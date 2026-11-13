import { describe, expect, it } from "vitest";
import { createTestRuntime } from "../testing/fixtures";
import { DESCRIPTION_MAX } from "./constants";
import { ValidationError } from "./errors";
import {
  CreateFeedbackEntryInputSchema,
  CreateFeedbackFormInputSchema,
  DEFAULT_FEEDBACK_THANK_YOU_TEXT,
  FEEDBACK_CATEGORIES_MAX_COUNT,
  FEEDBACK_ENTRY_OUTCOMES,
  FEEDBACK_SPAM_SCORE_HIGH_THRESHOLD,
  FEEDBACK_SUBMISSION_BODY_MAX,
  FEEDBACK_SUBMISSION_TITLE_MAX,
  FeedbackEntryOutcomeSchema,
  FeedbackEntrySchema,
  FeedbackFormSchema,
  FeedbackSubmissionInputSchema,
  UpdateFeedbackFormInputSchema,
  applyFeedbackFormPatch,
  buildFeedbackEntry,
  buildFeedbackForm,
  cloneFeedbackEntry,
  cloneFeedbackForm,
  countFeedbackLinks,
  evaluateFeedbackSpam,
  feedbackTaskActor,
  isFeedbackIpHashBlocked,
  isHighSpamScore,
  normalizeAllowedOrigin,
  spamScore,
  taskFromFeedbackSubmission,
  validateFeedbackSubmissionForForm,
} from "./feedback";

const ORG_ID = "0192f0c8-7b4a-7c3e-8f12-3456789abcde";
const PROJECT_ID = "0192f0c8-7b4a-7c3e-9f12-3456789abcdf";
const FORM_ID = "0192f0c8-7b4a-7c3e-af12-3456789abce0";
const TASK_ID = "0192f0c8-7b4a-7c3e-bf12-3456789abce1";

describe("FeedbackForm schemas and builders", () => {
  it("applies defaults when building a feedback form", () => {
    const runtime = createTestRuntime();
    const form = buildFeedbackForm(
      {
        projectId: PROJECT_ID,
        name: "  Public Bug Report  ",
      },
      ORG_ID,
      runtime,
    );

    expect(form).toEqual({
      id: "01940000-0000-7000-8000-000000000001",
      orgId: ORG_ID,
      projectId: PROJECT_ID,
      publicId: "019400000000700080000000",
      name: "Public Bug Report",
      title: "Public Bug Report",
      intro: "",
      enabled: true,
      fields: {
        email: "optional",
        name: false,
        categories: [],
      },
      allowedOrigins: [],
      turnstile: true,
      thankYouText: DEFAULT_FEEDBACK_THANK_YOU_TEXT,
      submissionCount: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(FeedbackFormSchema.parse(form)).toEqual(form);
  });

  it("validates fields toggles, categories (max 10), allowedOrigins, defaultLabels, defaultPriority, and accentColor", () => {
    const runtime = createTestRuntime();
    const form = buildFeedbackForm(
      {
        projectId: PROJECT_ID,
        name: "Widget Feedback",
        title: "Send us feedback",
        intro: "Tell us what is working or broken.\r\nPlain text only.",
        enabled: false,
        fields: {
          email: "required",
          name: true,
          categories: ["Bug", "Feature request", "Question"],
          bannedWords: ["Crypto", "CASINO"],
          blockedIpHashes: ["ABCDEF0123456789"],
        },
        allowedOrigins: ["https://example.com/", "http://localhost:3000"],
        turnstile: false,
        defaultLabels: ["triage", "customer"],
        defaultPriority: "high",
        thankYouText: "Thanks! We read every submission.",
        accentColor: "#2563EB",
        bannedWords: ["Viagra"],
        blockedIpHashes: ["FEDCBA9876543210"],
        createdBy: "Emre",
      },
      ORG_ID,
      runtime,
    );

    expect(form.title).toBe("Send us feedback");
    expect(form.intro).toBe("Tell us what is working or broken.\nPlain text only.");
    expect(form.enabled).toBe(false);
    expect(form.fields).toEqual({
      email: "required",
      name: true,
      categories: ["Bug", "Feature request", "Question"],
      bannedWords: ["crypto", "casino"],
      blockedIpHashes: ["abcdef0123456789", "fedcba9876543210"],
    });
    expect(form.allowedOrigins).toEqual(["https://example.com", "http://localhost:3000"]);
    expect(form.turnstile).toBe(false);
    expect(form.defaultLabels).toEqual(["triage", "customer"]);
    expect(form.defaultPriority).toBe("high");
    expect(form.accentColor).toBe("#2563eb");
    expect(form.bannedWords).toEqual(["viagra"]);
    expect(form.blockedIpHashes).toEqual(["abcdef0123456789", "fedcba9876543210"]);
    expect(isFeedbackIpHashBlocked(form, "FEDCBA9876543210")).toBe(true);
    expect(isFeedbackIpHashBlocked(form, "abcdef0123456789")).toBe(true);
    expect(isFeedbackIpHashBlocked(form, "0000111122223333")).toBe(false);
    expect(form.createdBy).toBe("Emre");
  });

  it("rejects more than 10 category options or duplicate categories", () => {
    const elevenCategories = Array.from(
      { length: FEEDBACK_CATEGORIES_MAX_COUNT + 1 },
      (_, i) => `Cat ${String(i)}`,
    );
    expect(
      CreateFeedbackFormInputSchema.safeParse({
        projectId: PROJECT_ID,
        name: "Form",
        fields: { categories: elevenCategories },
      }).success,
    ).toBe(false);

    expect(
      CreateFeedbackFormInputSchema.safeParse({
        projectId: PROJECT_ID,
        name: "Form",
        fields: { categories: ["Bug", "bug"] },
      }).success,
    ).toBe(false);
  });

  it("validates allowedOrigins and rejects paths, queries, non-http protocols, or duplicates", () => {
    expect(normalizeAllowedOrigin("https://bitig.dev/")).toBe("https://bitig.dev");
    expect(normalizeAllowedOrigin("https://bitig.dev/path")).toBeNull();
    expect(normalizeAllowedOrigin("https://bitig.dev?a=1")).toBeNull();
    expect(normalizeAllowedOrigin("javascript:alert(1)")).toBeNull();
    expect(normalizeAllowedOrigin("https://user:pass@bitig.dev")).toBeNull();

    expect(
      CreateFeedbackFormInputSchema.safeParse({
        projectId: PROJECT_ID,
        name: "Form",
        allowedOrigins: ["https://bitig.dev", "https://bitig.dev/"],
      }).success,
    ).toBe(false);
  });

  it("validates accent colour hex codes", () => {
    expect(
      CreateFeedbackFormInputSchema.safeParse({
        projectId: PROJECT_ID,
        name: "Form",
        accentColor: "#fff",
      }).success,
    ).toBe(true);
    expect(
      CreateFeedbackFormInputSchema.safeParse({
        projectId: PROJECT_ID,
        name: "Form",
        accentColor: "red",
      }).success,
    ).toBe(false);
  });

  it("applies form patches and clears nullable optional fields", () => {
    const runtime = createTestRuntime();
    const form = buildFeedbackForm(
      {
        projectId: PROJECT_ID,
        name: "Initial",
        defaultLabels: ["triage"],
        defaultPriority: "low",
        accentColor: "#112233",
        bannedWords: ["spam"],
        blockedIpHashes: ["0123456789abcdef"],
      },
      ORG_ID,
      runtime,
    );

    const updated = applyFeedbackFormPatch(
      form,
      {
        title: "Updated Title",
        enabled: false,
        turnstile: false,
        defaultLabels: null,
        defaultPriority: null,
        accentColor: null,
        bannedWords: null,
        blockedIpHashes: null,
      },
      runtime.clock(),
    );

    expect(updated.title).toBe("Updated Title");
    expect(updated.enabled).toBe(false);
    expect(updated.turnstile).toBe(false);
    expect("defaultLabels" in updated).toBe(false);
    expect("defaultPriority" in updated).toBe(false);
    expect("accentColor" in updated).toBe(false);
    expect("bannedWords" in updated).toBe(false);
    expect("blockedIpHashes" in updated).toBe(false);

    const cloned = cloneFeedbackForm(form);
    expect(cloned).toEqual(form);
    expect(cloned.fields.categories).not.toBe(form.fields.categories);

    expect(UpdateFeedbackFormInputSchema.safeParse({}).success).toBe(false);
  });
});

describe("FeedbackEntry schemas and outcomes", () => {
  it("supports all 5 entry outcomes: pending, approved, rejected, spam, merged", () => {
    expect(FEEDBACK_ENTRY_OUTCOMES).toEqual([
      "pending",
      "approved",
      "rejected",
      "spam",
      "merged",
    ]);
    for (const outcome of FEEDBACK_ENTRY_OUTCOMES) {
      expect(FeedbackEntryOutcomeSchema.parse(outcome)).toBe(outcome);
    }
    expect(FeedbackEntryOutcomeSchema.safeParse("archived").success).toBe(false);
  });

  it("builds a FeedbackEntry and truncates long user-agent strings to 300 chars", () => {
    const runtime = createTestRuntime();
    const entry = buildFeedbackEntry(
      {
        taskId: TASK_ID,
        formId: FORM_ID,
        orgId: ORG_ID,
        projectId: PROJECT_ID,
        category: "Bug",
        submitterEmail: "  Visitor@Example.com ",
        submitterName: "Jane Doe",
        pageUrl: "https://example.com/pricing",
        ipHash: "hmac_ip_123",
        bodyHash: "hmac_body_456",
        userAgent: "Mozilla/5.0-".repeat(40),
        spamScore: 15,
      },
      runtime,
    );

    expect(entry.outcome).toBe("pending");
    expect(entry.submitterEmail).toBe("visitor@example.com");
    expect(entry.userAgent).toHaveLength(300);
    expect(FeedbackEntrySchema.parse(entry)).toEqual(entry);
    expect(cloneFeedbackEntry(entry)).toEqual(entry);

    const spamEntry = CreateFeedbackEntryInputSchema.parse({
      formId: FORM_ID,
      orgId: ORG_ID,
      projectId: PROJECT_ID,
      outcome: "spam",
      spamScore: 120,
    });
    expect(spamEntry.taskId).toBeNull();
    expect(spamEntry.outcome).toBe("spam");
  });
});

describe("FeedbackSubmissionInputSchema & form field validation", () => {
  it("enforces title max 200 chars, body max 5,000 chars, and plain-text sanitization", () => {
    const valid = FeedbackSubmissionInputSchema.parse({
      title: "  Export button\r\ndoes not respond\x00  ",
      body: "First line\r\nSecond line\x07",
      submitterEmail: "",
      submitterName: "   ",
      category: "",
      pageUrl: "",
    });

    expect(valid).toEqual({
      title: "Export button does not respond",
      body: "First line\nSecond line",
      submitterEmail: undefined,
      submitterName: undefined,
      category: undefined,
      pageUrl: undefined,
    });

    expect(
      FeedbackSubmissionInputSchema.safeParse({
        title: "x".repeat(FEEDBACK_SUBMISSION_TITLE_MAX),
        body: "y".repeat(FEEDBACK_SUBMISSION_BODY_MAX),
      }).success,
    ).toBe(true);

    expect(
      FeedbackSubmissionInputSchema.safeParse({
        title: "x".repeat(FEEDBACK_SUBMISSION_TITLE_MAX + 1),
        body: "ok",
      }).success,
    ).toBe(false);

    expect(
      FeedbackSubmissionInputSchema.safeParse({
        title: "ok",
        body: "y".repeat(FEEDBACK_SUBMISSION_BODY_MAX + 1),
      }).success,
    ).toBe(false);

    expect(
      FeedbackSubmissionInputSchema.safeParse({
        title: "   ",
        body: "ok",
      }).success,
    ).toBe(false);
  });

  it("enforces form field toggles (email off/optional/required, name, category options)", () => {
    const formRequiredEmail = {
      fields: {
        email: "required" as const,
        name: false,
        categories: ["Bug", "Idea"],
      },
    };

    expect(() =>
      validateFeedbackSubmissionForForm(formRequiredEmail, {
        title: "Crash on login",
        body: "Happens on Safari",
      }),
    ).toThrow(ValidationError);

    expect(() =>
      validateFeedbackSubmissionForForm(formRequiredEmail, {
        title: "Crash on login",
        body: "Happens on Safari",
        submitterEmail: "user@example.com",
        submitterName: "Not allowed",
      }),
    ).toThrow(ValidationError);

    expect(() =>
      validateFeedbackSubmissionForForm(formRequiredEmail, {
        title: "Crash on login",
        body: "Happens on Safari",
        submitterEmail: "user@example.com",
        category: "Unknown",
      }),
    ).toThrow(ValidationError);

    const accepted = validateFeedbackSubmissionForForm(formRequiredEmail, {
      title: "Crash on login",
      body: "Happens on Safari",
      submitterEmail: "user@example.com",
      category: "Bug",
    });
    expect(accepted.submitterEmail).toBe("user@example.com");
    expect(accepted.category).toBe("Bug");

    const formEmailOff = {
      fields: {
        email: "off" as const,
        name: true,
        categories: [],
      },
    };
    expect(() =>
      validateFeedbackSubmissionForForm(formEmailOff, {
        title: "Hello",
        body: "Details",
        submitterEmail: "user@example.com",
      }),
    ).toThrow(ValidationError);
  });
});

describe("spamScore heuristics", () => {
  it("scores clean feedback low", () => {
    const result = evaluateFeedbackSpam({
      title: "Dark mode contrast on the sidebar",
      body: "The muted labels are hard to read on OLED screens when dark mode is active.",
    });
    expect(result.score).toBe(0);
    expect(result.isSpam).toBe(false);
    expect(result.linkCount).toBe(0);
    expect(result.repeatedText).toBe(false);
    expect(result.matchedBannedWords).toEqual([]);
  });

  it("counts links and scores 3+ links as high spam", () => {
    expect(countFeedbackLinks("See https://a.com and http://b.org and www.c.net")).toBe(3);

    const oneLink = spamScore({
      title: "Docs broken link",
      body: "The link at https://docs.example.com/setup returns 404.",
    });
    expect(oneLink).toBeGreaterThan(0);
    expect(isHighSpamScore(oneLink)).toBe(false);

    const threeLinks = evaluateFeedbackSpam({
      title: "Check out https://spam1.example.com",
      body: "Visit https://spam2.example.com and www.spam3.example.com for deals!",
    });
    expect(threeLinks.linkCount).toBe(3);
    expect(threeLinks.score).toBeGreaterThanOrEqual(FEEDBACK_SPAM_SCORE_HIGH_THRESHOLD);
    expect(threeLinks.isSpam).toBe(true);
  });

  it("flags repeated text (duplicate lines, word flooding, character runs)", () => {
    const repeatedLines = evaluateFeedbackSpam({
      title: "Great offer",
      body: "Buy cheap watches now\nBuy cheap watches now\nBuy cheap watches now",
    });
    expect(repeatedLines.repeatedText).toBe(true);
    expect(repeatedLines.isSpam).toBe(true);

    const repeatedWords = evaluateFeedbackSpam({
      title: "Promo",
      body: "bonus bonus bonus bonus bonus bonus",
    });
    expect(repeatedWords.repeatedText).toBe(true);
    expect(repeatedWords.isSpam).toBe(true);

    const charRun = evaluateFeedbackSpam({
      title: "Test",
      body: "aaaaaaaaaaaaaaaaaaaa",
    });
    expect(charRun.repeatedText).toBe(true);
    expect(charRun.score).toBeGreaterThan(0);
  });

  it("scores per-form banned words as high spam", () => {
    const form = {
      bannedWords: ["crypto airdrop", "backlinks"],
    };

    const matched = evaluateFeedbackSpam(
      {
        title: "Partnership inquiry",
        body: "We sell high authority backlinks and SEO packages.",
      },
      form,
    );
    expect(matched.matchedBannedWords).toEqual(["backlinks"]);
    expect(matched.score).toBeGreaterThanOrEqual(FEEDBACK_SPAM_SCORE_HIGH_THRESHOLD);
    expect(matched.isSpam).toBe(true);

    // Substring inside a normal word should not false-positive on word-bounded banned words
    const clean = evaluateFeedbackSpam(
      {
        title: "Button alignment",
        body: "The classic layout works well.",
      },
      { bannedWords: ["ass"] },
    );
    expect(clean.matchedBannedWords).toEqual([]);
    expect(clean.isSpam).toBe(false);
  });
});

describe("taskFromFeedbackSubmission", () => {
  it("creates a pending task with feedback + form default labels, quoted body, footer, and NO submitter email", () => {
    const form = {
      projectId: PROJECT_ID,
      name: "Website Widget",
      defaultLabels: ["triage", "feedback", "ux"],
      defaultPriority: "medium" as const,
    };

    const taskInput = taskFromFeedbackSubmission(form, {
      title: "Keyboard shortcut `k` does not work in Firefox",
      body: "Steps to reproduce:\n1. Open the board\n2. Press k\n\nNothing happens.",
      category: "Bug",
      submitterEmail: "secret-visitor@example.com",
      submitterName: "Alice Visitor",
      pageUrl: "https://app.example.com/board",
    });

    expect(taskInput).toEqual({
      projectId: PROJECT_ID,
      title: "Keyboard shortcut `k` does not work in Firefox",
      description: [
        "> Steps to reproduce:",
        "> 1. Open the board",
        "> 2. Press k",
        ">",
        "> Nothing happens.",
        "",
        "- **Form:** Website Widget",
        "- **Category:** Bug",
        "- **Page URL:** https://app.example.com/board",
      ].join("\n"),
      status: "todo",
      isPublic: false,
      pendingApproval: true,
      labels: ["feedback", "triage", "ux"],
      priority: "medium",
    });

    expect(taskInput.description).not.toContain("secret-visitor@example.com");
    expect(taskInput.description).not.toContain("Alice Visitor");
    expect(feedbackTaskActor(form)).toBe("feedback:Website Widget");
  });

  it("omits optional footer lines when category and pageUrl are absent", () => {
    const taskInput = taskFromFeedbackSubmission(
      {
        projectId: PROJECT_ID,
        name: "Public Link",
      },
      {
        title: "Add CSV export",
        body: "Would love to export tasks as CSV.",
      },
    );

    expect(taskInput.description).toBe(
      "> Would love to export tasks as CSV.\n\n- **Form:** Public Link",
    );
    expect(taskInput.labels).toEqual(["feedback"]);
    expect(taskInput.pendingApproval).toBe(true);
    expect("priority" in taskInput).toBe(false);
  });

  it("respects DESCRIPTION_MAX if quoted lines approach the task description limit", () => {
    const manyNewlines = "\n".repeat(FEEDBACK_SUBMISSION_BODY_MAX - 2);
    const body = `a${manyNewlines}b`;
    const taskInput = taskFromFeedbackSubmission(
      {
        projectId: PROJECT_ID,
        name: "Public Link",
      },
      {
        title: "Long multiline body",
        body,
      },
    );
    expect(taskInput.description?.length).toBeLessThanOrEqual(DESCRIPTION_MAX);
    expect(taskInput.description).toContain("- **Form:** Public Link");
  });
});
