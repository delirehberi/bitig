import { describe, expect, it, vi } from "vitest";
import {
  CloudflareEmailMailer,
  ConsoleMailer,
  FakeMailer,
  MailerError,
  ResendMailer,
  buildAccountDeleteEmail,
  buildEmailChangeEmail,
  buildInvitationEmail,
  buildSignInCodeEmail,
  createMailer,
  parseSenderAddress,
} from "../src/mailer";

describe("Mailer and transactional email templates", () => {
  it("builds sign-in, invitation, email-change, and account-delete templates with HTML and text", () => {
    const signIn = buildSignInCodeEmail("alice@example.com", "123456");
    expect(signIn.to).toBe("alice@example.com");
    expect(signIn.subject).toContain("123456");
    expect(signIn.text).toContain("123456");
    expect(signIn.html).toContain("123456");

    const invite = buildInvitationEmail({
      to: "bob@example.com",
      organisationName: "Acme <Corp>",
      inviterName: "Alice",
      role: "editor",
      acceptUrl: "https://bitig.test/register?invite=tok123",
    });
    expect(invite.subject).toContain("Acme <Corp>");
    expect(invite.html).toContain("Acme &lt;Corp&gt;");
    expect(invite.text).toContain("https://bitig.test/register?invite=tok123");

    const emailChange = buildEmailChangeEmail("new@example.com", "654321");
    expect(emailChange.text).toContain("654321");
    expect(emailChange.html).toContain("654321");

    const accountDelete = buildAccountDeleteEmail("alice@example.com", "999888");
    expect(accountDelete.text).toContain("999888");
    expect(accountDelete.html).toContain("999888");
  });

  it("parses sender display name and email for Cloudflare Email Sending", () => {
    expect(parseSenderAddress("Bitig <noreply@emre.xyz>")).toEqual({
      name: "Bitig",
      email: "noreply@emre.xyz",
    });
    expect(parseSenderAddress("noreply@emre.xyz")).toBe("noreply@emre.xyz");
  });

  it("sends through the native Cloudflare Email Sending binding (send_email) and surfaces errors", async () => {
    const sentPayloads: EmailMessageBuilder[] = [];
    const mockBinding: SendEmail = {
      send: (msg: EmailMessage | EmailMessageBuilder) => {
        sentPayloads.push(msg as EmailMessageBuilder);
        return Promise.resolve({ messageId: "cf_msg_1" });
      },
    };

    const mailer = createMailer({
      emailBinding: mockBinding,
      mailFrom: "Bitig <noreply@emre.xyz>",
    });
    expect(mailer).toBeInstanceOf(CloudflareEmailMailer);

    await mailer.send(buildSignInCodeEmail("alice@example.com", "112233"));
    expect(sentPayloads).toHaveLength(1);
    expect(sentPayloads[0]).toMatchObject({
      from: { name: "Bitig", email: "noreply@emre.xyz" },
      to: "alice@example.com",
    });

    const failingBinding: SendEmail = {
      send: () => Promise.reject(new Error("domain not onboarded")),
    };
    const failMailer = new CloudflareEmailMailer({
      binding: failingBinding,
      from: "Bitig <noreply@emre.xyz>",
    });
    await expect(failMailer.send(buildSignInCodeEmail("alice@example.com", "112233"))).rejects.toBeInstanceOf(
      MailerError,
    );
  });

  it("records sent messages in FakeMailer and supports helpers", async () => {
    const mailer = new FakeMailer();
    await mailer.send(buildSignInCodeEmail("User@Example.com", "424242"));
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.lastTo("user@example.com")?.subject).toContain("424242");
    expect(mailer.extractLastCode("user@example.com")).toBe("424242");
    mailer.clear();
    expect(mailer.sent).toHaveLength(0);
  });

  it("sends through Resend HTTP API when configured without EMAIL binding", async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const okFetch: typeof fetch = (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      calls.push({ url, init });
      return Promise.resolve(new Response(JSON.stringify({ id: "re_123" }), { status: 200 }));
    };

    const mailer = new ResendMailer({
      apiKey: "re_secret_key",
      from: "Bitig <noreply@bitig.test>",
      fetchFn: okFetch,
    });
    await mailer.send(buildSignInCodeEmail("alice@example.com", "112233"));

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.resend.com/emails");
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer re_secret_key");
  });

  it("logs to console when neither EMAIL binding nor RESEND_API_KEY is set in local dev", async () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const mailer = createMailer({ resendApiKey: "", mailFrom: "" });
    expect(mailer).toBeInstanceOf(ConsoleMailer);
    await mailer.send(buildSignInCodeEmail("dev@example.com", "000111"));
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });
});
