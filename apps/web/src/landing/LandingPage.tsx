import { Check, Clock, ShieldCheck, Waypoints } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "../routing/Link";
import { hrefFor } from "../routing/router";

/*
 * The public landing page served at `/`. It is static: it makes no API calls,
 * so it renders before (and without) the Worker's /health answer. Design:
 * "Bitig — Landing Page" in Figma, built on the same Hallmark tokens as the app.
 */

const REPO_URL = "https://github.com/delirehberi/bitig";
const DOCS_URL = `${REPO_URL}#readme`;
const APP_HREF = hrefFor({ name: "overview" });
const FREE_MCP_REQUESTS = 100;

const NAV_LINKS = [
  { label: "How it works", href: "#how-it-works" },
  { label: "Hosting", href: "#hosting" },
  { label: "Pricing", href: "#pricing" },
  { label: "Docs", href: DOCS_URL },
  { label: "GitHub", href: REPO_URL },
] as const;

const MOCK_TASKS = [
  { title: "Refactor storage contract tests", owner: "claude-code", state: "in_progress" },
  { title: "Fix CSRF check on /api/tasks", owner: "cursor", state: "todo" },
  { title: "Write Nostr backup docs", owner: "codex", state: "todo" },
  { title: "Review landing page copy", owner: "you", state: "todo" },
  { title: "Ship D1 migration 0004", owner: "claude-code", state: "done" },
] as const;

const TOOLS = ["Claude Code", "Cursor", "Codex", "ChatGPT", "Gemini CLI", "Your notes"] as const;

const PAINS: readonly { icon: LucideIcon; title: string; body: string }[] = [
  {
    icon: Waypoints,
    title: "Scattered",
    body: "Each tool tracks work in its own chat, file or memory. There's no single list to check.",
  },
  {
    icon: Clock,
    title: "Forgotten",
    body: "Context windows end and sessions close. Half-finished work disappears with them.",
  },
  {
    icon: ShieldCheck,
    title: "Unaccountable",
    body: "You can't tell which agent did what, what's done, or what's still waiting on you.",
  },
];

const MCP_TOOLS = ["add_task", "update_task", "complete_task", "list_tasks"] as const;

const MCP_CONFIG = `{
  "bitig": {
    "command": "bitig",
    "args": ["mcp"]
  }
}`;

const STATS = [
  { label: "Open", value: "12", tone: "text-accent-ink" },
  { label: "In progress", value: "4", tone: "text-ink" },
  { label: "Done this week", value: "27", tone: "text-ok" },
] as const;

const BACKENDS = [
  { name: "Markdown files", detail: "Plain .md on disk, local CLI and STDIO MCP" },
  { name: "Cloudflare D1", detail: "Deploy the Worker to your own account" },
  { name: "Nostr relays", detail: "Decentralised, with encrypted private tasks" },
] as const;

interface Plan {
  readonly name: string;
  readonly price: string;
  readonly note: string;
  readonly description: string;
  readonly features: readonly string[];
  readonly cta: { readonly label: string; readonly href: string; readonly external: boolean };
  readonly featured: boolean;
}

const PLANS: readonly Plan[] = [
  {
    name: "Free",
    price: "$0",
    note: "Managed",
    description: "Everything you need to try Bitig with your agents.",
    features: [`${String(FREE_MCP_REQUESTS)} MCP requests a month`, "Unlimited projects and tasks", "Web dashboard"],
    cta: { label: "Start free", href: APP_HREF, external: false },
    featured: true,
  },
  {
    name: "Self-hosted",
    price: "$0",
    note: "Forever",
    description: "Run Bitig on your own machine or Cloudflare account.",
    features: ["Unlimited MCP requests", "Markdown, D1 or Nostr storage", "Open source"],
    cta: { label: "View on GitHub", href: REPO_URL, external: true },
    featured: false,
  },
];

const FOOTER_LINKS = [
  { label: "Docs", href: DOCS_URL },
  { label: "GitHub", href: REPO_URL },
  { label: "Nostr spec", href: `${REPO_URL}/blob/master/docs/nostr-spec.md` },
  { label: "Security", href: `${REPO_URL}/blob/master/docs/security.md` },
] as const;

type ButtonVariant = "primary" | "secondary" | "ghost";

const BUTTON_BASE =
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-pill px-5 py-3 font-bold transition-colors";

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-accent-ink text-paper hover:bg-ink",
  secondary: "border border-rule-strong bg-paper text-ink hover:bg-paper-3",
  ghost: "text-ink hover:bg-paper-3",
};

