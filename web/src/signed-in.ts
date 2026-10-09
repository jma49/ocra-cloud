// Whether this browser was signed in when it last asked /me. A hint, never
// a credential: the HttpOnly session cookie decides. With it, the first
// page's reads start along with /me only when they are likely to answer,
// so the sign-in screen does not cost a /keys 401 per load (#92). Storage
// can be missing or throw (a private window, blocked site data): then there
// is no hint, and the reads wait for /me.

const HINT = "ocra.signed-in";

export function wasSignedIn(): boolean {
  try {
    return localStorage.getItem(HINT) === "1";
  } catch {
    return false;
  }
}

export function rememberSignedIn(signedIn: boolean): void {
  try {
    if (signedIn) localStorage.setItem(HINT, "1");
    else localStorage.removeItem(HINT);
  } catch {
    // Only a hint: without it, the next load waits for /me.
  }
}
