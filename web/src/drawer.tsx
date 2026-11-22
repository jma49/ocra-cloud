import { type FormEvent, type ReactNode, useEffect } from "react";
import { CloseGlyph } from "./glyphs.js";

/**
 * The side panel a list opens to create or edit one of its records. With
 * `onSubmit` its body and foot are one form, named like the drawer.
 */
export function Drawer(props: {
  title: string;
  /** The heading, when it says more than the accessible name. */
  heading?: ReactNode;
  onClose: () => void;
  onSubmit?: (e: FormEvent) => void;
  foot?: ReactNode;
  children: ReactNode;
}) {
  const { onClose } = props;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const inner = (
    <>
      <div className="drawer-head">
        <h2>{props.heading ?? props.title}</h2>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
          <CloseGlyph />
        </button>
      </div>
      <div className="drawer-body">{props.children}</div>
      {props.foot && <div className="drawer-foot">{props.foot}</div>}
    </>
  );
  return (
    <>
      <div className="scrim" onClick={onClose} aria-hidden="true" />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label={props.title}>
        {props.onSubmit ? (
          <form className="drawer-frame" onSubmit={props.onSubmit} aria-label={props.title}>
            {inner}
          </form>
        ) : (
          inner
        )}
      </aside>
    </>
  );
}
