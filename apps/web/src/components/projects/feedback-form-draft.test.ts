import type { FeedbackFormSummary } from "@bitig/api-client";
import { describe, expect, it } from "vitest";
import {
  draftToCreateInput,
  draftToUpdatePatch,
  emptyFeedbackFormDraft,
  feedbackFormDraftFrom,
} from "./feedback-form-draft";

const TIMESTAMP = "2026-01-01T00:00:00.000Z";

const FORM: FeedbackFormSummary = {
  id: "01940000-0000-7000-8000-000000000005",
  orgId: "01940000-0000-7000-8000-000000000009",
  projectId: "01940000-0000-7000-8000-000000000001",
  publicId: "abcdefghijklmnopqrstu",
  name: "Bug reports",
  title: "Report a bug",
  intro: "Tell us what broke.",
  enabled: true,
  fields: {
    email: "required",
    name: true,
    categories: ["Bug", "Idea"],
    bannedWords: ["spamword"],
    blockedIpHashes: ["abc123"],
  },
  allowedOrigins: ["https://example.com"],
  turnstile: false,
  defaultLabels: ["feedback", "web"],
  defaultPriority: "high",
  thankYouText: "Thanks!",
  accentColor: "#2563eb",
  submissionCount: 3,
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
  publicPath: "/f/abcdefghijklmnopqrstu",
  publicUrl: "https://bitig.example/f/abcdefghijklmnopqrstu",
  publicLink: "https://bitig.example/f/abcdefghijklmnopqrstu",
  pendingCount: 1,
};

describe("feedbackFormDraftFrom", () => {
  it("fills the draft from an existing form, joining lists into lines and labels into commas", () => {
    const draft = feedbackFormDraftFrom(FORM);
    expect(draft.categoriesText).toBe("Bug\nIdea");
    expect(draft.allowedOriginsText).toBe("https://example.com");
    expect(draft.labelsText).toBe("feedback, web");
    expect(draft.defaultPriority).toBe("high");
    expect(draft.accentColor).toBe("#2563eb");
    expect(draft.emailMode).toBe("required");
  });

  it("starts an empty form with the server defaults", () => {
    const draft = emptyFeedbackFormDraft();
    expect(draft.enabled).toBe(true);
    expect(draft.turnstile).toBe(true);
    expect(draft.emailMode).toBe("optional");
    expect(draft.defaultPriority).toBe("");
  });
});

describe("draftToCreateInput", () => {
  it("omits empty optional values so the server applies its defaults", () => {
    const body = draftToCreateInput({ ...emptyFeedbackFormDraft(), name: "  Bug reports  " });
    expect(body).toEqual({
      name: "Bug reports",
      intro: "",
      enabled: true,
      fields: { email: "optional", name: false, categories: [] },
      allowedOrigins: [],
      turnstile: true,
      thankYouText: "Thank you for your feedback.",
    });
    expect(body).not.toHaveProperty("title");
    expect(body).not.toHaveProperty("defaultLabels");
    expect(body).not.toHaveProperty("defaultPriority");
    expect(body).not.toHaveProperty("accentColor");
  });

  it("parses lines and comma-separated labels, dropping blanks", () => {
    const body = draftToCreateInput({
      ...emptyFeedbackFormDraft(),
      name: "Ideas",
      categoriesText: " Bug \n\n Idea \n",
      allowedOriginsText: "https://a.example\n  \nhttps://b.example",
      labelsText: "feedback,  , web ",
      defaultPriority: "urgent",
      accentColor: " #fff ",
    });
    expect(body.fields?.categories).toEqual(["Bug", "Idea"]);
    expect(body.allowedOrigins).toEqual(["https://a.example", "https://b.example"]);
    expect(body.defaultLabels).toEqual(["feedback", "web"]);
    expect(body.defaultPriority).toBe("urgent");
    expect(body.accentColor).toBe("#fff");
  });
});

describe("draftToUpdatePatch", () => {
  it("keeps banned words and blocked IP hashes, which the editor does not change", () => {
    const patch = draftToUpdatePatch(feedbackFormDraftFrom(FORM), FORM);
    expect(patch.fields).toEqual({
      email: "required",
      name: true,
      categories: ["Bug", "Idea"],
      bannedWords: ["spamword"],
      blockedIpHashes: ["abc123"],
    });
  });

  it("sends cleared optional fields as null", () => {
    const patch = draftToUpdatePatch(
      { ...feedbackFormDraftFrom(FORM), labelsText: "", defaultPriority: "", accentColor: "" },
      FORM,
    );
    expect(patch.defaultLabels).toBeNull();
    expect(patch.defaultPriority).toBeNull();
    expect(patch.accentColor).toBeNull();
  });

  it("keeps the existing title when the title is cleared", () => {
    const patch = draftToUpdatePatch({ ...feedbackFormDraftFrom(FORM), title: "   " }, FORM);
    expect(patch.title).toBe(FORM.title);
  });
});
