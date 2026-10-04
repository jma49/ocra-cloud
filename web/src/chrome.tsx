import { useEffect, useRef, useState } from "react";
import { api, type Me } from "./api.js";
import { Link } from "./router.js";
import { brandTag, DOCS, GITHUB } from "./site.js";
import { SmallSpider } from "./spider.js";

// The bar across the top and the footer, on every page.

export function TopBar(props: { me: Me | null }) {
  // The account menu is a disclosure: a button that shows a few links.
  // A click elsewhere closes it; Escape closes it and returns focus.
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
    await api("/auth/logout", { method: "POST" }).catch(() => {});
    location.href = "/";
  };
  return (
    <header className="topbar">
      <Link to="/" className="brand">
        <SmallSpider size={24} />
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
      {props.me && (
        <div ref={ref}>
          <button
            ref={button}
            type="button"
            className="avatar-btn"
            onClick={() => setOpen(!open)}
            aria-expanded={open}
            aria-controls="account-menu"
            aria-label={`Account: ${props.me.login}`}
          >
            <img
              className="avatar"
              src={`https://avatars.githubusercontent.com/u/${props.me.githubId}?s=64`}
              alt=""
            />
            <span className="small">{props.me.login}</span>
          </button>
          {open && (
            <div className="menu" id="account-menu">
              <div className="menu-head">
                <div style={{ fontWeight: 500 }}>{props.me.login}</div>
                <div className="subtle small">Signed in with GitHub</div>
              </div>
              <Link to="/settings" className="menu-item">
                Settings
              </Link>
              <a className="menu-item" href={DOCS} target="_blank" rel="noreferrer">
                Documentation
              </a>
              <button type="button" className="menu-item" onClick={logout}>
                Sign out
              </button>
            </div>
          )}
        </div>
      )}
    </header>
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
