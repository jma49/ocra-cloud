import { PageHead } from "../ui.js";

const CONTACT = "meetjincheng@yahoo.com";

/** The data policy (ADR-0024, ADR-0028). Public. */
export function Privacy() {
  return (
    <div className="policy">
      <PageHead
        title="Data policy"
        sub="What ocra Cloud stores, what it never stores, and how long."
      />
      <p className="subtle small" style={{ marginTop: 0, marginBottom: 24 }}>
        Effective 4 October 2026. We will email you before any change that reduces your rights under
        this policy.
      </p>

      <h2>What ocra Cloud stores</h2>
      <ul>
        <li>
          <b>Your account:</b> your GitHub user id and login, from signing in. The GitHub token used
          to learn who you are is used once and not kept.
        </li>
        <li>
          <b>Your provider keys,</b> encrypted: each key with its own AES-256-GCM data key, which a
          master key held apart from the database (a Cloudflare Worker secret) encrypts in turn. A
          key is decrypted only in memory, for the request that uses it: to forward your model call
          to the provider you chose, or to check the key when you save it or press Test. It is never
          logged and never shown again; we display its last four characters. Deleting it removes it
          at once.
        </li>
        <li>
          <b>A record of each model call</b> through the gateway: provider, model, HTTP status,
          token counts, duration and time. You see these under Activity.
        </li>
        <li>
          <b>Review counts</b> the CLI sends after a review: verdict, numbers of findings by
          severity and by reviewer, files and tasks, how many earlier findings were fixed or
          dismissed, tokens, cost, duration, source and ocra version. The repository is a hash
          salted with a value that never leaves your machine, so we cannot tell which repository it
          is.
        </li>
        <li>
          <b>Findings, only if you turn on "Send findings and the code they quote"</b> in Settings
          (off by default): each finding's file path, line range, title, description, suggestion and
          the code it quotes. Secret-looking tokens are replaced with [redacted] on your machine and
          again on the server; this catches common patterns, not every secret. While this is on,
          your machines share one repository salt held by your account, so that the same repository
          has the same hash on each of them; with a server-held salt we could test a guessed
          repository address against it.
        </li>
        <li>
          <b>Memory</b> you add on the web: the repository's hash, the finding's fingerprint, file
          and title, and your reason.
        </li>
        <li>
          <b>Your settings</b> (models, agents, limits, rules, plugin names and their settings) with
          their saved versions,
          <b> sessions</b> (browsers and terminals signed in, as token hashes), and an audit log of
          key and settings changes.
        </li>
      </ul>

      <h2>What ocra Cloud never stores</h2>
      <ul>
        <li>
          Your prompts or model answers. When the CLI calls a model through ocra Cloud, the request
          and the answer pass through our gateway in memory only; they are never written to storage,
          logs or error reports.
        </li>
        <li>
          Your code, file paths or finding text, unless you turn on sending findings; then only what
          is listed above.
        </li>
        <li>Your provider keys in readable form.</li>
      </ul>
      <p>
        We do not use any of your data to train models, and we do not sell or share it. A review
        that names no <span className="mono">ocra-</span> model and is not signed in never contacts
        ocra Cloud at all.
      </p>

      <h2>Your model provider</h2>
      <p>
        The key is yours, so what the provider does with your requests (whether it keeps them, for
        how long, and whether it trains on them) is governed by{" "}
        <b>your agreement with that provider</b>, not by this policy. If you need zero data
        retention, use a provider account or plan that offers it, and set a spending limit there as
        well.
      </p>

      <h2>How long</h2>
      <ul>
        <li>
          Model call records, review counts, findings and the audit log: 90 days, then deleted by a
          daily job.
        </li>
        <li>
          Expired sign-in codes and sessions: deleted the day they expire. Browser sessions last 30
          days, terminal sessions 90 from sign-in, however often they refresh.
        </li>
        <li>
          Your account, keys, settings and memory: until you delete them. The newest 50 versions of
          your settings are kept.
        </li>
        <li>
          What you delete leaves the live database at once. The database keeps point-in-time history
          for recovery, which expires within 30 days, so deleted data is gone everywhere within 30
          days.
        </li>
        <li>
          Our service logs hold only our own error messages, never request or answer bodies, keys or
          tokens, and expire within 7 days.
        </li>
      </ul>

      <h2>Your controls</h2>
      <ul>
        <li>
          Export everything stored for your account as JSON, under Settings; download any review's
          findings from its page.
        </li>
        <li>
          Delete a key, a review, a memory entry or a session at any time; turn off sending findings
          and delete those already sent; delete your whole account under Settings, which removes
          everything above at once, including the encrypted keys.
        </li>
        <li>
          In the CLI, <span className="mono">--no-upload</span> skips sending a review's data and{" "}
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
          under your agreement with them.
        </li>
      </ul>
      <p>
        We will email you at least 30 days before adding a service that processes your data; if you
        object, you can export your data and delete your account before the change takes effect.
      </p>

      <h2>If something goes wrong</h2>
      <p>
        If we confirm that data was exposed, we rotate the master key and revoke sessions as needed,
        and email affected users at their GitHub address within 72 hours: what happened, which data
        was involved, what we did, and what you should do (such as rotating a provider key). Report
        a security issue to <a href={`mailto:${CONTACT}`}>{CONTACT}</a>; we acknowledge reports
        within 7 days.
      </p>

      <h2>Certifications</h2>
      <p>
        ocra Cloud is not yet SOC 2 certified and does not yet offer a data processing agreement. If
        your organization needs either, contact us before you rely on the service.
      </p>

      <h2>Contact</h2>
      <p>
        Questions about this policy or your data: <a href={`mailto:${CONTACT}`}>{CONTACT}</a>.
      </p>
    </div>
  );
}
