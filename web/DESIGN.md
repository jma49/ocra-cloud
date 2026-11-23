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
- **Status tones:** `--critical` for critical findings, errors and destructive actions, `--warning` for warnings; pages name these semantic tokens, not `--red` and `--amber`, which are the palette behind them. `--green` is ok, `--blue` running or informational. Use them on text and soft fills (badges, notes), never as large backgrounds. Each reads at 4.5:1 as text on its own badge fill (an 8% tint), on the panel, on a card and inside a selected row, in both themes **(test, `contrast.test.ts`)**.
- **Chart series:** `--c1` to `--c6`, in order of use.
- **Radii:** `--r-tag` 4, `--r-chip` and `--r-tab` 6, `--r-ctl` 8 (controls, cards), `--r-sheet` 10 (panel, drawer).
- **coss ui names** (`--background`, `--popover`, `--accent`, `--destructive`, …) are aliases of the same tokens, declared in `base.css`; `styles/coss.css` maps them into Tailwind.

## Type

- **Fonts:** Geist for text, JetBrains Mono for code, diffs, file paths and ids, Noto Sans SC for Chinese (both stacks fall through to it). Ligatures are off everywhere: code reads as typed.
- **Scale (test):** sizes only through `--text-2xs` (10) … `--text-4xl` (30); no literal font sizes in stylesheets. Body is `--text-base` (13).
- **Roles:** page title `--text-2xl`/600; section and card titles `--text-base`/600; table headers, stat labels and group labels (`.quiet-label`) `--text-sm`/500 in sentence case, `--t3`, never uppercase or tracked; big numbers `--text-3xl`/600 with tabular figures.
- **Numbers** in tables, stats and badges use tabular figures and align right in columns (`.num`).
- Chinese text gets no letter-spacing.

## Spacing and layout

