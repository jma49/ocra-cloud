import { useEffect, useRef, useState } from "react";
import { api, type Me } from "./api.js";
import { clearCache } from "./cache.js";
import { EyesMark } from "./eyes.js";
import { Link } from "./router.js";
import { rememberSignedIn } from "./signed-in.js";
import { brandTag, DOCS, GITHUB } from "./site.js";

// The bar across the top of the signed-out pages, the account menu, the footer.

export function TopBar(props: { me: Me | null }) {
  return (
    <header className="topbar">
      <Link to="/" className="brand">
        <EyesMark size={26} className="brand-eyes" />
        ocra
        <span className="brand-tag">{brandTag(location.hostname)}</span>
      </Link>
      <span className="spacer" />
      <a className="toplink hide-sm" href={DOCS} target="_blank" rel="noreferrer">
        Docs
      </a>
      <a className="toplink hide-sm" href={GITHUB} target="_blank" rel="noreferrer">
        GitHub
      </a>
      {props.me && <AccountMenu me={props.me} />}
    </header>
  );
}

function Avatar(props: { me: Me }) {
  return props.me.githubId === null ? (
    <span className="avatar" aria-hidden="true" />
  ) : (
    <img
      className="avatar"
      src={`https://avatars.githubusercontent.com/u/${props.me.githubId}?s=64`}
      alt=""
    />
  );
}

/** The account button and the few links it shows; compact: the avatar alone, as in the rail. */
export function AccountMenu(props: { me: Me; compact?: boolean }) {
  // A disclosure: a click elsewhere closes it; Escape closes it and returns focus.
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen((was) => {
        if (was) button.current?.focus();
        return false;
      });
    };
    document.addEventListener("click", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("click", close);
      document.removeEventListener("keydown", onKey);
    };
  }, []);
  const logout = async () => {
    rememberSignedIn(false);
    await clearCache();
    await api("/auth/logout", { method: "POST" }).catch(() => {});
    location.href = "/";
  };
  const { me } = props;
  return (
    <div ref={ref} className={props.compact ? "account compact" : "account"}>
      <button
        ref={button}
        type="button"
        className="avatar-btn"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-controls="account-menu"
        aria-label={`Account: ${me.login}`}
      >
        <Avatar me={me} />
        {!props.compact && <span className="small">{me.login}</span>}
      </button>
      {open && (
        <div className="menu" id="account-menu">
          <div className="menu-head">
            <div className="strong">{me.login}</div>
            <div className="subtle small">
              {me.githubId === null ? "Signed in with single sign-on" : "Signed in with GitHub"}
            </div>
          </div>
          <Link to="/settings" className="menu-item">
            Settings
          </Link>
          <a className="menu-item" href={DOCS} target="_blank" rel="noreferrer">
            Documentation
          </a>
          <a className="menu-item" href="/privacy">
            Data policy
          </a>
          <button type="button" className="menu-item" onClick={logout}>
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

export function Footer() {
  return (
    <footer className="footer">
      <a href="/privacy">Data policy</a>
      <a href={DOCS} target="_blank" rel="noreferrer">
        Docs
      </a>
      <a href={GITHUB} target="_blank" rel="noreferrer">
        GitHub
      </a>
    </footer>
  );
}
