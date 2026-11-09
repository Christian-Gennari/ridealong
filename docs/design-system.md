# Viewer design system: glass

The viewer (`viewer/public/`) looks like a calm macOS app floating over a soft sky,
inspired by aside.com: frosted glass surfaces, hairline edges, layered soft shadows,
pill controls, a black primary button and lots of air. The agent orbs stay the only
saturated colour in the interface; the sky is pale and quiet behind everything.

## Principles

1. **Glass over sky.** The page background is a soft sky. Every chrome surface (top bar,
   side panel, popovers, banners, toasts) is frosted glass floating above it.
2. **The browser is the hero.** The remote screen sits in a clean window card with a
   large radius and a deep, soft shadow. Chrome never competes with it.
3. **Hairlines, not borders.** Edges are 0.5px rings drawn with box-shadow, plus a 1px
   inner top highlight on glass. No 1px grey borders.
4. **Pills and black.** Buttons and segmented controls are pills. The one primary action
   is solid ink (black in light mode, near-white in dark mode).
5. **Quiet motion.** 160–240ms, `cubic-bezier(.2,.8,.2,1)`. Popovers fade and scale from
   0.98. Respect `prefers-reduced-motion` and `prefers-reduced-transparency`.

## Tokens (`:root`, light; dark values in parentheses)

Keep all existing token names working (`--page --card --tray --tray-hover --line --selected
--ink --on-ink --body --quiet --shot --soft`) so nothing breaks, and add:

| Token | Light | Dark |
|---|---|---|
| `--sky` (page background) | `radial-gradient(1200px 600px at 15% -10%, #ffffff 0%, transparent 60%), radial-gradient(900px 500px at 90% 10%, rgba(255,255,255,.85) 0%, transparent 60%), linear-gradient(180deg, #bfe6fb 0%, #dcf1fc 45%, #f3f8fb 100%)` | `radial-gradient(1000px 600px at 20% -10%, rgba(80,110,170,.35) 0%, transparent 60%), linear-gradient(180deg, #0c1424 0%, #0a0f1a 50%, #08090d 100%)` |
| `--glass` | `rgba(255,255,255,.62)` | `rgba(28,30,36,.58)` |
| `--glass-strong` (popovers, panel) | `rgba(255,255,255,.78)` | `rgba(30,32,38,.78)` |
| `--blur` | `blur(24px) saturate(180%)` | same |
| `--hairline` | `0 0 0 .5px rgba(10,12,16,.16)` | `0 0 0 .5px rgba(255,255,255,.12)` |
| `--highlight` | `inset 0 1px 0 rgba(255,255,255,.8)` | `inset 0 1px 0 rgba(255,255,255,.06)` |
| `--lift-1` (controls) | `0 1px 3px rgba(0,0,0,.08), 0 1px 2px -1px rgba(0,0,0,.08)` | `0 1px 3px rgba(0,0,0,.5)` |
| `--lift-2` (cards, popovers) | `0 10px 15px -3px rgba(0,0,0,.08), 0 4px 6px -4px rgba(0,0,0,.08)` | `0 10px 20px -4px rgba(0,0,0,.55)` |
| `--lift-3` (screen window) | `0 20px 25px -5px rgba(0,0,0,.10), 0 8px 10px -6px rgba(0,0,0,.10)` | `0 24px 40px -8px rgba(0,0,0,.7)` |
| `--well` (segment tray) | `inset 0 1px 3px rgba(0,0,0,.06), 0 0 0 .5px rgba(10,12,16,.10)` | `inset 0 1px 3px rgba(0,0,0,.4), 0 0 0 .5px rgba(255,255,255,.08)` |
| `--body` / `--quiet` (text) | `#4b5059` / `#676d77` | `#a7adb8` / `#8b919d` |
| `--focus-ring` (focus) | `0 0 0 3px rgba(0,122,255,.25), 0 0 0 .5px color-mix(in srgb, var(--ink) 30%, transparent)` | same |
| `--ease` | `cubic-bezier(.2,.8,.2,1)` | same |
| `--r-window` 16px, `--r-card` 14px, `--r-item` 10px, `--r-pill` 999px | | |

Text colours: `--ink` #0a0b0d (#f5f6f8), `--body` #4b5059 (#a7adb8), `--quiet` #676d77 (#8b919d).
`--body` and `--quiet` both clear WCAG AA 4.5:1 against glass over the sky in light and dark.
`--tray` becomes a translucent fill: `rgba(10,12,16,.05)` (`rgba(255,255,255,.06)`),
`--tray-hover` `rgba(10,12,16,.08)` (`rgba(255,255,255,.10)`).

A glass surface is:
```css
background: var(--glass); -webkit-backdrop-filter: var(--blur); backdrop-filter: var(--blur);
box-shadow: var(--highlight), var(--hairline), var(--lift-2);
```
Fallbacks: `@supports not (backdrop-filter: blur(1px))` and
`@media (prefers-reduced-transparency: reduce)` switch every glass surface (bar, nudge,
panel, picker list, filters, banners, takeover, notice, typer and the glass pills) to
`--card` (solid) instead of `--glass`.

## Typography

Font stack: `-apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter", system-ui, "Segoe UI", sans-serif`
(Inter stays bundled as the fallback for non-Apple systems). Base 14px/22px. Titles use
weight 500–600 and negative tracking (`-.02em` at 20px+, `-.035em` at 32px+). Small labels
(section headers in the panel) are 12px, weight 500, colour `--quiet`, no uppercase.

## Components

- **Top bar:** a floating glass capsule inset 10–12px from the window edges, radius
  `--r-card`, height 56px. Brand left, status centre-left, controls right.
- **Segmented control:** tray with `--well`, radius pill, 3px padding. The selected
  segment is solid white (`--selected`, dark: `rgba(255,255,255,.14)`) with `--lift-1`.
  The Control mode, when selected, is solid ink.
- **Buttons:** `.primary` solid ink pill with `--lift-2`; `.ghost` glass pill with
  `--hairline`; `.icon` 34px circle, transparent until hover, then `--tray`.
- **Badge / tag:** pill, 12px, `box-shadow: inset 0 0 0 1px rgba(10,12,16,.18)`.
- **Screen window:** card with radius `--r-window`, `--hairline` + `--lift-3`,
  `overflow: hidden`, solid `--card` fill behind the canvas (no glass).
- **Side panel:** floating glass sheet (`--glass-strong`), radius `--r-window`, sits beside
  the screen with the same gap as the outer margin. Sections are separated by space and a
  small quiet label, not by lines. List rows are `--r-item`; the selected row is a white
  card with `--lift-1` (like Aside's sidebar).
- **Popovers (picker list):** `--glass-strong`, radius `--r-card`, `--lift-2`, open with fade +
  scale(.98 → 1) from the top right.
- **Banners and toasts (nudge, takeover, notice, turn banner):** glass capsules or cards,
  centred, never full-width grey strips.
- **Inputs:** 36px, radius `--r-item`, `--tray` fill, `--hairline`; focus ring
  `0 0 0 3px rgba(0,122,255,.25)` plus hairline in `--ink` 30%.
- **Switches:** iOS style, 36×22, on = `--ink` track (keep the existing `.switch` class).

## Keep

- Every element id, class used by `app.js`, ARIA attribute and text in `index.html`.
- The orbs and their per-agent colours, the turn "flood" effect and the turn flash.
- Light/dark/auto theming through `data-theme` and `prefers-color-scheme`.
- No new dependencies, no external fonts or CDNs (the server CSP is `default-src 'self'`).
