# Busy and unavailable controls

This guide covers how a refresh control shows busy state and how in-flight or unavailable controls are disabled and dimmed.

## Busy state is `[aria-busy]`, and the arrow spins

A control that re-reads state (network `git fetch` or a local re-read) shows
"working" one way: an accent tint, and its circular-arrow glyph rotating. See
`design/Refresh Affordances - Normalization.dc.html`. A new refresh control
obeys all three rules:

- **Draw the glyph with `lib/RefreshGlyph.tsx`, never a `↻` text
  character.** Neither bundled face has U+21BB, so it draws in an OS font. A
  text node also gives the animation no target; spinning the whole bordered
  24px button made it cartwheel.
- **Paint busy from `[aria-busy="true"]`, not from a class.** The blanket
  `prefers-reduced-motion` rule at the top of `app.css` stops every
  animation, but the tint survives. A control also cannot look busy without
  announcing it.
- **Do not add your selector to the spin rule.** It keys off
  `.refresh-glyph`, which the shared component stamps. Only the tint list
  names buttons, because their shapes differ.

A glyph that is not a circular arrow (Pull's ↓, Push's ↑) swaps to
`.wt-btn__spinner`. A spinning "down" arrow looks broken.

- **Mark an in-flight control `aria-disabled`, never `disabled`, and guard the
  click handler.** Chromium blurs an element when it becomes `disabled`, so
  keyboard activation sends focus to `<body>` (WCAG SC 2.4.3).
- **Use `disabled` for a truly unavailable action**, unless it must explain
  itself on hover. A `disabled` button gets no pointer events, so it shows no
  hover card. For this reason `.lens-chip.is-empty` uses `aria-disabled` and a
  guarded click: the lens chips are icon-only, so the chip must explain why it
  is grey.
- **`opacity` on a focusable control also dims its focus ring.**
  `filter: opacity()` does the same, and a `mask` removes the ring. Add each
  new dimmed `aria-disabled` rule to the focused-unavailable block in
  `app.css`. That block comes after every fade rule, so it wins the tie. While
  focused, it paints subtle border, transparent fill and `--text-subtle` text
  at full opacity.
