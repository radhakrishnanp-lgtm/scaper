export type FetchErrorCode = "robots" | "blocked" | "network" | "timeout" | "private" | "http" | "too_large" | "browser" | "step" | "selector" | "cancelled" | "paused";

/** A fetch failure with a message written for the person using the app. */
export class FetchError extends Error {
  /** Screenshot (base64 JPEG) of the page at the moment it failed, for failure reports. */
  evidence?: string;
  constructor(public code: FetchErrorCode, message: string, public status?: number) {
    super(message);
    this.name = "FetchError";
  }
}
