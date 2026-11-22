import {
  Menu,
  MenuItem,
  MenuLinkItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "@/components/ui/menu";
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
  return props.me.avatarUrl === null ? (
    <span className="avatar" aria-hidden="true" />
  ) : (
    <img className="avatar" src={props.me.avatarUrl} alt="" />
  );
}

/**
 * The account button and the few links it shows; compact: the avatar alone, as in the rail.
 * side: where the links open, beside the rail or below a bar.
 */
export function AccountMenu(props: { me: Me; compact?: boolean; side?: "bottom" | "right" }) {
  const logout = async () => {
    rememberSignedIn(false);
    await clearCache();
    await api("/auth/logout", { method: "POST" }).catch(() => {});
    location.href = "/";
  };
  const { me } = props;
  return (
    <Menu>
      <MenuTrigger
        className={props.compact ? "avatar-btn compact" : "avatar-btn"}
        aria-label={`Account: ${me.login}`}
      >
        <Avatar me={me} />
        {!props.compact && <span className="small">{me.login}</span>}
      </MenuTrigger>
      <MenuPopup className="account-menu" side={props.side ?? "bottom"} align="end" sideOffset={8}>
        <div className="menu-head">
          <div className="strong">{me.login}</div>
          <div className="subtle small">
            {me.githubId === null ? "Signed in with single sign-on" : "Signed in with GitHub"}
          </div>
        </div>
        <MenuLinkItem render={<Link to="/settings" />}>Settings</MenuLinkItem>
        <MenuLinkItem href={DOCS} target="_blank" rel="noreferrer">
          Documentation
        </MenuLinkItem>
        <MenuLinkItem href="/privacy">Data policy</MenuLinkItem>
        <MenuSeparator />
        <MenuItem onClick={logout}>Sign out</MenuItem>
      </MenuPopup>
    </Menu>
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
