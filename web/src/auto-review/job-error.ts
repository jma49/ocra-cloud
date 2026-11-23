// Why the server gave a job up (src/db/job-recovery.ts) or could not start
// it, in words; any other error reads as the server wrote it.
const GIVEN_UP: Record<string, string> = {
  token_rejected: "GitLab refused this project's access token",
  lease_lapsed: "The runner stopped every time it tried this",
  never_started: "No runner picked this up in time",
};

export const givenUp = (error: string | null): string | undefined =>
  error === null ? undefined : GIVEN_UP[error];

export const jobError = (error: string): string => givenUp(error) ?? error;
