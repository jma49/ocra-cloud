import { StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";

type Me = { login: string; githubId: number };
type Key = { provider: string; last4: string; createdAt: string };
type Call = {
  id: string;
  provider: string;
  model: string | null;
  status: number;
  tokensIn: number;
  tokensOut: number;
  ms: number;
  createdAt: string;
};
type Usage = { today: number; dailyLimit: number; calls: Call[] };

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json() as Promise<T>;
}

function SignIn() {
  return (
    <section className="card">
      <h2>Sign in</h2>
      <p>ocra Cloud keeps your model keys encrypted and shows your reviews and usage.</p>
      <a className="button" href="/api/auth/github/login">
        Sign in with GitHub
      </a>
    </section>
  );
}

function Keys() {
  const [keys, setKeys] = useState<Key[]>([]);
  const [names, setNames] = useState<string[]>(["openrouter"]);
  useEffect(() => {
    api<{ providers: { name: string }[] }>("/providers").then(
      (r) => setNames(r.providers.map((p) => p.name).sort()),
      () => {},
    );
  }, []);
  const [provider, setProvider] = useState<string>("openrouter");
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const load = useCallback(() => {
    api<{ keys: Key[] }>("/keys").then(
      (r) => setKeys(r.keys),
      () => setError("Could not load keys."),
    );
  }, []);
  useEffect(load, [load]);
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    try {
      await api(`/keys/${provider}`, { method: "PUT", body: JSON.stringify({ key: value }) });
      setValue("");
      load();
    } catch {
      setError("That key was not accepted.");
    }
  };
  const remove = async (p: string) => {
    await api(`/keys/${p}`, { method: "DELETE" }).catch(() => setError("Could not delete."));
    load();
  };
  return (
    <section className="card">
      <h2>Model keys</h2>
      <p className="muted">
        Stored encrypted; never shown again after saving. Set a spending limit at your provider.
      </p>
      {keys.length === 0 ? (
        <p>No keys yet.</p>
      ) : (
        <ul className="rows">
          {keys.map((k) => (
            <li key={k.provider}>
              <span>
                <strong>{k.provider}</strong> <code>…{k.last4}</code>
              </span>
              <button type="button" onClick={() => remove(k.provider)}>
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={save} className="row">
        <select
          value={provider}
          onChange={(e) => setProvider(e.target.value)}
          aria-label="Provider"
        >
          {names.map((p) => (
            <option key={p}>{p}</option>
          ))}
        </select>
        <input
          type="password"
          autoComplete="off"
          placeholder="API key"
          aria-label="API key"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <button type="submit" disabled={value.trim().length < 8}>
          Save
        </button>
      </form>
      {error && <p className="error">{error}</p>}
    </section>
  );
}

function UsageView() {
  const [usage, setUsage] = useState<Usage | null>(null);
  useEffect(() => {
    api<Usage>("/usage").then(setUsage, () => setUsage(null));
  }, []);
  if (!usage) return null;
  return (
    <section className="card">
      <h2>Gateway calls</h2>
      <p className="muted">
        Today: {usage.today} of {usage.dailyLimit}. Every use of your keys is listed here; request
        and answer bodies are never stored.
      </p>
      {usage.calls.length === 0 ? (
        <p>No calls yet.</p>
      ) : (
        <div className="table">
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Model</th>
                <th>Status</th>
                <th>Tokens in/out</th>
                <th>ms</th>
              </tr>
            </thead>
            <tbody>
              {usage.calls.map((c) => (
                <tr key={c.id}>
                  <td>{new Date(c.createdAt).toLocaleString()}</td>
                  <td>{c.model ?? c.provider}</td>
                  <td>{c.status}</td>
                  <td>
                    {c.tokensIn}/{c.tokensOut}
                  </td>
                  <td>{c.ms}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  useEffect(() => {
    api<Me>("/me").then(setMe, () => setMe(null));
  }, []);
  const logout = async () => {
    await api("/auth/logout", { method: "POST" }).catch(() => {});
    setMe(null);
  };
  return (
    <main>
      <header>
        <h1>ocra Cloud</h1>
        {me && (
          <span>
            {me.login}{" "}
            <button type="button" onClick={logout}>
              Sign out
            </button>
          </span>
        )}
      </header>
      <p className="muted">Development build.</p>
      {me === undefined ? null : me === null ? (
        <SignIn />
      ) : (
        <>
          <Keys />
          <UsageView />
        </>
      )}
    </main>
  );
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
