# Accessibility Checklist

Use this checklist when reviewing UI changes. It complements the automated
color and typography regression checks (issue #43) that run in CI.

## Automated regression checks

Run the full frontend validation suite before merging UI changes:

```
npm run frontend:lint && npm run frontend:test && npm run frontend:test:e2e
```

The suite includes:

- **axe checks** across the core routes (home, dashboard, admin, auth) in both
  light and dark theme variants.
- **Computed-style assertions** for color and typography tokens, so silent
  token drift is caught before it ships.
- **Screenshot checks at 200% text zoom** for the core routes, verifying that
  layout stays usable and no horizontal traps appear.

When a contrast failure is reported, the check output identifies the offending
selector so the fix can be applied at the source rather than patched globally.

## Aggregate reaction counts

Reaction totals are shown as bare numbers visually, so they must carry an
explicit accessible name and announce changes without interrupting the user.

- [ ] Each aggregate reaction total exposes a meaningful accessible name that
  includes the count and the reaction type (e.g. "12 reactions" or
  "3 heart reactions"), not just the raw number.
- [ ] Singular/plural wording is correct ("1 reaction" vs "2 reactions").
- [ ] Missing, zero, or failed-to-load counts fall back to a graceful label
  (e.g. "No reactions" or "Reactions unavailable") instead of an empty or
  misleading number.
- [ ] Count changes are announced through a `polite` live region so screen
  readers do not interrupt the user; avoid `assertive` for reaction updates.
- [ ] The live region is present in the DOM before the count changes so the
  announcement is reliably picked up.
- [ ] The anonymous reaction model is preserved: no per-user identity, tracking,
  or attribution is introduced by the accessible labels or announcements.

## Manual review

- [ ] Color contrast meets WCAG AA in light and dark themes.
- [ ] Text remains readable and reflows at 200% zoom without horizontal scroll.
- [ ] Focus indicators are visible against all backgrounds.
- [ ] Motion respects `prefers-reduced-motion`.
- [ ] Interactive controls expose accessible names and roles.
