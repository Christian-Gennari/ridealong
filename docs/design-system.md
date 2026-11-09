# Viewer design system: glass

The viewer (`viewer/public/`) looks like a calm macOS app floating over a soft sky,
inspired by Linear, Arc, Raycast and macOS Sonoma: frosted glass surfaces, hairline
edges, layered soft shadows, pill controls, a black primary button and lots of air.
The agent orbs stay the only saturated identity colour; a single blue accent is
reserved for interaction (focus, switches, sliders, selection and link hover).

## Principles

1. **Glass over sky.** The page background is a soft sky. Every chrome surface (top bar,
   side panel, popovers, banners, toasts) is frosted glass floating above it. Glass
   surfaces in dark mode share one neutral tint so they read as the same material.
2. **The browser is the hero.** The remote canvas itself is the window: a 12px radius,
   a hairline and `--lift-3`, floating directly over the sky. There is no white card
   behind it and no shadow band under it; letterboxing shows the sky.
3. **Hairlines, not borders.** Edges are 0.5px rings drawn with box-shadow, plus a 1px
   inner top highlight on glass. No 1px grey borders.
4. **Pills and black.** Buttons and segmented controls are pills. The one primary action
   is solid ink (black in light mode, near-white in dark mode). The accent is only for
   interactive state, never for surface fill.
5. **Quiet motion.** 160–240ms for entrances and popovers, `cubic-bezier(.2,.8,.2,1)`.
   Hovers are a 4–6% fill change at 120ms. Popovers fade and scale from 0.98. Respect
   `prefers-reduced-motion` and `prefers-reduced-transparency`.
6. **One geometry.** Pills for buttons and segments, 10px for inputs and picker rows, 12px
   for inset group cards, 14px for cards, 16px for the window, panel and turn banner (the
   remote canvas is 12px). Icons are drawn at 1.75 stroke width everywhere.

## Tokens (`:root`, light; dark values in parentheses)

Keep all existing token names working (`--page --card --tray --tray-hover --line --selected
--ink --on-ink --body --quiet --shot --soft`) so nothing breaks, and add:

| Token | Light | Dark |
|---|---|---|
| `--sky` (page background) | `radial-gradient(1200px 600px at 15% -10%, #ffffff 0%, transparent 60%), radial-gradient(900px 500px at 90% 10%, rgba(255,255,255,.85) 0%, transparent 60%), linear-gradient(180deg, #bfe6fb 0%, #dcf1fc 45%, #f3f8fb 100%)` | `radial-gradient(1000px 560px at 18% -12%, rgba(64,84,126,.30) 0%, transparent 62%), linear-gradient(180deg, #0d1421 0%, #090d15 48%, #07080b 100%)` |
| `--glass` | `rgba(255,255,255,.62)` | `rgba(30,31,36,.62)` |
| `--glass-strong` (popovers, panel) | `rgba(255,255,255,.78)` | `rgba(30,31,36,.82)` |
| `--blur` | `blur(24px) saturate(180%)` | same |
| `--hairline` | `0 0 0 .5px rgba(10,12,16,.16)` | `0 0 0 .5px rgba(255,255,255,.12)` |
| `--highlight` | `inset 0 1px 0 rgba(255,255,255,.8)` | `inset 0 1px 0 rgba(255,255,255,.06)` |
| `--lift-1` (controls) | `0 1px 3px rgba(0,0,0,.08), 0 1px 2px -1px rgba(0,0,0,.08)` | `0 1px 3px rgba(0,0,0,.5)` |
| `--lift-2` (cards, popovers) | `0 10px 15px -3px rgba(0,0,0,.08), 0 4px 6px -4px rgba(0,0,0,.08)` | `0 10px 20px -4px rgba(0,0,0,.55)` |
| `--lift-3` (remote canvas) | `0 20px 25px -5px rgba(0,0,0,.10), 0 8px 10px -6px rgba(0,0,0,.10)` | `0 24px 40px -8px rgba(0,0,0,.7)` |
| `--well` (segment tray) | `inset 0 1px 3px rgba(0,0,0,.06), 0 0 0 .5px rgba(10,12,16,.10)` | `inset 0 1px 3px rgba(0,0,0,.4), 0 0 0 .5px rgba(255,255,255,.08)` |
| `--group` (settings inset group) | `rgba(255,255,255,.55)` | `rgba(255,255,255,.05)` |
| `--row-selected` (picker row) | `#ffffff` | `rgba(255,255,255,.10)` |
| `--accent` | `#0a84ff` | `#0a84ff` |
| `--accent-soft` | `rgba(10,132,255,.18)` | `rgba(10,132,255,.18)` |
| `--focus-ring` (focus) | `0 0 0 3px var(--accent-soft), 0 0 0 1px var(--accent)` | same |
| `--selected-ring` | `0 0 0 0 transparent` | `0 0 0 .5px rgba(255,255,255,.08)` |
| `--body` / `--quiet` (text) | `#4b5059` / `#676d77` | `#a7adb8` / `#8b919d` |
| `--ease` | `cubic-bezier(.2,.8,.2,1)` | same |
| `--r-window` 16px, `--r-card` 14px, `--r-item` 10px, `--r-pill` 999px | | |

