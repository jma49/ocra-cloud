import { type FormEvent, type ReactNode, type RefObject, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { CloseGlyph } from "./glyphs.js";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const focusables = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>(FOCUSABLE)];

/**
 * Takes focus into the panel when it opens (its first field, else the panel),
 * keeps Tab inside it, and gives focus back to what had it when it closes.
 */
function useFocusInside(panel: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const root = panel.current;
    if (!root) return;
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const body = root.querySelector<HTMLElement>(".drawer-body");
    const first = body ? focusables(body)[0] : undefined;
    (first ?? root).focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const all = focusables(root);
      const at = all.indexOf(document.activeElement as HTMLElement);
      const edge = e.shiftKey ? 0 : all.length - 1;
      if (all.length > 0 && at !== edge && at !== -1) return;
      e.preventDefault();
      all.at(e.shiftKey ? -1 : 0)?.focus();
    };
    root.addEventListener("keydown", onKey);
    return () => {
      root.removeEventListener("keydown", onKey);
      if (before?.isConnected) before.focus({ preventScroll: true });
    };
  }, [panel]);
}

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
  const panel = useRef<HTMLElement>(null);
  useFocusInside(panel);
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
  // On the body, so a positioned ancestor's stacking context cannot put it under the top bar.
  return createPortal(
    <>
      <div className="scrim" onClick={onClose} aria-hidden="true" />
      <aside
        ref={panel}
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-label={props.title}
        tabIndex={-1}
      >
        {props.onSubmit ? (
          <form className="drawer-frame" onSubmit={props.onSubmit} aria-label={props.title}>
            {inner}
          </form>
        ) : (
          inner
        )}
      </aside>
    </>,
    document.body,
  );
}
