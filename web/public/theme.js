// Sets the theme before the console draws, so a dark page never flashes
// light: the one chosen in the console (web/src/theme.ts), else the system's.
(() => {
  let chosen = null;
  try {
    chosen = localStorage.getItem("ocra.theme");
  } catch {}
  const dark =
    chosen === "dark" || (chosen !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
})();
