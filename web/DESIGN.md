# ocra Cloud console: design spec

The rules every page of the web console follows. Values live in `web/src/styles/base.css`. This file says how to use them and why. A change to a rule edits this file in the same pull request. Rules marked **(test)** fail `npm test` when broken.

## Principles

- **A quiet frame for loud data.** Chrome is neutral and recedes; colour is spent on what the review found, never on navigation or decoration.
- **One ink for actions.** Primary actions are ink on panel; there is no brand accent colour.
- **Red is a warning, not a style.** Red marks only critical findings, errors and what cannot be undone, never links, tabs or selected states. The one exception is a diff, where removed lines and counts take a red tint and added ones a green tint.
- **Dense, not cramped.** 13 px body text, 8 px spacing steps, hairlines instead of boxes.
- **Every state is designed:** loading (skeleton), empty, error, and phone width, in light and dark.

## Tokens

Pages and components style only through the custom properties in `base.css`.

- **Colour (test):** no colour literal (`#…`, `rgb()`, `hsl()`, `oklch()`) in any stylesheet but `base.css`. Mix tokens with `color-mix()` where a tint is needed.
- **Text tones:** `--t1` body and headings, `--t2` secondary text, `--t3` labels and metadata, `--t4` placeholders and disabled text only. `--t1` to `--t3` keep 4.5:1 contrast on the panel and the ground, in both themes **(test, `contrast.test.ts`)**.
- **Surfaces:** `--ground` behind everything, `--panel` for the page, `--raised` for cards, menus and inputs. Depth comes from `--shadow` (resting) and `--float` (menus, drawers, dialogs), never from borders.
- **Lines:** `--hair` between rows, `--hair2` under headers and around groups. Lines are 0.5 px.
- **Fills:** `--fill` at rest, `--fill2` for hover and selected.
- **Status tones:** `--critical` for critical findings, errors and destructive actions, `--warning` for warnings; pages name these semantic tokens, not `--red` and `--amber`, which are the palette behind them. `--green` is ok, `--blue` running or informational. Use them on text and soft fills (badges, notes), never as large backgrounds.
- **Chart series:** `--c1` to `--c6`, in order of use.
- **Radii:** `--r-tag` 4, `--r-chip` and `--r-tab` 6, `--r-ctl` 8 (controls, cards), `--r-sheet` 10 (panel, drawer).
- **coss ui names** (`--background`, `--popover`, `--accent`, `--destructive`, …) are aliases of the same tokens, declared in `base.css`; `styles/coss.css` maps them into Tailwind.

## Type

- **Fonts:** Geist for text, Geist Mono for code, diffs, file paths and ids, Noto Sans SC for Chinese (both stacks fall through to it).
- **Scale (test):** sizes only through `--text-2xs` (10) … `--text-4xl` (30); no literal font sizes in stylesheets. Body is `--text-base` (13).
- **Roles:** page title `--text-2xl`/600; section and card titles `--text-base`/600; table headers and stat labels `--text-2xs`, uppercase, 0.5 px tracking, `--t3`; big numbers `--text-3xl`/600 with tabular figures.
- **Numbers** in tables, stats and badges use tabular figures and align right in columns (`.num`).
- Chinese text gets no letter-spacing and no uppercase.

## Spacing and layout

