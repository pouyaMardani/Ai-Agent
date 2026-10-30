

const ICONS = {
  plus: '<path d="M12 5v14M5 12h14" />',

  search: '<circle cx="11" cy="11" r="6.6" /><path d="M20 20l-4.2-4.2" />',

  send: '<path d="M21 3 10.4 13.6" /><path d="M21 3l-6.4 18-4.2-8.2L2.2 8.6 21 3z" />',

  close: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />',

  check: '<path d="M20 6.5 9.2 17.3 4 12.1" />',

  copy: '<rect x="9" y="9" width="11.5" height="11.5" rx="3" /><path d="M15.5 5.6A2.6 2.6 0 0 0 12.9 3H5.6A2.6 2.6 0 0 0 3 5.6v7.3a2.6 2.6 0 0 0 2.6 2.6" />',

  refresh:
    '<path d="M20 11.5a8 8 0 0 0-13.4-5L4 9" /><path d="M4 4.2v4.9h4.9" /><path d="M4 12.5a8 8 0 0 0 13.4 5L20 15" /><path d="M20 19.8v-4.9h-4.9" />',

  trash:
    '<path d="M4 7h16" /><path d="M9.5 7V5.4A1.5 1.5 0 0 1 11 3.9h2A1.5 1.5 0 0 1 14.5 5.4V7" /><path d="M6.6 7l.8 11.2A2 2 0 0 0 9.4 20h5.2a2 2 0 0 0 2-1.8L17.4 7" /><path d="M10.4 11v5M13.6 11v5" />',

  pencil:
    '<path d="M12.5 19.5H21" /><path d="M16.6 3.9a2.2 2.2 0 0 1 3.1 3.1L7.5 19.2 3.6 20.2l1-3.9L16.6 3.9z" />',

  eraser:
    '<path d="M20.5 20.5H9.6l-5-5a2 2 0 0 1 0-2.8l6.9-6.9a2 2 0 0 1 2.8 0l5 5a2 2 0 0 1 0 2.8L12 19.5" /><path d="M8.6 8.6l6.8 6.8" />',

  sliders:
    '<path d="M4 7h8M16.5 7H20" /><circle cx="14.2" cy="7" r="2.2" /><path d="M4 17h4M12.5 17H20" /><circle cx="10.2" cy="17" r="2.2" />',

  menu: '<path d="M4 7h16M4 12h16M4 17h16" />',

  "chevrons-left": '<path d="M11.5 6.5 6 12l5.5 5.5" /><path d="M18 6.5 12.5 12 18 17.5" />',

  "chevrons-right": '<path d="M12.5 6.5 18 12l-5.5 5.5" /><path d="M6 6.5 11.5 12 6 17.5" />',

  "arrow-down": '<path d="M12 4.8v14.4" /><path d="M5.8 13l6.2 6.2L18.2 13" />',

  sparkle:
    '<path d="M12 3.4l1.7 4.6 4.6 1.7-4.6 1.7L12 16l-1.7-4.6L5.7 9.7l4.6-1.7L12 3.4z" /><path d="M18.6 15.2l.7 1.9 1.9.7-1.9.7-.7 1.9-.7-1.9-1.9-.7 1.9-.7.7-1.9z" />',

  alert:
    '<path d="M10.3 4.1 2.9 17a2 2 0 0 0 1.7 3h14.8a2 2 0 0 0 1.7-3L13.7 4.1a2 2 0 0 0-3.4 0z" /><path d="M12 9.4v4.2" /><path d="M12 17.1h.01" />',

  code: '<path d="M9 8.5 4.5 12 9 15.5" /><path d="M15 8.5 19.5 12 15 15.5" />',

  gauge:
    '<path d="M4 14.4a8 8 0 0 1 16 0" /><path d="M12 14.4 16.4 9.2" /><circle cx="12" cy="14.4" r="1.6" />',
};

export function iconMarkup(name) {
  const body = ICONS[name];
  if (!body) return "";
  if (name === "sparkle") {
    return (
      '<svg class="icon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false" ' +
      'fill="currentColor" stroke="none">' +
      body +
      "</svg>"
    );
  }
  return (
    '<svg class="icon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false" ' +
    'fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' +
    body +
    "</svg>"
  );
}

export function hydrateIcons(root = document) {
  root.querySelectorAll("[data-icon]").forEach((el) => {
    if (el.querySelector("svg")) return;
    el.insertAdjacentHTML("afterbegin", iconMarkup(el.dataset.icon));
  });
}