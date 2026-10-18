import { BitigError } from "@bitig/core";

export class AuthError extends BitigError {
  constructor(message = "Unauthorized", options?: ErrorOptions) {
    super("STORAGE", message, options);
    this.name = "AuthError";
  }
}