- **Steps:** 4, 8, 12, 16, 24, 32 px. Card padding 16; table cells 9×12 with 16 at the row's ends; sections 32 apart; page head 24 above content.
- **Frame:** a 56 px icon rail on the ground, the page on one panel beside it (`.frame`, `.rail`, `.panel`). The pagebar on top of the panel shows the breadcrumb and the place's tabs.
- **Places:** Inbox, Reviews, Findings, Repositories, Insights, and Settings as its own mode with a grouped side list. A new page belongs to one place and appears as one of its tabs (`routes.tsx`); it is reachable from the command menu (Ctrl/⌘ K) automatically.
- **Content width:** 1120 px max, centred, for lists, settings and reports. Work pages (below) take the panel's full width.
- **Breakpoints:** 1100 px (a work page's side columns stack), 900 px (grids and stat rows reflow), 760 px (the frame: rail becomes a row), 560 px (tables stack). A new media query uses one of these.
- **Phone (760 px and narrower):** the rail becomes a row across the top, the panel fills the width, settings become a scrolling row, and wide tables stack (`.table-wrap.stack`, a `.cell-name` caption where a column head carried the meaning). Nothing scrolls the page sideways at 390 px.

## Page patterns

- **Page head:** title and one sentence on what the page is for, actions on the right.
- **Cards** (`.card`, `.card-head`, `.card-pad`) group one subject. Don't nest cards.
- **Tables** for records the user compares; list rows for records the user opens. Row actions sit at the row's right end, quietest first, destructive last.
- **Stats row:** up to four `.stat` cards, label above value, a note below.
- **Detail pages:** properties in a left column, the timeline of what happened on the right.
- **Work pages** (a pull request, a walkthrough): a sticky side column of what the user acts with (files, their review, checks, merge, stack, queue), the work itself (the diff) in the main column, and an optional third column (the impact rail) that stacks under the main one at 1100 px.
- **Creating and editing:** a one-line create (a name and a value) sits inline in an `.add-form` card above the list; anything with more fields opens in a drawer, so the list stays in view.
- **Confirming:** no dialogs. An action that cannot be undone (merge, delete data, revoke a key) confirms in place: its button becomes "Confirm: …" beside Cancel, in the same spot. Removing something the user can add back again needs no confirmation.
- **Errors:** a failed load shows `LoadError` with a retry where the content would be; a failed action shows `ActionError` above the list it acted on.
- **Empty states** say what will appear here and the one action that makes it appear.
- **Loading:** skeletons appear after 300 ms, so fast loads never flash; cached data shows at once and refreshes in place.

## Components

Shared controls are coss ui (Base UI + Tailwind), copied into `web/src/components/ui/` with imports rewritten to `@/components/ui` and `@/lib/utils`. Tailwind utilities work only inside `web/src/components`; pages style with their own CSS (`web/src/styles/*.css`, no cascade layers).

| Need | Use |
|---|---|
| Action | `Button`: `default` primary (one per view), `outline` everything else, `ghost` in dense rows, `destructive-outline` to remove, `destructive` only inside a confirmation |
| Link that looks like a button | `<Button render={<Link to="…" />}>` |
| On/off setting | `Switch` |
| One of a few options, all visible | `Seg` (coss Toggle Group) |
| One of many options | native `select.input` |
| Several independent options in a form | `.check` checkboxes |
| A status word in a row | `.badge` (`-ok`, `-warn`, `-run`, `-err`) |
| A sentence of status or help | `.note` (`.ok`, `.err`) |
| Text entry | `input.input`, `textarea.input` |
| Name of an icon-only control | `Tooltip` (the rail's `RailTip`); `aria-label` always |
| A few actions behind a button | `Menu` |
| A short note after something happened | `useToast()(message, tone)` (coss Toast), `"success"` or `"error"` when it is one |
| Go anywhere | the command menu (`Command`) |

A new shared control comes from coss ui first, then from a small component in `web/src/components/` styled with tokens.

## Icons

- **Lucide** for every UI icon, imported per icon (`lucide-react/icons/<name>`) so the bundle carries only what it uses **(test)**. Navigation icons are 20 px at 1.75 stroke; inline icons 16 px.
- Product marks (GitHub, GitLab, model providers) come from simple-icons through `PlatformMark`, in their own colours only in logo tiles.
- An icon never carries meaning alone: it has a visible label or an accessible name and tooltip.

## Motion

- **Easings:** `--e-std` for state changes, `--e-enter` for things that appear, `--e-settle` for things that move into place.
- **Durations:** 80 ms for press feedback, 120–160 ms for everything else that moves (hover, colour, menus, toasts, the drawer). Nothing longer, except the skeleton's fade-in and its shimmer, and the coss ui components' own tuned motion (a toast's stack settles over half a second), which pages leave as it is.
- **What moves:** hover and selected states fade; menus, tooltips and toasts scale or rise in from their anchor; drawers slide from the right; nothing animates on scroll and nothing loops but loading.
- **Continuity:** an element that stays on screen keeps its position across a state change (optimistic updates, no reflow flashes); the open place and tab stay highlighted.
- **Reduced motion:** under `prefers-reduced-motion: reduce` every transition and animation stops and shows its end state.

## Accessibility

- Focus is always visible, drawn only in `--focus` **(test, `styles.test.ts`)**.
- Every control is reachable and usable by keyboard; menus and the command menu follow the ARIA menu and combobox patterns (from Base UI).
- Touch targets are at least 32 px; tone contrast as above.

## Checking a change

- `npm run verify` before pushing.
- Look at the change in light, dark and at 390 px before calling it done, and attach before and after screenshots to the pull request.
