import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Text tones meet WCAG AA (4.5:1) on the surfaces they sit on, in both themes.
const base = readFileSync(join(import.meta.dirname, "styles", "base.css"), "utf8");
const forms = readFileSync(join(import.meta.dirname, "styles", "forms.css"), "utf8");
const dark = base.slice(base.indexOf("@media (prefers-color-scheme: dark)"));
const light = base.slice(0, base.indexOf("@media (prefers-color-scheme: dark)"));

type Rgb = [number, number, number];
function token(css: string, name: string): string {
  const m = css.match(new RegExp(`--${name}:\\s*([^;]+);`));
  if (!m?.[1]) throw new Error(`no --${name}`);
  return m[1].trim();
}
function solid(css: string, name: string): Rgb {
  const v = token(css, name);
  const ref = v.match(/^var\(--([\w-]+)\)$/)?.[1];
  if (ref) return solid(css.includes(`--${ref}:`) ? css : light, ref);
  return hex(v);
}
function mix(a: Rgb, b: Rgb, share: number): Rgb {
  return [0, 1, 2].map((i) => (a[i] ?? 0) * share + (b[i] ?? 0) * (1 - share)) as Rgb;
}
function hex(v: string): Rgb {
  const h = v.replace("#", "");
  return [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16)) as Rgb;
}
function tone(v: string, on: Rgb): Rgb {
  const m = v.match(/rgb\((\d+) (\d+) (\d+) \/ ([\d.]+)\)/);
  if (!m) throw new Error(`not an alpha tone: ${v}`);
  const a = Number(m[4]);
  const mix = (i: 0 | 1 | 2) => Number(m[i + 1]) * a + on[i] * (1 - a);
  return [mix(0), mix(1), mix(2)];
}
function luminance(c: Rgb): number {
  const [r, g, b] = c.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function ratio(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe.each([
  ["light", light, ["panel", "ground"]],
  ["dark", dark, ["panel", "ground", "raised"]],
])("%s theme", (_, css, surfaces) => {
  it.each(["t1", "t2", "t3"])("%s reads at 4.5:1 or more on every surface", (t) => {
    for (const s of surfaces) {
      const ground = hex(token(css, s));
      expect(ratio(tone(token(css, t), ground), ground), s).toBeGreaterThanOrEqual(4.5);
    }
  });
});

// A switch that is off is still a control: its track and its thumb each keep 3:1 (WCAG 1.4.11).
describe.each([
  ["light", light, ["panel", "raised"]],
  ["dark", dark, ["panel", "raised"]],
])("%s theme switch", (_, css, surfaces) => {
  it("shows its off track at 3:1 on every surface, and its thumb at 3:1 on the track", () => {
    for (const s of surfaces) {
      const surface = solid(css, s);
      const track = tone(token(css, "switch-off"), surface);
      expect(ratio(track, surface), s).toBeGreaterThanOrEqual(3);
      expect(ratio(solid(css, "panel"), track), `thumb on ${s}`).toBeGreaterThanOrEqual(3);
    }
  });
});

const badges = [...forms.matchAll(/color-mix\(in srgb, var\(--(\w+)\) (\d+)%, transparent\)/g)];
const TONES = { critical: "red", warning: "amber", green: "green", blue: "blue" } as const;

// A status tone is text on its own badge fill, on the panel or a card, also inside a selected row.
describe.each([
  ["light", light, ["panel", "raised"]],
  ["dark", dark, ["panel", "raised"]],
])("%s theme status tones", (_, css, surfaces) => {
  it.each(Object.entries(TONES))(
    "%s reads at 4.5:1 on its badge on every surface",
    (name, palette) => {
      const fill = badges.find((b) => b[1] === name || b[1] === palette);
      expect(fill, `no badge fill for --${name}`).toBeDefined();
      const share = Number(fill?.[2]) / 100;
      const text = solid(css, palette);
      for (const s of surfaces) {
        const surface = solid(css, s);
        const selected = mix(solid(css, "blue"), surface, 0.09);
        for (const under of [surface, selected]) {
          expect(ratio(text, mix(text, under, share)), s).toBeGreaterThanOrEqual(4.5);
        }
      }
    },
  );

  it("draws focus at 3:1 or more on every surface", () => {
    expect(token(light, "focus")).toBe("var(--blue)");
    for (const s of [...surfaces, "ground"]) {
      expect(ratio(solid(css, "blue"), solid(css, s)), s).toBeGreaterThanOrEqual(3);
    }
  });
});
