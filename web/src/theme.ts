import { useSyncExternalStore } from "react";

// Light or dark: the system's unless the user chose one here. The choice is
// kept in this browser; `public/theme.js` applies it before the page draws.

export type ThemeChoice = "system" | "light" | "dark";

export const THEMES: { value: ThemeChoice; label: string }[] = [
  { value: "system", label: "Match the system" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

const KEY = "ocra.theme";
const system = () => matchMedia("(prefers-color-scheme: dark)");
const listeners = new Set<() => void>();

function themeChoice(): ThemeChoice {
  try {
    const kept = localStorage.getItem(KEY);
    return kept === "light" || kept === "dark" ? kept : "system";
  } catch {
    return "system";
  }
}

/** The theme drawn now. */
export function isDark(): boolean {
  return document.documentElement.dataset.theme === "dark";
}

function apply(): void {
  const choice = themeChoice();
  const dark = choice === "dark" || (choice === "system" && system().matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  for (const l of listeners) l();
}

export function chooseTheme(choice: ThemeChoice): void {
  try {
    if (choice === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, choice);
  } catch {}
  apply();
}

/** Applies the theme and keeps following the system's while the user has not chosen. */
export function followTheme(): void {
  apply();
  system().addEventListener("change", apply);
}

export function useThemeChoice(): ThemeChoice {
  return useSyncExternalStore((l) => {
    listeners.add(l);
    return () => listeners.delete(l);
  }, themeChoice);
}
