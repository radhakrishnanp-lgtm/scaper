export type FetchErrorCode = "robots" | "blocked" | "network" | "timeout" | "private" | "http" | "too_large" | "browser";

/** A fetch failure with a message written for the person using the app. */
export class FetchError extends Error {
  constructor(public code: FetchErrorCode, message: string, public status?: number) {
    super(message);
    this.name = "FetchError";
  }
}
