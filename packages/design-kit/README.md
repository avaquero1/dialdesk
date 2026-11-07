# packages/design-kit

The base board and the 6 glass themes. Empty until the mockup review: the input is the UI plan
(the board, the theme contract and its tokens, the shared class names) and the chosen base mockup.

- Theme contract: `data-theme`, `data-mode` (light or dark; System resolves live) and `--hue` on `<html>`.
- A theme is one CSS block of tokens. It never changes layout.
- The look value is `Look` in `packages/contracts` (`theme`, `mode`, `hue`). It is never CSS from a model.
- Displays render from a widget spec (`WidgetSpec`); the catalog is `WIDGET_CATALOG` in `packages/contracts`.
