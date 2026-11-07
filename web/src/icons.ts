/** Line icons, 24 × 24, stroked in currentColor. Constants of this app only. */
const sv = (d: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const SHIELD = '<path d="M12 3.2l7 2.8v5.2c0 4.3-2.9 7.9-7 9.6-4.1-1.7-7-5.3-7-9.6V6z"/>';
const USER = '<circle cx="12" cy="9" r="3.4"/><path d="M5.5 19.2c1.2-3.3 3.7-4.8 6.5-4.8s5.3 1.5 6.5 4.8"/>';

export const IC = {
  dots: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5.5" cy="12" r="1.9"/><circle cx="12" cy="12" r="1.9"/><circle cx="18.5" cy="12" r="1.9"/></svg>',
  shield: sv(SHIELD),
  user: sv(USER),
  accounts: sv(USER),
  trust: sv(SHIELD + '<path d="M8.8 12.2l2.3 2.3 4.2-4.5"/>'),
  receipts: sv('<path d="M6.5 3.5h11v17l-2.75-1.8L12 20.5l-2.75-1.8L6.5 20.5z"/><path d="M9.5 8.5h5M9.5 12h5"/>'),
  catalog: sv(
    '<rect x="4" y="4" width="6.6" height="6.6" rx="1.7"/><rect x="13.4" y="4" width="6.6" height="6.6" rx="1.7"/><rect x="4" y="13.4" width="6.6" height="6.6" rx="1.7"/><path d="M16.7 13.4V20M13.4 16.7H20"/>',
  ),
  settings: sv('<path d="M4 7.5h9M17.5 7.5H20M4 16.5h2.5M11 16.5h9"/><circle cx="15.2" cy="7.5" r="2.2"/><circle cx="8.7" cy="16.5" r="2.2"/>'),
  chat: sv('<path d="M5 6.7C5 5.8 5.8 5 6.7 5h10.6c.9 0 1.7.8 1.7 1.7v7.6c0 .9-.8 1.7-1.7 1.7H11l-4 3.5V16H6.7C5.8 16 5 15.2 5 14.3z"/>'),
  refresh: sv('<path d="M19 12a7 7 0 1 1-2.2-5.1"/><path d="M19 4.6V8.4h-3.8"/>'),
  size: sv('<path d="M9 4.5H5.5V8M15 4.5h3.5V8M9 19.5H5.5V16M15 19.5h3.5V16"/>'),
  doc: sv('<path d="M7 3.5h7l4 4v13H7z"/><path d="M14 3.5v4h4M9.6 12.2h5M9.6 15.8h5"/>'),
  folder: sv('<path d="M3.8 7.6c0-.8.7-1.5 1.5-1.5h3.9l2 2.1h7c.8 0 1.5.7 1.5 1.5v7.6c0 .8-.7 1.5-1.5 1.5H5.3c-.8 0-1.5-.7-1.5-1.5z"/>'),
  drop: sv('<path d="M12 4c3.1 3.6 5.1 6.1 5.1 9a5.1 5.1 0 0 1-10.2 0C6.9 10.1 8.9 7.6 12 4z"/>'),
  trash: sv('<path d="M5 7.2h14M10 7.2V4.6h4v2.6M7.2 7.2l.8 12.2h8l.8-12.2M10.2 10.8v5.4M13.8 10.8v5.4"/>'),
  close: sv('<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>'),
  send: sv('<path d="M12 18.5V6M6.6 11.4L12 6l5.4 5.4"/>'),
  check: sv('<path d="M5.5 12.5l4.3 4.3L18.5 8"/>'),
  blocked: sv('<circle cx="12" cy="12" r="8.4"/><path d="M9.2 9.2l5.6 5.6M14.8 9.2l-5.6 5.6"/>'),
  caret: sv('<path d="M9.5 6.5L15 12l-5.5 5.5"/>'),
  logout: sv('<path d="M14 5.5H6.5v13H14"/><path d="M11 12h9M16.8 8.6L20.2 12l-3.4 3.4"/>'),
} as const;

export type IconName = keyof typeof IC;

/** Fills every `[data-ic]` placeholder under `r` with its icon. */
export function fillIcons(r: ParentNode = document) {
  for (const e of Array.from(r.querySelectorAll<HTMLElement>('[data-ic]'))) {
    const name = e.dataset.ic as IconName;
    if (IC[name]) e.innerHTML = IC[name];
  }
}
