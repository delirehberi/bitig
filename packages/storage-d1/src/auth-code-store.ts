import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import {
  defaultRuntimeDeps,
  normalizeEmail,
  throwIfAborted,
  type OperationOptions,
  type RuntimeDeps,
} from "@bitig/core";
import * as schema from "./schema";
import { authCodes, type AuthCodePayload, type AuthCodePurpose, type AuthCodeRecord } from "./schema";

export const DEFAULT_AUTH_CODE_TTL_MS = 10 * 60 * 1000;
export const DEFAULT_AUTH_CODE_MAX_ATTEMPTS = 5;

export interface AuthCodeInfo {
  id: string;
  email: string;
  codeHash: string;
  purpose: AuthCodePurpose;
  payload?: AuthCodePayload | undefined;
  attempts: number;
  createdAt: string;
  expiresAt: string;
  consumedAt?: string | undefined;
}

export interface IssueAuthCodeInput {
  email: string;
  codeHash: string;
  purpose?: AuthCodePurpose | undefined;
  payload?: AuthCodePayload | undefined;
  ttlMs?: number | undefined;
}

export interface VerifyAuthCodeInput {
  email: string;
  codeHash: string;
  purpose?: AuthCodePurpose | readonly AuthCodePurpose[] | undefined;
  maxAttempts?: number | undefined;
}

export type VerifyAuthCodeResult =
  | { ok: true; record: AuthCodeInfo }
  | { ok: false; reason: "invalid" | "expired" | "locked" };

function isD1Database(db: unknown): db is D1Database {
  return typeof db === "object" && db !== null && "prepare" in db && typeof db.prepare === "function";
}

function constantTimeEqualStrings(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  const len = Math.max(ab.byteLength, bb.byteLength);
  let diff = ab.byteLength ^ bb.byteLength;
  for (let i = 0; i < len; i++) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}

function recordToAuthCode(row: AuthCodeRecord): AuthCodeInfo {
  const info: AuthCodeInfo = {
    id: row.id,
    email: row.email,
    codeHash: row.codeHash,
    purpose: row.purpose,
    attempts: row.attempts,
    createdAt: new Date(row.createdAt).toISOString(),
    expiresAt: new Date(row.expiresAt).toISOString(),
  };
  if (row.payload !== null) {
    info.payload = { ...row.payload };
  }
  if (row.consumedAt !== null) {
    info.consumedAt = new Date(row.consumedAt).toISOString();
  }
  return info;
}

export class D1AuthCodeStore {
  readonly #db: DrizzleD1Database<typeof schema>;
  readonly #deps: RuntimeDeps;

  constructor(db: D1Database | DrizzleD1Database<typeof schema>, deps: RuntimeDeps = defaultRuntimeDeps) {
    this.#db = isD1Database(db) ? drizzle(db, { schema }) : db;
    this.#deps = deps;
  }

  async issue(input: IssueAuthCodeInput, opts?: OperationOptions): Promise<AuthCodeInfo> {
    throwIfAborted(opts?.signal);
    const email = normalizeEmail(input.email);
    const purpose: AuthCodePurpose = input.purpose ?? "sign_in";
    const nowMs = this.#deps.clock().getTime();
    const ttlMs = input.ttlMs ?? DEFAULT_AUTH_CODE_TTL_MS;

    // Invalidate previous unconsumed codes for this email and purpose
    await this.#db
      .update(authCodes)
      .set({ consumedAt: nowMs })
      .where(and(eq(authCodes.email, email), eq(authCodes.purpose, purpose), isNull(authCodes.consumedAt)));

    const row: AuthCodeRecord = {
      id: this.#deps.generateId(),
      email,
      codeHash: input.codeHash,
      purpose,
      payload: input.payload ? { ...input.payload } : null,
      attempts: 0,
      createdAt: nowMs,
      expiresAt: nowMs + ttlMs,
      consumedAt: null,
    };
    await this.#db.insert(authCodes).values(row);
    throwIfAborted(opts?.signal);
    return recordToAuthCode(row);
  }

  async verifyAndConsume(input: VerifyAuthCodeInput, opts?: OperationOptions): Promise<VerifyAuthCodeResult> {
    throwIfAborted(opts?.signal);
    const email = normalizeEmail(input.email);
    const maxAttempts = input.maxAttempts ?? DEFAULT_AUTH_CODE_MAX_ATTEMPTS;
    const nowMs = this.#deps.clock().getTime();

    const rows = await this.#db
      .select()
      .from(authCodes)
      .where(and(eq(authCodes.email, email), isNull(authCodes.consumedAt), gt(authCodes.expiresAt, nowMs)))
      .orderBy(desc(authCodes.createdAt))
      .all();
    throwIfAborted(opts?.signal);

    const allowedPurposes: readonly AuthCodePurpose[] | undefined =
      input.purpose === undefined
        ? undefined
        : typeof input.purpose === "string"
          ? [input.purpose]
          : input.purpose;

    const candidate = rows.find((r) => !allowedPurposes || allowedPurposes.includes(r.purpose));
    if (!candidate) {
      // Perform dummy comparison to keep timing uniform
      constantTimeEqualStrings(input.codeHash, "0000000000000000000000000000000000000000000000000000000000000000");
      return { ok: false, reason: "invalid" };
    }

    if (candidate.attempts >= maxAttempts) {
      constantTimeEqualStrings(input.codeHash, candidate.codeHash);
      return { ok: false, reason: "locked" };
    }

    const matched = constantTimeEqualStrings(candidate.codeHash, input.codeHash);
    if (!matched) {
      const nextAttempts = candidate.attempts + 1;
      await this.#db
        .update(authCodes)
        .set({ attempts: nextAttempts })
        .where(eq(authCodes.id, candidate.id));
      return { ok: false, reason: nextAttempts >= maxAttempts ? "locked" : "invalid" };
    }

    const updated = await this.#db
      .update(authCodes)
      .set({ consumedAt: nowMs, attempts: candidate.attempts + 1 })
      .where(and(eq(authCodes.id, candidate.id), isNull(authCodes.consumedAt)))
      .returning();
    const consumed = updated[0];
    if (!consumed) {
      return { ok: false, reason: "invalid" };
    }
    return { ok: true, record: recordToAuthCode(consumed) };
  }
}
