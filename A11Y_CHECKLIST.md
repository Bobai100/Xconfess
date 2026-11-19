# Accessibility Checklist

Use this checklist when building or reviewing UI changes. Each item should be verified before merge.

## Keyboard

- [ ] All interactive elements are reachable and operable with a keyboard alone (Tab / Shift+Tab).
- [ ] Focus order follows the visual reading order.
- [ ] A visible focus indicator is present on every focusable element.
- [ ] Custom widgets implement the expected key semantics (Enter/Space to activate, Escape to dismiss).
- [ ] Key handlers are scoped to the owning container and ignore modified keys (Ctrl/Meta/Alt) and editable targets (inputs, textareas, contenteditable) so they do not conflict with assistive technology or browser shortcuts.

### Feed and detail navigation

- [ ] Feed items are focusable and open their detail view with Enter or Space.
- [ ] Escape returns from a detail view to the feed.
- [ ] Focus is preserved across transitions: returning from a detail view restores focus to the originating feed item.
- [ ] Invalid or failed operations (missing/invalid item id, failed detail load) are safe no-ops: focus falls back to a sensible element (the feed container or the originating item) and no navigation occurs.

## Semantics

- [ ] Landmarks (`header`, `nav`, `main`, `footer`) are used to structure the page.
- [ ] Headings are hierarchical and describe their sections.
- [ ] Buttons are used for actions and links for navigation.
- [ ] Images have meaningful `alt` text, or empty `alt` when decorative.

## Forms

- [ ] Every input has an associated label.
- [ ] Validation errors are announced and tied to their fields.
- [ ] Required fields are indicated programmatically, not only visually.

## Color and contrast

- [ ] Text meets WCAG AA contrast ratios.
- [ ] Color is not the only means of conveying information.
- [ ] Design tokens are used instead of hard-coded colors (see the design-token drift check).

## Motion and media

- [ ] Animations respect `prefers-reduced-motion`.
- [ ] Media players are keyboard operable and captioned where applicable.

## Testing

- [ ] Automated tests cover the primary keyboard flow and focus restoration.
- [ ] Regression tests cover invalid/failed operations and AT shortcut conflicts.