- **Steps:** 4, 8, 12, 16, 24, 32 px. Card padding 16; table cells 9×12 with 16 at the row's ends; sections 32 apart; page head 24 above content.
- **Frame:** a 56 px icon rail on the ground, the page on one panel beside it (`.frame`, `.rail`, `.panel`). The pagebar on top of the panel shows the breadcrumb and the place's tabs.
- **Places:** Inbox, Reviews, Findings, Repositories, Insights, and Settings as its own mode with a grouped side list. A new page belongs to one place and appears as one of its tabs (`routes.tsx`); it is reachable from the command menu (Ctrl/⌘ K) automatically. The same menu searches: past two characters it lists what the server finds (pull requests, reviews, findings, repositories) under the matching pages, a pull request named by its reference first.
- **Content width:** 1120 px max, centred, for lists, settings and reports. Work pages (below) take the panel's full width.
- **Breakpoints:** 1100 px (a work page's side columns stack), 900 px (grids and stat rows reflow), 760 px (the frame: rail becomes a row), 560 px. A new media query uses one of these.
- **Phone (760 px and narrower):** the rail becomes a row across the top, the panel fills the width, settings become a scrolling row, and wide tables stack. Nothing scrolls the page sideways at 390 px.

## Page patterns

- **Page head:** title and one sentence on what the page is for, actions on the right, on the title's line. A filter of the whole page (a range, a kind) is one of its actions.
- **Cards** (`.card`, `.card-head`, `.card-pad`) group one subject. Don't nest cards.
- **Tables** for records the user compares; list rows for records the user opens. Row actions sit at the row's right end, quietest first, destructive last. A table that would outgrow its card with them puts them behind one menu button (`Ellipsis`, named "Actions for …"). A table goes in `StackTable`: when its card is too narrow to hold it, at any window width, each row becomes a block (first cell as its title, the rest flowing after it, a `.cell-name` caption where a column head carried the meaning) instead of scrolling inside the card.
- **Stats row:** up to four `.stat` cards, label above value, a note below.
- **Detail pages:** properties in a left column, the timeline of what happened on the right.
- **Work pages** (a pull request, a walkthrough): a sticky side column of what the user navigates the work with (its files), the work itself (the diff) in the main column, and an optional third column (the impact rail) that stacks under the main one at 1100 px. A pull request's files are a tree (`FileList`, `web/src/styles/pull-files.css`): flat on the panel, a folder row over its files with a chain of single folders joined into one, each row with a 16 px icon of its kind (`FileTypeIcon`), a hairline down each level it sits under, and after a file's name a tick once viewed, a letter for what happened to it (A added, D removed, R renamed) and its line counts; past eight files a field narrows it by path. A diff is set at `--text-base` on a 22 px line. Its code is coloured by language (`highlightDiff`, `web/src/pull/highlight.ts`): the highlighter and each grammar load when a diff first needs them, a token's kind takes one of the console's hues mixed toward the text colour (`web/src/styles/syntax.css`) so it reads on added and removed lines in both themes, and a file of an unknown kind, of more than 4,000 lines or with a line past 1,000 characters stays plain.
- **A pull request's page** (`web/src/styles/pull.css`) is wider than other pages (1360 px) and adds two things above its code. Its head: where it lives (repository and number, a link to the platform) on a quiet line that scrolls away, then the part that stays in view: the title at `--text-3xl`, the standing in a badge or two (draft, conflicts, ready), the actions, of which the next step is the one primary button (mark ready on a draft, merge once nothing is in the way, review otherwise), and one meta line (`PullMeta`): the author with their mark, the branch into its base as two chips, files and lines, when it last moved. Under it, what the pull request is (stack, or its merge while one is under way: a line per layer with its mark, what the current one waits for, and Stop; description, threads) sits beside a status rail of what it waits on, ordered by what blocks first: merge readiness with unmet requirements leading and met ones folded (it counts what is met and leaves the standing to the head's badge), and Update branch under them while the branch is behind its base and an update can fix it, merge, ocra's review, checks, reviewers, labels. Nothing in this overview is a card but two things read as documents: its sections are flat, set apart by space on the left and by hairlines in the rail; the description is a sheet (`--text-md`, headings at `--text-xl` and `--text-lg`), and each review thread is a card: where it is on a quiet bar (file icon, path and line, standing, Resolve), its comments under it with the author's initial beside each, the reply at the foot. A review thread's comments are drawn as Markdown (`ThreadBody`), HTML comments and suggestion blocks out of sight; ocra's comment of a finding leads with its title, a severity badge and its notes on a quiet line. A list of requirements carries a `Tally` over it. The rail moves above the read at 1100 px. A "Jump to code" button floats while the diff is below the window.
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
| An empty list, a failed load, a missing page | `EmptyState` (coss Empty): icon, what appears here, one action |
| Text entry | `input.input`, `textarea.input` |
| Name of an icon-only control | `Tooltip` (the rail's `RailTip`); `aria-label` always |
| A few actions behind a button | `Menu` |
| A short note after something happened | `useToast()(message, tone)` (coss Toast), `"success"` or `"error"` when it is one |
| Go anywhere | the command menu (`Command`) |
| A finding's checked fix | `FixProposal` on a diff, `FixDiff` in a finding (`web/src/fixes/`): the lines it replaces, then what it writes, and Commit fix |
| ocra's open finding on a pull request's diff | `FindingNote` (`web/src/pull/findings.tsx`): under the last line it is about, above that line's fix, with its severity, title, text and a link into the review; only for the review of the head shown |
| A pull request's reviewers and assignees | `PeopleCard` (`web/src/pull/people.tsx`): each login with where they stand, a cross to take off one still asked or assigned, and Add, which opens `PeoplePicker` in place: a field that lists the repository's people by login prefix; Escape closes it |
| Text a model wrote, or a description a person wrote | `Markdown` (`web/src/markdown.tsx`, `styles/markdown.css`): headings at their level (from `h3`), lists, tables, code and emphasis; links, images and HTML stay text, since a model's answer is about untrusted code. Only a person's text from the platform passes `links`: its `https` links open in a new tab |
| A person on a line | `PersonMark` (`web/src/person-mark.tsx`): their picture where the server passed one the content policy allows, their initial on `--fill2` otherwise; the login follows it |
| How a pull request's checks stand, on a row | `CheckMark` (`web/src/pull/check-mark.tsx`): a 14 px circle icon in the state's tone (check, cross, dashed while running), named for a screen reader; an empty box of the same width where unknown, so titles stay aligned |
| A list's keys | `KeyHints` (`web/src/inbox/key-hints.tsx`): key caps (`Kbd`) with what each does, once under the list at `--text-sm`; never in the page's opening line |
| How a list of requirements stands | `Tally` (`web/src/pull/tally.tsx`): a 3 px line over the list, a segment per state as wide as its share (green met, red blocking, amber warning, `--t4` waiting), named for a screen reader |

A new shared control comes from coss ui first, then from a small component in `web/src/components/` styled with tokens.

## Icons

- **Lucide** for every UI icon, imported per icon (`lucide-react/icons/<name>`) so the bundle carries only what it uses **(test)**. Navigation icons are 20 px at 1.75 stroke; inline icons 16 px.
- Product marks are the products' own, drawn in the text colour so they read the same in both themes: GitHub and GitLab through `PlatformMark` (simple-icons), model providers through `ProviderLogo`, a quiet tile holding the mark from simple-icons or, where it has none, from `@lobehub/icons-static-svg` (`provider-marks.ts`). Every provider the gateway lists has one (the type fails otherwise); only a name it does not list falls back to two letters.
- **Files and folders** are the one exception to Lucide: a file tree, a diff's head and a thread's head show the kind of file with Material Icon Theme's icon (`FileTypeIcon`, `web/src/pull/file-icon.tsx`; MIT), in its own colours, 16 px. Only the kinds listed there are bundled; any other gets the plain file or folder.
- An icon never carries meaning alone: it has a visible label or an accessible name and tooltip.

## Motion

- **Easings:** `--e-std` for state changes, `--e-enter` for things that appear, `--e-settle` for things that move into place.
- **Durations:** 80 ms for press feedback, 120–160 ms for everything else that moves (hover, colour, menus, toasts, the drawer). Nothing longer, except the skeleton's fade-in and its shimmer, and the coss ui components' own tuned motion (a toast's stack settles over half a second), which pages leave as it is.
- **Hover and press:** every hover and press a page draws itself takes one rule (`web/src/styles/motion.css`): colours fade over 120 ms, and an icon button or tile gives way (scale 0.96) over 80 ms on press. A new hoverable class joins that list rather than setting its own transition.
- **What moves:** hover and selected states fade; menus, tooltips and toasts scale or rise in from their anchor; drawers slide from the right; nothing animates on scroll and nothing loops but loading.
- **Continuity:** an element that stays on screen keeps its position across a state change (optimistic updates, no reflow flashes); the open place and tab stay highlighted.
- **Reduced motion:** under `prefers-reduced-motion: reduce` every transition and animation stops and shows its end state.

## Accessibility

- Focus is always visible, drawn only in `--focus` **(test, `styles.test.ts`)**, the solid `--blue`, which keeps 3:1 against every surface **(test, `contrast.test.ts`)**.
- **The page bar's crumb:** a page under a place (a pull request, a review) names itself after the place, and the place is a link back. A pull request opened from the inbox also shows where it stands there ("2 of 8") with previous and next, `[` and `]` (`web/src/inbox/queue-nav.tsx`); the inbox's order is kept only while the console is open.
- **A page's commands** (`usePageCommands`, `web/src/page-commands.ts`): what a work page does is said once, as a label, an action and at most one unmodified key. The command menu lists them first under the page's name with the key beside each, the shortcuts panel lists them, and the key runs the same action on the page, never while typing, in a drawer or a menu. A card may offer its own under the page's title (the ocra review card's `a`). Keys keep one meaning everywhere: `j`/`k` next and previous, `Enter` open here, `o` open on the platform, `x` select, `u` read or unread, `/` find, `r` review or refresh, `a` ask ocra to review, `v` viewed, `d` details or dismiss, `f` fixed, `c` code, `m` merge, `[`/`]` previous and next pull request.
- **A list read by keys** (`useListCursor`, `web/src/list-cursor.ts`): `j`/`k` move a current row, kept in view and tinted `.is-current`. The inbox always shows it; elsewhere it shows from the first key press, at the first row.
- **Keys everywhere** (`web/src/shortcuts/`): `?` opens the shortcuts panel (also in the command menu under Help), `g` then a place's letter goes there (`g i` inbox, `g r` reviews, `g f` findings, `g p` repositories, `g n` insights, `g s` settings; the command menu shows them beside each place), ⌘K (Ctrl+K) the command menu. Keys are written with `KeyCaps`.
- **Drawers hold focus:** a drawer takes focus to its first field (else the panel) when it opens, keeps Tab inside it, closes on Escape, and gives focus back to what had it.
- Every control is reachable and usable by keyboard; menus and the command menu follow the ARIA menu and combobox patterns (from Base UI).
- Touch targets are at least 32 px; tone contrast as above.

## Checking a change

- `npm run verify` before pushing.
- Look at the change in light, dark and at 390 px before calling it done, and attach before and after screenshots to the pull request.