Text colours: `--ink` #0a0b0d (#f5f6f8), `--body` #4b5059 (#a7adb8), `--quiet` #676d77 (#8b919d).
`--body` and `--quiet` both clear WCAG AA 4.5:1 against glass over the sky in light and dark.
`--tray` becomes a translucent fill: `rgba(10,12,16,.05)` (`rgba(255,255,255,.06)`),
`--tray-hover` `rgba(10,12,16,.08)` (`rgba(255,255,255,.10)`).
In dark mode `--selected` is `rgba(255,255,255,.12)`; selected segments add
`--selected-ring`, a 0.5px `rgba(255,255,255,.08)` ring.

A glass surface is:
```css
background: var(--glass); -webkit-backdrop-filter: var(--blur); backdrop-filter: var(--blur);
box-shadow: var(--highlight), var(--hairline), var(--lift-2);
```
Fallbacks: `@supports not (backdrop-filter: blur(1px))` and
`@media (prefers-reduced-transparency: reduce)` switch every glass surface (bar, nudge,
panel, picker list, banners, takeover, notice, typer and the glass pills) to `--card`
(solid) instead of `--glass`. The side panel then becomes one solid fill from top to
bottom.

## Typography

Font stack: `-apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter", system-ui, "Segoe UI", sans-serif`
(Inter stays bundled as the fallback for non-Apple systems). Base 13px/20px. Titles use
weight 500–600 and negative tracking (`-.02em` at 16–20px, `-.035em` at 32px+). Section
labels in the panel are 11.5px, weight 500, colour `--quiet`, 0.01em tracking, no
uppercase. Field labels and panel body text are 13px; status text is 13px/15px. Hints are
12px `--quiet`. The turn banner title is 22px/600 at `-.02em`.

## Components

- **Top bar:** a floating glass capsule inset 10–12px from the window edges, radius
  `--r-card`, height 48px. Brand left, status centre-left, controls right. Mark 20px,
  wordmark 16px/600 at `-.02em`, status orb 22px, icon buttons 32px.
- **Segmented control:** tray with `--well`, radius pill, 3px padding, 28px tall with
  12.5px labels. The selected segment is solid white (`--selected`, dark:
  `rgba(255,255,255,.12)`) with `--lift-1` and `--selected-ring`. The Control mode, when
  selected, is solid ink.
- **Buttons:** `.primary` solid ink pill with `--lift-2`; `.ghost` glass pill with
  `--hairline`; `.icon` 32px circle, transparent until hover, then `--tray`. Every hover
  is a 120ms, 4–6% fill change.
