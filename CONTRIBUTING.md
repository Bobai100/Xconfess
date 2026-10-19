# Contributing

Thanks for your interest in contributing! This document covers the basics of
setting up the project, running checks, and the quality gates your change must
pass before it can be merged.

## Getting started

1. Fork and clone the repository.
2. Install dependencies with `npm install`.
3. Create a topic branch off `main`.
4. Make your change, add tests, and run the checks below.

For changes that add or alter data collection, access, retention, or disclosure,
complete the [data-flow threat-model review checklist](docs/data-flow-threat-model-checklist.md).
For local Docker and service failures, follow the
[troubleshooting decision tree](docs/local-service-troubleshooting.md). Check
the [supported runtime and service versions](docs/supported-service-versions.md)
before changing runtime or infrastructure declarations.

## Quality gates

Every pull request must pass the following gates. CI runs them automatically and
will fail the build when a deterministic check regresses.

```bash
npm run frontend:lint
npm run frontend:test
npm run frontend:test:e2e
```

## Accessibility acceptance gates (WCAG 2.2 AA)

Accessibility is a release-level requirement, not an afterthought. Critical
routes and shared components must meet the **WCAG 2.2 Level AA** conformance
target before a release ships. Automated checks catch deterministic regressions
in CI; manual checks cover behavior that tooling cannot verify.

### Conformance target

- **Standard:** WCAG 2.2 Level AA.
- **Scope:** all critical routes and the shared components they render.
- **Release gate:** a release is blocked if any critical route fails an AA gate
  below, or if a deterministic automated check regresses.

### Route / component matrix

Each critical route and shared component is evaluated against the dimensions
below. When you add or change a critical route or shared component, update this
matrix and the corresponding automated coverage.

| Route / component | Keyboard | Focus | Semantics | Contrast | Motion | Assistive tech |
| --- | --- | --- | --- | --- | --- | --- |
| App shell / navigation | Tab order reaches all controls; no traps | Visible focus indicator; focus returns after overlays close | Landmarks (`header`/`nav`/`main`), one `h1` per view | Text and UI ≥ 4.5:1 / 3:1 | Honors `prefers-reduced-motion` | Screen reader announces landmarks and current page |
| Composer / input | Fully operable via keyboard; shortcuts documented | Focus moves to input on open; restored on close | Labeled controls, `aria-*` state exposed | Placeholder and helper text ≥ 4.5:1 | No motion required to operate | Errors and status announced via live region |
| Lists / feeds | Items reachable and activatable by keyboard | Focus visible on the active item; roving tabindex where applicable | List semantics (`ul`/`li` or `role="list"`) | Item text and metadata ≥ 4.5:1 | Animated inserts respect reduced motion | Item count and updates announced |
| Modals / dialogs | Escape closes; focus trapped while open | Initial focus set; focus restored to trigger | `role="dialog"`, `aria-modal`, labeled by title | Overlay content ≥ 4.5:1 | Open/close animation respects reduced motion | Title and description announced on open |
| Forms / settings | All fields and actions keyboard operable | Focus order matches visual order | Every input has a programmatic label | Labels, hints, and errors ≥ 4.5:1 | No motion-only feedback | Validation errors linked via `aria-describedby` |

### Automated checks

- Linting includes accessibility rules for JSX/TSX.
- Component tests assert roles, accessible names, and keyboard interactions for
  the shared components above.
- End-to-end tests exercise keyboard-only flows and assert focus management for
  critical routes.
- Deterministic accessibility regressions fail CI via the gates in
  `npm run frontend:lint`, `npm run frontend:test`, and
  `npm run frontend:test:e2e`.

### Manual checks

Automated tooling cannot cover everything. Before requesting review on a change
that touches a critical route or shared component, verify manually:

- **Keyboard:** complete the primary task using only the keyboard; confirm no
  focus traps and a logical tab order.
- **Focus:** confirm a visible focus indicator and that focus is restored after
  dialogs, menus, and overlays close.
- **Semantics:** confirm landmarks, headings, and roles match the matrix.
- **Contrast:** confirm text and meaningful UI meet 4.5:1 / 3:1 using a contrast
  checker.
- **Motion:** enable `prefers-reduced-motion` and confirm animations are reduced
  or removed.
- **Assistive tech:** run the primary flow with a screen reader (e.g. VoiceOver,
  NVDA) and confirm names, states, and live updates are announced.

Document any manual checks performed in the pull request description, along with
assumptions and follow-up work.

## Pull request checklist

- [ ] Change is focused on the stated scope.
- [ ] `npm run frontend:lint`, `npm run frontend:test`, and
      `npm run frontend:test:e2e` pass locally.
- [ ] Accessibility matrix updated for any new or changed critical route or
      shared component.
- [ ] Manual accessibility checks performed and noted in the description.
- [ ] Adjacent contracts or runbooks updated when behavior changes.
