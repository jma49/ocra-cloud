import { PageHead } from "../ui.js";

const CONTACT = "meetjincheng@yahoo.com";

/** The data policy ADR-0024 requires before Phase 1 ships. Public. */
export function Privacy() {
  return (
    <div className="policy">
      <PageHead
        title="Data policy"
        sub="What ocra Cloud stores, what it never stores, and how long."
      />
      <p className="subtle small" style={{ marginTop: 0, marginBottom: 24 }}>
        Effective 4 October 2026. We will email you before any change that reduces your rights under this policy.
      </p>

      <h2>What ocra Cloud stores</h2>
      <ul>
        <li>
          <b>Your account:</b> your GitHub user id and login, from signing in. The GitHub token used
          to learn who you are is used once and not kept.
        </li>
        <li>
          <b>Your provider keys,</b> encrypted: each key with its own AES-256-GCM data key, which a
          master key held apart from the database encrypts in turn. We show only the last four
          characters. Keys are used only to forward your model calls to the provider you chose, and
          to check a key when you save it or press Test.
        </li>
        <li>
          <b>A record of each model call</b> through the gateway: provider, model, HTTP status,
          token counts, duration and time. You see these under Activity.
        </li>
        <li>
          <b>Review counts</b> the CLI sends after a review: verdict, numbers of findings by
          severity, files and tasks, tokens, cost, duration, source and ocra version. The repository
          is a hash salted with a value that never leaves your machine, so we cannot tell which
          repository it is.
        </li>
        <li>
          <b>Sessions</b> (browsers and terminals signed in, as token hashes), your default models,
          and an audit log of key changes.
        </li>
      </ul>

      <h2>What ocra Cloud never stores</h2>
      <ul>
        <li>
          Your code, prompts or model answers. When the CLI calls a model through ocra Cloud, the
          request and the answer pass through to the provider and back; they are not written to
          storage or logs.
        </li>
        <li>File paths, finding titles or finding text from your reviews.</li>
        <li>Your provider keys in readable form.</li>
      </ul>
      <p>
        We do not use any of your data to train models, and we do not sell or share it. A review
        that names no <span className="mono">ocra-</span> model and is not signed in never contacts
        ocra Cloud at all.
      </p>

      <h2>How long</h2>
      <ul>
        <li>
          Model call records, review counts and the audit log: 90 days, then deleted automatically
          every day.
        </li>
        <li>
          Expired sign-in codes and sessions: deleted the day they expire. Browser sessions last 30
          days, terminal sessions 90.
        </li>
        <li>Your account, keys and default models: until you delete them.</li>
      </ul>

      <h2>Your controls</h2>
      <ul>
        <li>Export everything stored for your account as JSON, under Settings.</li>
        <li>
          Delete a key, a review record or a session at any time; delete your whole account under
          Settings, which removes all of the above at once, including the encrypted keys.
        </li>
        <li>
          In the CLI, <span className="mono">--no-upload</span> skips sending a review's counts and{" "}
          <span className="mono">OCRA_CLOUD=off</span> turns ocra Cloud off entirely.
        </li>
      </ul>

      <h2>Where, and who else</h2>
      <p>ocra Cloud runs on these services, which process data only to provide it:</p>
      <ul>
        <li>
          <b>Cloudflare</b> (Workers and D1): hosting and the database. The database is in western
          North America; requests are served from Cloudflare's network near you.
        </li>
        <li>
          <b>GitHub:</b> sign-in.
        </li>
        <li>
          <b>The model providers you choose</b> receive your model calls, with your code in them,
          under their own terms. Set a spending limit with each.
        </li>
      </ul>

      <h2>If something goes wrong</h2>
      <p>
        If we learn that data may have been exposed, we rotate the master key and revoke sessions as
        needed, and tell affected users by email to their GitHub address within 72 hours of knowing.
        Advise rotating any provider key you stored. Report a security issue to{" "}
        <a href={`mailto:${CONTACT}`}>{CONTACT}</a>.
      </p>

      <h2>Contact</h2>
      <p>
        Questions about this policy or your data: <a href={`mailto:${CONTACT}`}>{CONTACT}</a>.
      </p>
    </div>
  );
}