interface ButtonLinkProps {
  readonly href: string;
  readonly variant: ButtonVariant;
  readonly external?: boolean;
  readonly className?: string;
  readonly children: ReactNode;
}

/** Call-to-action link styled as a button: in-app paths route without a reload. */
function ButtonLink({ href, variant, external = false, className = "", children }: ButtonLinkProps) {
  const classes = `${BUTTON_BASE} ${BUTTON_VARIANTS[variant]} ${className}`;
  if (external) {
    return (
      <a href={href} className={classes}>
        {children}
      </a>
    );
  }
  return (
    <Link href={href} className={classes}>
      {children}
    </Link>
  );
}

function Eyebrow({ children }: { readonly children: ReactNode }) {
  return <p className="text-sm font-bold uppercase tracking-[0.08em] text-accent-ink">{children}</p>;
}

function SectionHeading({
  id,
  eyebrow,
  title,
  lead,
  centered = false,
}: {
  readonly id: string;
  readonly eyebrow: string;
  readonly title: string;
  readonly lead?: string;
  readonly centered?: boolean;
}) {
  return (
    <div className={`flex flex-col gap-3.5 ${centered ? "items-center text-center" : ""}`}>
      <Eyebrow>{eyebrow}</Eyebrow>
      <h2 id={id} className="max-w-3xl text-[2rem] font-extrabold leading-tight tracking-tight md:text-[2.625rem]">
        {title}
      </h2>
      {lead && <p className="max-w-2xl text-lg leading-relaxed text-ink-2">{lead}</p>}
    </div>
  );
}

function Logo() {
  return (
    <span className="flex items-center gap-3">
      <img src="/favicon.svg" alt="" width={28} height={28} />
      <span className="font-display text-xl font-bold tracking-tight text-ink">bitig</span>
    </span>
  );
}

function ProductMock() {
  return (
    <figure
      aria-label="A Bitig task list shared by several agents"
      className="w-full max-w-[520px] rounded-lg border border-rule bg-paper-2 shadow-[0_24px_48px_-12px_rgb(89_56_31/0.12)]"
    >
      <div className="flex items-center justify-between px-5 py-4">
        <span className="font-display font-bold">bitig · Tasks</span>
        <span className="flex items-center gap-1.5 rounded-pill bg-ok-soft px-2.5 py-1 text-xs font-semibold text-ok">
          <span aria-hidden="true" className="size-[7px] rounded-full bg-ok" />3 agents connected
        </span>
      </div>
      <ul className="flex flex-col gap-1.5 px-3 pb-3">
        {MOCK_TASKS.map(({ title, owner, state }) => (
          <li
            key={title}
            className="flex items-center gap-3 rounded-md border border-rule bg-paper px-3.5 py-3"
          >
            <span
              aria-hidden="true"
              className={`size-[18px] shrink-0 rounded-[6px] ${
                state === "done"
                  ? "bg-ok"
                  : state === "in_progress"
                    ? "border-[1.5px] border-accent"
                    : "border-[1.5px] border-rule-strong"
              }`}
            />
            <span
              className={`min-w-0 flex-1 truncate text-[15px] font-semibold ${
                state === "done" ? "text-ink-3 line-through" : "text-ink"
              }`}
            >
              {title}
            </span>
            <span
              className={`rounded-pill px-2 py-0.5 font-mono text-xs font-medium ${
                owner === "you" ? "bg-paper-3 text-ink-2" : "bg-accent-soft text-accent-ink"
              }`}
            >
              {owner === "you" ? "you" : `@${owner}`}
            </span>
          </li>
        ))}
        <li className="flex flex-col gap-1 rounded-md bg-ink px-4 py-3 font-mono text-xs">
          <span className="truncate text-paper-3">→ add_task {"{"} title: "Fix CSRF check", project: "bitig" {"}"}</span>
          <span className="text-accent-soft">✓ created by cursor · 0.2s</span>
        </li>
      </ul>
    </figure>
  );
}

function CheckList({ items }: { readonly items: readonly string[] }) {
  return (
    <ul className="flex flex-col gap-3">
      {items.map((item) => (
        <li key={item} className="flex items-start gap-2.5 text-ink-2">
          <Check size={18} strokeWidth={2.5} aria-hidden="true" className="mt-0.5 shrink-0 text-ok" />
          {item}
        </li>
      ))}
    </ul>
  );
}

