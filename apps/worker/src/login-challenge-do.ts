import { DurableObject } from "cloudflare:workers";

export interface LoginChallengeRecord {
  readonly origin: string;
  readonly expiresAt: number;
  readonly createdAt: number;
}

/** One Durable Object per nonce makes challenge consumption atomic and replay-safe. */
export class LoginChallenge extends DurableObject<Env> {
  async issue(record: LoginChallengeRecord): Promise<void> {
    await this.ctx.storage.put("challenge", record);
    await this.ctx.storage.setAlarm(record.expiresAt);
  }

  async consume(origin: string, createdAt: number, now: number = Date.now()): Promise<boolean> {
    const record = await this.ctx.storage.get<LoginChallengeRecord>("challenge");
    if (
      record?.origin !== origin ||
      record.createdAt !== createdAt ||
      record.expiresAt <= now
    ) return false;
    await this.ctx.storage.deleteAll();
    return true;
  }

  override async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}
