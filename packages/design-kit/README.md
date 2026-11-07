# packages/design-kit

The board's look: one base stylesheet and one CSS file per liquid-glass theme. The web app (`web/`) bundles them; nothing
else reads them.

| Path | What |
|---|---|
| `css/base.css` | Structure and motion for every theme: the grid, the four glass roles, widgets, menus, sheets, folders, the Look sheet, the chat panel, the phone layout, reduced motion. It holds a neutral fallback for every token |
| `css/themes/NN-slug.css` | One theme: the tokens below, plus its own paint. Every file found here is built into the app |
| `src/index.ts` | `listThemes()` (id, name, file), the token lists and `checkTheme()`, the contract check |
| `test/themes.test.ts` | Every theme passes `checkTheme()`, its id is in `THEME_IDS`, and nothing loads from the network |

## The look value

The only stored look is `Look` in `packages/contracts`: `{ theme, mode, hue }`.

- `theme`: a theme id (`THEME_IDS`). The app ships 7 themes (agent-mail, mercury, stadium-night, deep-sea, ice, obsidian,
  daybreak): one file each here. `THEME_IDS` still lists the 5 retired ids, so a stored look that names one stays valid and
  falls back to the first theme.
- `mode`: `light`, `dark` or `system`. System follows `prefers-color-scheme`, live.
- `hue`: a whole number 0–360, or `null` for the theme's own hue (`--hue-default`).

It is never CSS from a model. The chat agent's `set_look` tool sets only these three values.

## The theme contract

The app sets three things on `<html>`:

- `data-theme="<id>"`
- `data-mode="light|dark"` (System resolves to one of them)
- `--hue`: a number 0–360. It is the theme's `--hue-default` unless the user picked a hue. `@property --hue` makes it glide.

A theme is one CSS block. It sets the tokens under `[data-theme="<id>"]` (light) and `[data-theme="<id>"][data-mode="dark"]`.
Colors that should follow the hue use `oklch(L C var(--hue))`. A theme may add its own paint under its own selector, on the
`.wallpaper-fx` layer (`.fx1 .fx2 .fx3`) and in `::before` / `::after` layers. **A theme never changes layout, sizes or positions.**

Set once, in the light block:

```css
--hue-default;                                   /* the theme's own hue */
--font-ui; --font-num; --font-display;           /* system font stacks only; --font-num has tabular figures */
--r-widget; --r-panel; --r-chip; --gap; --pad;   /* radii and spacing */
--ease-water; --t-water; --ease-honey; --t-honey; --ease-pour; --t-pour; --ease-drain; --t-drain;
--lift-scale; --wobble;                          /* drag lift; the overshoot on release, in px */
```

Set in the light block and again in the dark block:

```css
--wallpaper;                                     /* the page behind the glass: gradients, no image files */
--text; --text-2; --text-3; --text-on-accent;
--accent;                                        /* buttons, focus, selection */
--attention;                                     /* "needs you" only: no other rule may use it */
--danger; --ok;                                  /* killed or blocked; verified or done */
--up; --down; --flat;                            /* movement only, never "good" or "bad" */
--ink-1 … --ink-6;                               /* chart series: Kalshi, Polymarket, more */
--refraction;                                    /* 0–1: the edge displacement (Chromium) */
--specular;                                      /* 0–1: the highlight that follows the pointer */
/* four glass roles: widget (tiles), panel (chat, menus, sheets, open folders), chip (buttons, chips), bar (top bar) */
--glass-<role>-bg;      /* a color or a gradient */
--glass-<role>-blur;    /* px */
--glass-<role>-sat;     /* % */
--glass-<role>-rim;     /* a color */
--glass-<role>-top;     /* a color: the top edge highlight */
--glass-<role>-shadow;  /* a shadow list, or none */
--glass-<role>-sheen;   /* a gradient, or none */
```

Shared class names (themes style these; they never add structure): `.wallpaper`, `.wallpaper-fx` (`.fx1 .fx2 .fx3`), `.bar`,
`.board`, `.w` with `.w--app`, `.w--display`, `.w--folder` and the sizes `.w--s`, `.w--m`, `.w--l`, `.w--xl`; `.w-menu-btn`,
`.menu`, `.chat`, `.sheet`, `.folder-open`, `.chip`, `.btn`. The base adds `.w-in .w-spot .w-shimmer .a-tile .f-tile .a-label
.surface .s-in`.

What `checkTheme()` enforces:

- every token above is set (mode tokens in both blocks), and each glass token has the right type;
- every selector starts with the theme's own `[data-theme="<id>"]`;
- no layout property outside the paint layers;
- no `@import`, no `@font-face`, no `url()` (`mercury` keeps inline `data:` noise art and is the one accepted exception);
- at most 40 KB;
- the attention color only in `.needs` rules.

## Adding a theme

1. Add `css/themes/NN-slug.css`. Its id must be in `THEME_IDS` (`packages/contracts/src/look.ts`).
2. `npx vitest run --project contracts packages/design-kit`.
3. `npx tsx web/build.ts`: the Look sheet lists every theme found.