- **Badge / tag:** pill, 12px, `box-shadow: inset 0 0 0 1px rgba(10,12,16,.18)`.
- **Screen window:** `main` is transparent, has no padding or shadow clipping, and sits
  flush with the workspace's outer margin. The remote canvas in `#screen` gets radius
  12px, clipped corners, `--hairline` + `--lift-3`; the letterbox around it shows the
  sky, and the lift can spill into the gutter. No card fill or reflection band behind or
  below it.
- **Side panel:** floating glass sheet (`--glass-strong`), 320px wide, radius
  `--r-window`, sits beside the screen with the same gap as the outer margin. One even
  surface from top to bottom: the header and `.filters` strip paint nothing of their own,
  the filters sit above their own scrolling list instead of blurring the panel behind
  them, and `.foot` is separated only by a 0.5px hairline. Filter chips rest at half
  `--tray` and hover to full `--tray`.
- **Settings groups:** each `section` is a small 11.5px quiet label above an inset card:
  `--group` fill, 12px radius, a .5px `--hairline` ring, rows at least 40px tall with 12px
  side padding, and .5px `--line` separators inset 12px from the left with none after the
  last row. Hints sit 4px under the card at 12px `--quiet`. The rule input and Add share
  one row; the clipboard textarea sits in its card with its two buttons in a row below.
  Advanced is the same card, its summary a 40px row with a chevron that rotates 90° open.
- **Activity:** 13px/20px. Group heads use a 20px orb, a 13px/500 name and a quiet 11.5px
  tabular timestamp; groups are separated by 12px of space, never a rule. Steps hang on a
  .5px timeline with 6px dots ringed by .5px. Ask cards stay `--r-item` tray cards.
- **Empty state:** 44px orb, 14px/600 title, 12.5px `--quiet` copy capped at 220px, centred
  and sitting at about 40% of the pane's height.
- **Popovers (picker list):** `--glass-strong`, radius `--r-card`, `--lift-2`, open with fade +
  scale(.98 → 1) from the top right. The trigger is a 32px glass pill; rows are 44px with a
  22px orb, a 13px/500 name and 12px quiet doing-text; the selected row is a
  `--row-selected` card with `--lift-1` (dark: `rgba(255,255,255,.10)`).
- **Banners and toasts (nudge, takeover, notice, turn banner):** glass capsules or cards,
  centred, never full-width grey strips. Takeover and notice are 40px capsules at 13px
  (the takeover button inside is 30px). The turn banner is a 16px-radius card inset 12px
  from the edges, padded 16px 20px, with a 52px orb, a 22px/600 `-.02em` title, a 14px
  reason and a 12.5px quiet sub; its primary Hand back is a 40px, 15px pill. The flood
  colour wash stays behind it.
- **Inputs:** 36px, radius `--r-item`, `--tray` fill, `--hairline`; focus ring
  `0 0 0 3px var(--accent-soft)` plus `0 0 0 1px var(--accent)`. Inside a settings group
  the rule field and clipboard are borderless rows instead.
- **Switches:** iOS style, 36×22, on = `--accent` track with a white knob and a subtle
  knob shadow (keep the existing `.switch` class).
- **Sliders:** the filled track and the white thumb's 1px ring use `--accent`; the
  unfilled track is `--tray-hover`.
- **Links:** `.link` keeps ink text, and hovers to `--accent` over a 4–6% `--tray` fill.
- **Selection:** `::selection` tints only the background with `--accent-soft`, so text on
  solid-ink buttons keeps its own `--on-ink` colour and stays readable.
- **Icons:** all inline SVG uses stroke width 1.75.

## Keep

- Every element id, class used by `app.js`, ARIA attribute and text in `index.html`.
- The orbs and their per-agent colours, the turn "flood" effect and the turn flash.
- Light/dark/auto theming through `data-theme` and `prefers-color-scheme`.
- No new dependencies, no external fonts or CDNs (the server CSP is `default-src 'self'`).