const CONTAINER = "mx-auto w-full max-w-[1120px] px-5 md:px-8";
const CARD = "flex flex-col gap-3.5 rounded-lg border border-rule p-7";

export function LandingPage() {
  return (
    <div className="bg-paper text-ink">
      <header className={`${CONTAINER} flex items-center justify-between gap-6 py-5`}>
        <a href="/" aria-label="Bitig home">
          <Logo />
        </a>
        <nav aria-label="Landing" className="hidden lg:block">
          <ul className="flex items-center gap-9">
            {NAV_LINKS.map(({ label, href }) => (
              <li key={label}>
                <a href={href} className="text-[15px] font-semibold text-ink-2 hover:text-ink">
                  {label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <div className="flex items-center gap-2">
          <ButtonLink href={APP_HREF} variant="ghost" className="hidden sm:inline-flex">
            Sign in
          </ButtonLink>
          <ButtonLink href={APP_HREF} variant="primary">
            Start free
          </ButtonLink>
        </div>
      </header>

      <main>
        <section
          aria-labelledby="hero-title"
          className={`${CONTAINER} grid grid-cols-[minmax(0,1fr)] items-center gap-16 pt-12 pb-24 md:pt-18 lg:grid-cols-[minmax(0,1fr)_520px]`}
        >
          <div className="flex flex-col items-start gap-6">
            <p className="flex items-center gap-2 rounded-pill bg-accent-soft py-1.5 pr-3.5 pl-3 text-sm font-bold text-accent-ink">
              <span aria-hidden="true" className="size-2 rounded-full bg-accent" />
              AI-first task manager
            </p>
            <h1
              id="hero-title"
              className="text-[2.5rem] font-extrabold leading-[1.06] tracking-[-0.025em] md:text-[3.5rem]"
            >
              One task list for every AI you work with.
            </h1>
            <p className="max-w-xl text-xl leading-normal text-ink-2">
              You're using a lot of AI models, tools and agents. How do you keep track of all the tasks? Bitig gives
              Claude, Cursor, your CLI agents and you the same board, over MCP.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <ButtonLink href={APP_HREF} variant="primary">
                Start free: {FREE_MCP_REQUESTS} MCP requests
              </ButtonLink>
              <ButtonLink href="#hosting" variant="secondary" external>
                Self-host it
              </ButtonLink>
            </div>
            <p className="text-sm text-ink-3">
              No credit card. Open source. Your tasks stay in Markdown, D1 or Nostr.
            </p>
          </div>
          <ProductMock />
        </section>

        <section aria-labelledby="problem-title" className="bg-paper-2 py-24">
          <div className={`${CONTAINER} flex flex-col gap-12`}>
            <SectionHeading
              id="problem-title"
              eyebrow="The problem"
              title="Every agent keeps its own to-do list."
              lead="Claude Code plans in one terminal, Cursor in another, ChatGPT in a browser tab, and your own notes somewhere else. Nobody sees the whole picture, including you."
            />
            <ul aria-label="Tools" className="flex flex-wrap gap-2.5">
              {TOOLS.map((tool) => (
                <li
                  key={tool}
                  className="rounded-pill border border-rule-strong bg-paper px-3.5 py-2 font-mono text-sm font-medium text-ink-2"
                >
                  {tool}
                </li>
              ))}
            </ul>
            <ul className="grid gap-6 md:grid-cols-3">
              {PAINS.map(({ icon: Icon, title, body }) => (
                <li key={title} className={`${CARD} bg-paper`}>
                  <span className="grid size-11 place-items-center rounded-md bg-accent-soft text-accent-ink">
                    <Icon size={22} aria-hidden="true" />
                  </span>
                  <h3 className="text-xl font-bold">{title}</h3>
                  <p className="leading-relaxed text-ink-2">{body}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section id="how-it-works" aria-labelledby="how-title" className="scroll-mt-6 py-24">
          <div className={`${CONTAINER} flex flex-col gap-12`}>
            <SectionHeading
              id="how-title"
              eyebrow="How it works"
              title="One board. Every agent writes to it."
              lead="Bitig speaks the Model Context Protocol, so any MCP-capable agent can read and update your tasks. You stay in the loop from the dashboard."
            />
            <ol className="grid gap-6 md:grid-cols-3">
              <li className={`${CARD} bg-paper-2`}>
                <StepNumber n={1} />
                <h3 className="text-xl font-bold">Connect your agents</h3>
                <p className="leading-relaxed text-ink-2">
                  Add Bitig as an MCP server once. It works with Claude, Cursor, Codex and anything else that speaks
                  MCP.
                </p>
                <pre className="overflow-x-auto rounded-md bg-ink px-4 py-3.5 font-mono text-xs leading-normal text-paper-3">
                  <code>{MCP_CONFIG}</code>
                </pre>
              </li>
              <li className={`${CARD} bg-paper-2`}>
                <StepNumber n={2} />
                <h3 className="text-xl font-bold">Agents manage tasks</h3>
                <p className="leading-relaxed text-ink-2">
                  Agents create, update and close tasks themselves, scoped to the project linked in your repo's{" "}
                  <code>.bitig</code> file.
                </p>
                <ul aria-label="MCP tools" className="flex flex-wrap gap-2">
                  {MCP_TOOLS.map((tool) => (
                    <li
                      key={tool}
                      className="rounded-pill bg-accent-soft px-2.5 py-1 font-mono text-[13px] font-medium text-accent-ink"
                    >
                      {tool}
                    </li>
                  ))}
                </ul>
              </li>
              <li className={`${CARD} bg-paper-2`}>
                <StepNumber n={3} />
                <h3 className="text-xl font-bold">You glance and steer</h3>
                <p className="leading-relaxed text-ink-2">
                  Open the dashboard to see what every agent is working on, by project. Reprioritise, then get back
                  to building.
                </p>
                <dl className="flex flex-col gap-2">
                  {STATS.map(({ label, value, tone }) => (
                    <div
                      key={label}
                      className="flex items-center justify-between rounded-[12px] border border-rule bg-paper px-3.5 py-2.5"
                    >
                      <dt className="text-sm font-semibold text-ink-2">{label}</dt>
                      <dd className={`font-display text-lg font-bold tabular-nums ${tone}`}>{value}</dd>
                    </div>
                  ))}
                </dl>
              </li>
            </ol>
          </div>
        </section>

        <section aria-label="Why Bitig exists" className="pb-24 md:pt-6">
          <div className={CONTAINER}>
            <figure className="flex flex-col gap-6 rounded-lg bg-accent-soft px-8 py-12 md:px-16 md:py-14">
              <blockquote className="flex flex-col gap-6">
                <p className="font-display text-[2rem] font-extrabold leading-tight tracking-tight text-accent-ink md:text-[2.5rem]">
                  “I built it for myself, and it can be yours.”
                </p>
                <p className="max-w-3xl text-lg leading-relaxed text-ink-2">
                  I was running Claude, Cursor and a handful of CLI agents across a dozen repos, and losing track of
                  who was doing what. Bitig is the task manager I wanted: plain files when I'm local, the edge when
                  I'm not, and one MCP endpoint for every agent.
                </p>
              </blockquote>
              <figcaption className="flex items-center gap-3">
                <span
                  aria-hidden="true"
                  className="grid size-11 place-items-center rounded-full bg-accent-ink font-display text-lg font-bold text-paper"
                >
                  E
                </span>
                <span className="flex flex-col">
                  <span className="font-bold">Emre</span>
                  <span className="text-sm text-ink-3">Maker of Bitig</span>
                </span>
              </figcaption>
            </figure>
          </div>
        </section>

        <section id="hosting" aria-labelledby="hosting-title" className="scroll-mt-6 bg-paper-2 py-24">
          <div className={`${CONTAINER} flex flex-col gap-12`}>
            <SectionHeading
              id="hosting-title"
              eyebrow="Managed or self-hosted"
              title="Run it our way, or yours."
              lead="Same app, same MCP tools, same dashboard. Pick where your tasks live, and switch later. Export and backup work across every backend."
            />
            <div className="grid gap-6 md:grid-cols-2">
              <article className={`${CARD} items-start bg-paper p-8`}>
                <Tag>Managed</Tag>
                <h3 className="text-2xl font-bold tracking-tight">We run it for you</h3>
                <p className="leading-relaxed text-ink-2">
                  Sign in, copy your MCP endpoint, and your agents are connected. Hosted on Cloudflare's edge.
                </p>
                <CheckList
                  items={[
                    "Remote MCP over HTTP with a bearer token",
                    "Web dashboard included",
                    "Nothing to install or maintain",
                  ]}
                />
                <ButtonLink href={APP_HREF} variant="primary" className="mt-auto">
                  Start free
                </ButtonLink>
              </article>
              <article className={`${CARD} items-start bg-paper p-8`}>
                <Tag muted>Self-hosted</Tag>
                <h3 className="text-2xl font-bold tracking-tight">Keep it on your own machine</h3>
                <p className="leading-relaxed text-ink-2">
                  Open source and storage-agnostic. Choose the backend that fits how you work.
                </p>
                <ul className="flex w-full flex-col gap-2">
                  {BACKENDS.map(({ name, detail }) => (
                    <li
                      key={name}
                      className="flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-md border border-rule bg-paper-2 px-4 py-3"
                    >
                      <span className="text-[15px] font-bold">{name}</span>
                      <span className="text-sm text-ink-3">{detail}</span>
                    </li>
                  ))}
                </ul>
                <ButtonLink href={DOCS_URL} variant="secondary" external className="mt-auto">
                  Read the self-hosting guide
                </ButtonLink>
              </article>
            </div>
          </div>
        </section>

        <section id="pricing" aria-labelledby="pricing-title" className="scroll-mt-6 py-24">
          <div className={`${CONTAINER} flex flex-col gap-12`}>
            <SectionHeading
              id="pricing-title"
              eyebrow="Pricing"
              title="Free to start. Free forever to self-host."
              centered
            />
            <ul className="mx-auto grid w-full max-w-[760px] gap-6 md:grid-cols-2">
              {PLANS.map((plan) => (
                <li
                  key={plan.name}
                  className={`${CARD} p-8 ${plan.featured ? "border-2 border-accent bg-paper-2" : "bg-paper"}`}
                >
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="text-xl font-bold">{plan.name}</h3>
                    {plan.featured && <Tag>Most popular</Tag>}
                  </div>
                  <p className="flex items-baseline gap-2">
                    <span className="font-display text-[2.75rem] font-extrabold tracking-tight">{plan.price}</span>
                    <span className="text-sm text-ink-3">{plan.note}</span>
                  </p>
                  <p className="text-[15px] leading-relaxed text-ink-2">{plan.description}</p>
                  <hr className="border-rule" />
                  <CheckList items={plan.features} />
                  <ButtonLink
                    href={plan.cta.href}
                    external={plan.cta.external}
                    variant={plan.featured ? "primary" : "secondary"}
                    className="mt-auto w-full"
                  >
                    {plan.cta.label}
                  </ButtonLink>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section aria-labelledby="cta-title" className="pb-24">
          <div className={CONTAINER}>
            <div className="flex flex-col items-center gap-5 rounded-lg bg-ink px-8 py-16 text-center md:px-16 md:py-18">
              <h2 id="cta-title" className="text-[2rem] font-extrabold tracking-tight text-paper md:text-[2.75rem]">
                Give your agents one place to work.
              </h2>
              <p className="max-w-xl text-lg leading-relaxed text-paper-3">
                Connect your first agent in under a minute. Your first {FREE_MCP_REQUESTS} MCP requests each month
                are on us.
              </p>
              <div className="flex flex-wrap justify-center gap-3">
                <ButtonLink href={APP_HREF} variant="primary" className="hover:bg-accent">
                  Start free
                </ButtonLink>
                <ButtonLink href="#hosting" variant="secondary" external>
                  Self-host it
                </ButtonLink>
              </div>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-rule">
        <div className={`${CONTAINER} flex flex-col gap-4 pt-7 pb-10 sm:flex-row sm:items-center sm:justify-between`}>
          <p className="flex items-center gap-2.5">
            <span className="font-display text-lg font-bold tracking-tight">bitig</span>
            <span className="text-sm text-ink-3">Old Turkic for “record”.</span>
          </p>
          <nav aria-label="Footer">
            <ul className="flex flex-wrap gap-x-7 gap-y-2">
              {FOOTER_LINKS.map(({ label, href }) => (
                <li key={label}>
                  <a href={href} className="text-sm font-semibold text-ink-2 hover:text-ink">
                    {label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        </div>
      </footer>
    </div>
  );
}

function StepNumber({ n }: { readonly n: number }) {
  return (
    <span className="self-start rounded-pill bg-accent-ink px-3 py-1 font-display text-[15px] font-bold text-paper">
      {n}
    </span>
  );
}

function Tag({ muted = false, children }: { readonly muted?: boolean; readonly children: ReactNode }) {
  return (
    <span
      className={`rounded-pill px-2.5 py-1 text-xs font-bold ${
        muted ? "bg-paper-3 text-ink-2" : "bg-accent-soft text-accent-ink"
      }`}
    >
      {children}
    </span>
  );
}
