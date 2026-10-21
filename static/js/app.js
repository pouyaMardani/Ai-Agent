/**
 * Token Harbor Chat - front end.
 *
 * Structure of this file:
 *   1. configuration (themes, prompt suggestions)
 *   2. element lookups
 *   3. state + storage
 *   4. small helpers (time, toasts, clipboard, confirm dialog)
 *   5. rendering (sidebar, thread, empty state, messages)
 *   6. API call
 *   7. actions (send, regenerate, retry, rename, delete, clear)
 *   8. wiring + start-up
 *
 * The backend keeps the API key; this file only ever sends
 * { message, history, model } to POST /api/chat and shows the text it gets
 * back. The model is the one picked in Settings (or the backend default).
 */

import { hydrateIcons, iconMarkup } from "./icons.js";
import { escapeHtml, renderMarkdown } from "./markdown.js";
import {
  LIMITS,
  deriveTitle,
  makeConversation,
  readModel,
  readSidebarState,
  readState,
  readTheme,
  resolveStorage,
  sortConversations,
  uid,
  writeModel,
  writeSidebarState,
  writeState,
  writeTheme,
} from "./store.js";

/* ----------------------------------------------------------- configuration */

/** The four themes. Keep the ids in step with theme-boot.js and style.css. */
const THEMES = [
  {
    id: "midnight",
    name: "Midnight Glass",
    note: "Deep navy with violet light",
    swatches: ["#0b1020", "#7c5cff", "#3fa9ff"],
  },
  {
    id: "aurora",
    name: "Aurora",
    note: "Dark teal and emerald glow",
    swatches: ["#041613", "#14c78f", "#34d8d0"],
  },
  {
    id: "studio",
    name: "Light Studio",
    note: "Bright surfaces, soft depth",
    swatches: ["#f7f9fd", "#5b5bf5", "#0ea5e9"],
  },
  {
    id: "cyberpunk",
    name: "Cyberpunk",
    note: "Magenta and cyan signals",
    swatches: ["#0a0714", "#ff2e88", "#22d3ee"],
  },
];

/** Cards shown on an empty conversation. Clicking one fills the composer. */
const SUGGESTIONS = [
  {
    icon: "sparkle",
    title: "Explain a concept",
    prompt: "Explain how HTTPS keeps a web request private, using a simple everyday analogy.",
  },
  {
    icon: "code",
    title: "Write some code",
    prompt:
      "Write a Python function that reads a CSV file and returns the average of one numeric column. Add a short comment per step.",
  },
  {
    icon: "alert",
    title: "Debug an error",
    prompt: "My FastAPI endpoint returns a 422 error when the browser sends JSON. What are the usual causes?",
  },
  {
    icon: "pencil",
    title: "Polish my writing",
    prompt: "Rewrite this paragraph so it is shorter and clearer:\n\n",
  },
];

/* ------------------------------------------------------------ element refs */

const el = {
  root: document.documentElement,
  sidebar: document.getElementById("sidebar"),
  convList: document.getElementById("conv-list"),
  historyEmpty: document.getElementById("history-empty"),
  searchInput: document.getElementById("search-input"),
  searchClear: document.getElementById("search-clear"),
  newChat: document.getElementById("new-chat-btn"),
  collapse: document.getElementById("collapse-btn"),
  drawer: document.getElementById("drawer-btn"),
  scrim: document.getElementById("scrim"),
  settingsBtn: document.getElementById("settings-btn"),
  statusDot: document.getElementById("status-dot"),
  statusText: document.getElementById("status-text"),
  title: document.getElementById("chat-title"),
  meta: document.getElementById("chat-meta"),
  modelPill: document.getElementById("model-pill"),
  modelName: document.getElementById("model-name"),
  clearBtn: document.getElementById("clear-btn"),
  thread: document.getElementById("thread"),
  threadInner: document.getElementById("thread-inner"),
  scrollBottom: document.getElementById("scroll-bottom"),
  composer: document.getElementById("composer"),
  input: document.getElementById("composer-input"),
  send: document.getElementById("send-btn"),
  counter: document.getElementById("counter"),
  srStatus: document.getElementById("sr-status"),
  settingsDialog: document.getElementById("settings-dialog"),
  themeGrid: document.getElementById("theme-grid"),
  modelGrid: document.getElementById("model-grid"),
  modelNote: document.getElementById("model-note"),
  settingsModel: document.getElementById("settings-model"),
  settingsCount: document.getElementById("settings-count"),
  wipe: document.getElementById("wipe-btn"),
  confirmDialog: document.getElementById("confirm-dialog"),
  confirmTitle: document.getElementById("confirm-title"),
  confirmText: document.getElementById("confirm-text"),
  confirmOk: document.getElementById("confirm-ok"),
  toasts: document.getElementById("toasts"),
};

/* ---------------------------------------------------------- state + setup */

const storage = resolveStorage();
let state = readState(storage);

const ui = {
  busy: false, // a request is in flight -> sending is blocked
  pendingId: null, // conversation waiting for a reply
  editingId: null, // conversation being renamed
  query: "", // sidebar search text
  models: [], // [{ id, label }] offered by the backend
  model: null, // model id the user picked (saved in this browser)
  defaultModel: null, // backend default, used when nothing is saved
  backendOk: false,
};

/** The conversation that is currently on screen. */
function activeConversation() {
  return state.conversations.find((conversation) => conversation.id === state.activeId) || null;
}

/** Persist the whole state (conversations, active chat, sizes are capped). */
function persist() {
  writeState(storage, state);
}

/** `2m ago`, `3h ago`, `5d ago`, or a date for anything older. */
function formatWhen(timestamp) {
  const diff = Date.now() - Number(timestamp || 0);
  const minute = 60000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return "just now";
  if (diff < hour) return Math.round(diff / minute) + "m ago";
  if (diff < day) return Math.round(diff / hour) + "h ago";
  if (diff < 7 * day) return Math.round(diff / day) + "d ago";
  return new Date(timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Clock time for the message header. */
function formatClock(timestamp) {
  return new Date(timestamp).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/** Themes that expect light form controls and light browser chrome. */
const LIGHT_THEMES = new Set(["studio"]);

/** Announce a change to screen readers without re-rendering the whole thread. */
function announce(text) {
  el.srStatus.textContent = text;
}

/** Small transient message in the corner. Text only, never markup. */
function toast(message, kind = "info") {
  const node = document.createElement("div");
  node.className = "toast toast--" + kind;

  const glyph = document.createElement("span");
  glyph.className = "toast__glyph";
  glyph.innerHTML = iconMarkup(kind === "error" ? "alert" : "check");

  const text = document.createElement("span");
  text.className = "toast__text";
  text.textContent = message;

  node.append(glyph, text);
  el.toasts.appendChild(node);

  window.setTimeout(() => node.classList.add("is-leaving"), 2600);
  window.setTimeout(() => node.remove(), 3050);
}

function prefersReducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Copy text with a fallback for browsers where the async clipboard API is
 * unavailable. Returns true when something landed on the clipboard.
 */
async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (error) {
    /* fall through to the older approach below */
  }

  try {
    const helper = document.createElement("textarea");
    helper.value = text;
    helper.setAttribute("readonly", "");
    helper.style.position = "fixed";
    helper.style.top = "-1000px";
    helper.style.opacity = "0";
    document.body.appendChild(helper);
    helper.select();
    const done = document.execCommand("copy");
    helper.remove();
    return done;
  } catch (error) {
    return false;
  }
}

/**
 * Promise-based confirmation built on <dialog>, so Escape and the focus trap
 * come from the browser instead of hand-written code.
 * @returns {Promise<boolean>} true when the user confirmed
 */
function showConfirm(options) {
  return new Promise((resolve) => {
    el.confirmTitle.textContent = options.title || "Are you sure?";
    el.confirmText.textContent = options.body || "";
    el.confirmOk.textContent = options.confirmLabel || "Delete";
    el.confirmOk.className = "btn " + (options.danger === false ? "btn--primary" : "btn--danger");

    const finish = () => {
      el.confirmDialog.removeEventListener("close", finish);
      resolve(el.confirmDialog.returnValue === "ok");
    };

    // A <dialog> remembers its last returnValue, and closing with Escape does
    // not reset it. Starting every round from "cancel" means Escape (or the X)
    // can never be mistaken for a confirmation.
    el.confirmDialog.returnValue = "cancel";
    if (el.confirmDialog.open) el.confirmDialog.close();

    el.confirmDialog.addEventListener("close", finish);
    el.confirmDialog.showModal();
  });
}

/** Reflect the backend/model state in the sidebar and the top bar. */
function setBackendStatus(ok, text) {
  ui.backendOk = ok;
  el.statusDot.className = "status-dot" + (ok ? " is-ok" : " is-bad");
  el.statusText.textContent = text;
  el.modelPill.classList.toggle("is-offline", !ok);
}

/* --------------------------------------------------------------- themes */

function renderThemeGrid() {
  el.themeGrid.innerHTML = THEMES.map((theme) => {
    const swatches = theme.swatches
      .map((color) => '<span style="background:' + color + '"></span>')
      .join("");
    return (
      '<label class="theme-option" data-theme-option="' +
      theme.id +
      '">' +
      '<input class="sr-only" type="radio" name="theme" value="' +
      theme.id +
      '" />' +
      '<span class="theme-option__swatches" aria-hidden="true">' +
      swatches +
      "</span>" +
      '<span class="theme-option__text">' +
      '<span class="theme-option__name">' +
      escapeHtml(theme.name) +
      "</span>" +
      '<span class="theme-option__note">' +
      escapeHtml(theme.note) +
      "</span>" +
      "</span>" +
      '<span class="theme-option__check" aria-hidden="true">' +
      iconMarkup("check") +
      "</span>" +
      "</label>"
    );
  }).join("");
}

/** Apply a theme, remember it, and update the radio group. */
function applyTheme(id, options = {}) {
  const theme = THEMES.find((item) => item.id === id) || THEMES[0];
  const changed = el.root.getAttribute("data-theme") !== theme.id;

  el.root.setAttribute("data-theme", theme.id);
  writeTheme(storage, theme.id);

  const schemeMeta = document.querySelector('meta[name="color-scheme"]');
  if (schemeMeta) schemeMeta.setAttribute("content", LIGHT_THEMES.has(theme.id) ? "light" : "dark");

  el.themeGrid.querySelectorAll("[data-theme-option]").forEach((node) => {
    const selected = node.dataset.themeOption === theme.id;
    node.classList.toggle("is-selected", selected);
    const input = node.querySelector("input");
    if (input) input.checked = selected;
  });

  // A short pulse of the ambient light hides the instant gradient swap.
  if (changed && options.animate !== false && !prefersReducedMotion()) {
    el.root.classList.add("is-theme-shifting");
    window.setTimeout(() => el.root.classList.remove("is-theme-shifting"), 640);
  }
}

/* --------------------------------------------------------------- models */

/** Read {"id", "label"} pairs from /api/config, dropping anything malformed. */
function normaliseModels(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const models = [];
  raw.forEach((item) => {
    if (!item || typeof item !== "object") return;
    const id = typeof item.id === "string" ? item.id.trim() : "";
    if (!id || seen.has(id)) return;
    const label = typeof item.label === "string" && item.label.trim() ? item.label.trim() : id;
    seen.add(id);
    models.push({ id, label });
  });
  return models;
}

/** The configured model with this id, or null when it is not offered. */
function modelById(id) {
  if (!id) return null;
  return ui.models.find((item) => item.id === id) || null;
}

/** The model that will answer: the saved pick, else the backend default. */
function effectiveModel() {
  return modelById(ui.model) || modelById(ui.defaultModel) || ui.models[0] || null;
}

/** Two letters for the badge on a model card: "MiMo v2.6" -> "MI". */
function modelBadge(label) {
  const firstWord = String(label || "").trim().split(/\s+/)[0] || "";
  const letters = firstWord.replace(/[^A-Za-z0-9]/g, "").slice(0, 2).toUpperCase();
  return letters || "AI";
}

/** Explain the model group while the list cannot be used (yet). */
function renderModelPlaceholder(text) {
  el.modelGrid.innerHTML = '<p class="model-grid__empty">' + escapeHtml(text) + "</p>";
  el.modelNote.hidden = true;
}

/** One radio card per model the backend offers. */
function renderModelGrid() {
  if (!ui.models.length) {
    renderModelPlaceholder(
      "No model is configured. Add DEEPSEEK and MIMO to the .env file, then restart the server."
    );
    return;
  }

  el.modelGrid.innerHTML = ui.models
    .map((model) => {
      const id = escapeHtml(model.id);
      return (
        '<label class="theme-option" data-model-option="' +
        id +
        '">' +
        '<input class="sr-only" type="radio" name="model" value="' +
        id +
        '" />' +
        '<span class="model-option__badge" aria-hidden="true">' +
        escapeHtml(modelBadge(model.label)) +
        "</span>" +
        '<span class="theme-option__text">' +
        '<span class="theme-option__name">' +
        escapeHtml(model.label) +
        "</span>" +
        '<span class="theme-option__note">' +
        id +
        "</span>" +
        "</span>" +
        '<span class="theme-option__check" aria-hidden="true">' +
        iconMarkup("check") +
        "</span>" +
        "</label>"
      );
    })
    .join("");
}

/** Tick the active card, and explain a saved model the backend no longer has. */
function syncModelGrid() {
  const active = effectiveModel();
  const saved = modelById(ui.model);

  el.modelGrid.querySelectorAll("[data-model-option]").forEach((node) => {
    const selected = Boolean(active) && node.dataset.modelOption === active.id;
    node.classList.toggle("is-selected", selected);
    const input = node.querySelector("input");
    if (input) input.checked = selected;
  });

  if (ui.model && !saved && active) {
    el.modelNote.textContent =
      "The model saved in this browser (" +
      ui.model +
      ") is not offered by the server any more, so " +
      active.label +
      " is used instead.";
    el.modelNote.hidden = false;
  } else {
    el.modelNote.hidden = true;
  }
}

/** Show the active model in the top-bar pill and in the Connection list. */
function updateModelUi() {
  const active = effectiveModel();

  if (!ui.backendOk) {
    el.modelName.textContent = "offline";
    el.settingsModel.textContent = "unavailable";
    el.modelPill.title = "The Python backend is unreachable";
    return;
  }

  el.modelName.textContent = active ? active.label : "not set";
  el.settingsModel.textContent = active ? active.id : "not set in .env";
  el.modelPill.title = active
    ? "Model: " + active.id + " - click to change it in Settings"
    : "No model configured yet";
}

/** Use the model the user picked; the choice is remembered in this browser. */
function applyModel(id, options = {}) {
  const model = modelById(id);
  if (!model) return; // only ids the backend offers can be selected

  const changed = ui.model !== model.id;
  ui.model = model.id;
  writeModel(storage, model.id);

  syncModelGrid();
  updateModelUi();
  if (changed && options.notify !== false) toast("Model set to " + model.label, "info");
}

/* --------------------------------------------------------------- scroll */

function isNearBottom() {
  const distance = el.thread.scrollHeight - el.thread.scrollTop - el.thread.clientHeight;
  return distance < 120;
}

function scrollThreadToBottom(behavior = "smooth") {
  if (behavior === "smooth" && prefersReducedMotion()) behavior = "auto";
  el.thread.scrollTo({ top: el.thread.scrollHeight, behavior });
}

/** Show the "jump to latest" button only when the newest message is off screen. */
function updateScrollButton() {
  const conversation = activeConversation();
  const hasMessages = Boolean(conversation && conversation.messages.length);
  el.scrollBottom.hidden = !hasMessages || isNearBottom();
}

/* ------------------------------------------------------------ rendering */

/** First letter of a title, used for the small square badge. */
function monogram(title) {
  const first = String(title || "").trim().charAt(0);
  return first ? first.toUpperCase() : "#";
}

/** "3 messages . 2m ago" - shown under each sidebar title. */
function conversationMeta(conversation) {
  const count = conversation.messages.length;
  const label = count === 0 ? "empty" : count === 1 ? "1 message" : count + " messages";
  return formatWhen(conversation.updatedAt) + " \u00B7 " + label;
}

/** One sidebar row: a main button plus rename and delete actions. */
function conversationRow(conversation) {
  const item = document.createElement("li");
  item.className = "conv";
  item.dataset.id = conversation.id;
  if (conversation.id === state.activeId) item.classList.add("is-active");
  if (conversation.id === ui.pendingId) item.classList.add("is-pending");
  if (conversation.id === ui.editingId) item.classList.add("is-editing");

  const main = document.createElement("button");
  main.type = "button";
  main.className = "conv__main";
  main.dataset.action = "open";
  main.title = conversation.title;
  if (conversation.id === state.activeId) main.setAttribute("aria-current", "true");

  const badge = document.createElement("span");
  badge.className = "conv__monogram";
  badge.setAttribute("aria-hidden", "true");
  badge.textContent = monogram(conversation.title);

  const text = document.createElement("span");
  text.className = "conv__text";
  const title = document.createElement("span");
  title.className = "conv__title";
  title.textContent = conversation.title;
  const meta = document.createElement("span");
  meta.className = "conv__meta";
  if (conversation.id === ui.pendingId) {
    const pulse = document.createElement("span");
    pulse.className = "conv__pulse";
    pulse.setAttribute("aria-hidden", "true");
    meta.appendChild(pulse);
  }
  meta.appendChild(document.createTextNode(conversationMeta(conversation)));
  text.append(title, meta);
  main.append(badge, text);

  const actions = document.createElement("div");
  actions.className = "conv__actions";

  const rename = document.createElement("button");
  rename.type = "button";
  rename.className = "icon-btn icon-btn--tiny";
  rename.dataset.action = "rename";
  rename.title = "Rename";
  rename.setAttribute("aria-label", "Rename " + conversation.title);
  rename.innerHTML = iconMarkup("pencil");

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "icon-btn icon-btn--tiny";
  remove.dataset.action = "delete";
  remove.title = "Delete";
  remove.setAttribute("aria-label", "Delete " + conversation.title);
  remove.innerHTML = iconMarkup("trash");

  actions.append(rename, remove);
  item.append(main, actions);

  // Rename mode swaps the row for a text field (Enter saves, Escape cancels).
  if (conversation.id === ui.editingId) {
    const input = document.createElement("input");
    input.type = "text";
    input.className = "conv__input";
    input.value = conversation.title;
    input.maxLength = 80;
    input.dataset.action = "rename-input";
    input.setAttribute("aria-label", "Conversation title");
    item.appendChild(input);
  }

  return item;
}

/** Conversations matching the search box, newest first. */
function visibleConversations() {
  const query = ui.query.trim().toLowerCase();
  const sorted = sortConversations(state.conversations);
  if (!query) return sorted;
  return sorted.filter((conversation) => conversation.title.toLowerCase().includes(query));
}

function renderConversations() {
  const items = visibleConversations();
  el.convList.innerHTML = "";
  items.forEach((conversation) => el.convList.appendChild(conversationRow(conversation)));

  if (items.length === 0) {
    el.historyEmpty.hidden = false;
    el.historyEmpty.textContent = ui.query
      ? "No conversations match \u201C" + ui.query + "\u201D."
      : "No conversations yet. Use New chat to start one.";
  } else {
    el.historyEmpty.hidden = true;
  }

  el.searchClear.hidden = ui.query.length === 0;
  el.settingsCount.textContent = String(state.conversations.length);
}

/** Title, subtitle and page title of the top bar. */
function renderTopbar() {
  const conversation = activeConversation();
  const title = conversation ? conversation.title : "New chat";
  el.title.textContent = title;
  document.title = title + " \u00B7 Token Harbor Chat";

  if (conversation && conversation.messages.length > 0) {
    const turns = conversation.messages.filter((message) => message.role === "user").length;
    el.meta.textContent =
      (turns === 1 ? "1 message" : turns + " messages") + " \u00B7 updated " + formatWhen(conversation.updatedAt);
  } else {
    el.meta.textContent = "Ready when you are";
  }
}

/** Hero + suggested prompts for a conversation with no messages. */
function renderEmptyState() {
  const wrap = document.createElement("div");
  wrap.className = "empty";

  const mark = document.createElement("div");
  mark.className = "empty__mark";
  mark.dataset.icon = "sparkle";
  mark.setAttribute("aria-hidden", "true");

  const title = document.createElement("h2");
  title.className = "empty__title";
  title.textContent = "How can I help today?";

  const note = document.createElement("p");
  note.className = "empty__note";
  note.textContent =
    "Ask a question, paste an error message, or start from a suggestion below. Conversations are stored in this browser only.";

  const grid = document.createElement("div");
  grid.className = "suggestions";

  SUGGESTIONS.forEach((item) => {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "suggestion";
    card.dataset.action = "suggestion";
    card.dataset.prompt = item.prompt;

    const icon = document.createElement("span");
    icon.className = "suggestion__icon";
    icon.innerHTML = iconMarkup(item.icon);

    const body = document.createElement("span");
    body.className = "suggestion__body";
    const heading = document.createElement("span");
    heading.className = "suggestion__title";
    heading.textContent = item.title;
    const preview = document.createElement("span");
    preview.className = "suggestion__text";
    preview.textContent = item.prompt.replace(/\s+/g, " ").trim().slice(0, 110);
    body.append(heading, preview);

    card.append(icon, body);
    grid.appendChild(card);
  });

  wrap.append(mark, title, note, grid);
  return wrap;
}

/** Copy for every answer, plus Regenerate on the newest one. */
function messageActions(isLast) {
  const actions = document.createElement("div");
  actions.className = "msg__actions";

  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "msg__action";
  copy.dataset.action = "copy-message";
  copy.title = "Copy this answer";
  copy.innerHTML = iconMarkup("copy") + "<span>Copy</span>";
  actions.appendChild(copy);

  if (isLast && !ui.busy) {
    const again = document.createElement("button");
    again.type = "button";
    again.className = "msg__action";
    again.dataset.action = "regenerate";
    again.title = "Ask the model again";
    again.innerHTML = iconMarkup("refresh") + "<span>Regenerate</span>";
    actions.appendChild(again);
  }

  return actions;
}

/** One message row: assistant panel with markdown, or a user bubble. */
function renderMessage(conversation, message, index) {
  const row = document.createElement("article");
  row.className = "msg msg--" + message.role;
  row.dataset.id = message.id;

  const isLast = index === conversation.messages.length - 1;

  if (message.role === "user") {
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    // textContent: the user's own words stay literal text, never markup
    bubble.textContent = message.content;
    row.appendChild(bubble);
    return row;
  }

  const avatar = document.createElement("div");
  avatar.className = "msg__avatar";
  avatar.dataset.icon = "sparkle";
  avatar.setAttribute("aria-hidden", "true");

  const body = document.createElement("div");
  body.className = "msg__body";

  const meta = document.createElement("div");
  meta.className = "msg__meta";
  const author = document.createElement("span");
  author.className = "msg__author";
  author.textContent = "Token Harbor";
  const clock = document.createElement("span");
  clock.textContent = formatClock(message.at);
  meta.append(author, clock);
  body.appendChild(meta);

  if (message.error === true) {
    const error = document.createElement("div");
    error.className = "msg__error";
    error.innerHTML = iconMarkup("alert");
    const text = document.createElement("p");
    text.textContent = message.detail || "Something went wrong. Please try again.";
    error.appendChild(text);

    if (isLast && !ui.busy) {
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "btn btn--quiet msg__retry";
      retry.dataset.action = "retry";
      retry.innerHTML = iconMarkup("refresh") + "<span>Retry</span>";
      error.appendChild(retry);
    }
    body.appendChild(error);
  } else {
    const panel = document.createElement("div");
    panel.className = "msg__panel md";
    panel.innerHTML = renderMarkdown(message.content); // sanitised by markdown.js
    body.append(panel, messageActions(isLast));
  }

  row.append(avatar, body);
  return row;
}

/** "Token Harbor is thinking" row with three animated dots. */
function renderTyping() {
  const row = document.createElement("div");
  row.className = "msg msg--assistant";

  const avatar = document.createElement("div");
  avatar.className = "msg__avatar";
  avatar.dataset.icon = "sparkle";
  avatar.setAttribute("aria-hidden", "true");

  const holder = document.createElement("div");
  holder.className = "typing";
  holder.innerHTML =
    '<span class="typing__dots" aria-hidden="true"><span></span><span></span><span></span></span>';

  const label = document.createElement("span");
  label.className = "typing__label";
  label.textContent = "Token Harbor is thinking...";
  holder.appendChild(label);

  row.append(avatar, holder);
  return row;
}

/**
 * Paint the thread for the active conversation.
 * @param {{scroll?: "bottom"|"smooth"|"preserve"}} options
 */
function renderThread(options = {}) {
  const conversation = activeConversation();
  const previousScroll = el.thread.scrollTop;
  const mode = options.scroll || "bottom";

  el.threadInner.innerHTML = "";

  if (!conversation || conversation.messages.length === 0) {
    el.threadInner.appendChild(renderEmptyState());
  } else {
    conversation.messages.forEach((message, index) => {
      el.threadInner.appendChild(renderMessage(conversation, message, index));
    });
  }

  const waiting = Boolean(ui.busy && conversation && ui.pendingId === conversation.id);
  if (waiting) el.threadInner.appendChild(renderTyping());
  el.thread.setAttribute("aria-busy", waiting ? "true" : "false");

  // Elements built with `dataset.icon` get their SVG here.
  hydrateIcons(el.threadInner);

  if (mode === "preserve") el.thread.scrollTop = previousScroll;
  else if (mode === "smooth") scrollThreadToBottom("smooth");
  else scrollThreadToBottom("auto");

  updateScrollButton();
}

/** Repaint the sidebar, the top bar and the thread in one go. */
function renderAll(options = {}) {
  renderConversations();
  renderTopbar();
  renderThread(options);
}

/* -------------------------------------------------------------- composer */

/** Grow the textarea with its content, up to the CSS max-height. */
function autoGrow() {
  el.input.style.height = "auto";
  el.input.style.height = Math.min(el.input.scrollHeight, 220) + "px";
}

/** Character counter - hidden while the box is empty so it stays quiet. */
function updateCounter() {
  const length = el.input.value.length;
  el.counter.textContent = length === 0 ? "" : length.toLocaleString() + " characters";
}

/** Block a second send and show the spinner while a request is running. */
function setBusy(busy) {
  ui.busy = busy;
  el.send.disabled = busy;
  el.send.classList.toggle("is-loading", busy);
  el.send.setAttribute("aria-busy", busy ? "true" : "false");
}

function focusComposer() {
  if (el.input.disabled) return;
  el.input.focus();
}

/* ----------------------------------------------------------------- the API */

/**
 * History payload for one conversation, ending just before `userIndex`.
 * The newest user message travels separately because the backend appends it
 * last, and only the last 40 valid entries are sent (same cap as the server).
 */
function historyPayload(conversation, userIndex) {
  return conversation.messages
    .slice(0, userIndex)
    .slice(-LIMITS.historySentToApi)
    .filter((item) => (item.role === "user" || item.role === "assistant") && item.content.trim())
    .map((item) => ({ role: item.role, content: item.content }));
}

/**
 * Ask the backend for a reply to messages[userIndex] and store the answer.
 * Errors become a friendly assistant message with a Retry action.
 */
async function requestReply(conversationId, userIndex) {
  const conversation = state.conversations.find((item) => item.id === conversationId);
  const userMessage = conversation ? conversation.messages[userIndex] : null;
  if (!conversation || !userMessage) return;

  ui.pendingId = conversationId;
  setBusy(true);
  announce("Token Harbor is thinking");
  renderConversations();
  if (state.activeId === conversationId) renderThread({ scroll: "smooth" });

  let reply = null;
  let failure = null;

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: userMessage.content,
        history: historyPayload(conversation, userIndex),
        // The model chosen in Settings; "" lets the server use its default.
        model: ui.model || "",
      }),
    });

    let data = null;
    try {
      data = await response.json();
    } catch (error) {
      data = null; // an empty or non-JSON body is treated as a failure below
    }

    if (!response.ok) {
      throw new Error((data && data.detail) || "The server could not answer. Please try again.");
    }
    reply =
      data && typeof data.reply === "string" && data.reply.trim()
        ? data.reply
        : "(The model returned an empty response.)";
  } catch (error) {
    failure = error && error.message ? error.message : "Something went wrong. Please try again.";
  }

  // The answer belongs to the conversation that asked for it, even if the
  // user switched chats while it was loading.
  const target = state.conversations.find((item) => item.id === conversationId);
  if (target) {
    if (failure) {
      target.messages.push({
        id: uid("m"),
        role: "assistant",
        content: failure,
        detail: failure,
        error: true,
        at: Date.now(),
      });
      announce("The request failed");
      toast(failure, "error");
    } else {
      target.messages.push({ id: uid("m"), role: "assistant", content: reply, at: Date.now() });
      announce("Answer received");
    }
    target.updatedAt = Date.now();
  }

  ui.pendingId = null;
  setBusy(false);
  persist();
  renderAll({ scroll: "smooth" });
  focusComposer();
}

/* ---------------------------------------------------------------- actions */

/** Send whatever is in the composer (Enter or the send button). */
async function sendMessage() {
  const conversation = activeConversation();
  const text = el.input.value.trim();
  if (!conversation || ui.busy || !text) return; // no empty sends, no double sends

  el.input.value = "";
  autoGrow();
  updateCounter();

  const userMessage = { id: uid("m"), role: "user", content: text, at: Date.now() };
  conversation.messages.push(userMessage);

  // The first user message becomes the conversation title.
  const isFirstTurn = conversation.messages.filter((message) => message.role === "user").length === 1;
  if (isFirstTurn) conversation.title = deriveTitle(text);
  conversation.updatedAt = userMessage.at;
  persist();

  renderAll({ scroll: "smooth" });
  await requestReply(conversation.id, conversation.messages.length - 1);
}

/** New chat. An existing empty chat is reused instead of piling up blanks. */
function newChat() {
  const emptyChat = state.conversations.find((conversation) => conversation.messages.length === 0);
  let conversation = emptyChat;

  if (!conversation) {
    conversation = makeConversation();
    state.conversations.push(conversation);
  }

  state.activeId = conversation.id;
  ui.editingId = null;
  ui.query = "";
  el.searchInput.value = "";
  persist();
  renderAll({ scroll: "bottom" });
  closeDrawer();
  focusComposer();
}

/** Show another conversation. */
function selectConversation(id) {
  if (state.activeId !== id) {
    state.activeId = id;
    ui.editingId = null;
    persist();
    renderAll({ scroll: "bottom" });
  }
  closeDrawer();
}

/** Rename mode: swap the row for a text field. */
function startRename(id) {
  ui.editingId = id;
  renderConversations();
  const input = el.convList.querySelector('[data-action="rename-input"]');
  if (input) {
    input.focus();
    input.select();
  }
}

/** Save a new title (empty input keeps the old one). */
function commitRename(id, value) {
  const conversation = state.conversations.find((item) => item.id === id);
  const title = value.trim().slice(0, 80);
  ui.editingId = null;

  if (conversation && title) {
    conversation.title = title;
    persist();
    toast("Conversation renamed");
  }
  renderAll({ scroll: "preserve" });
}

function cancelRename() {
  ui.editingId = null;
  renderConversations();
}

/** Delete one conversation after a confirmation. */
async function deleteConversation(id) {
  const conversation = state.conversations.find((item) => item.id === id);
  if (!conversation) return;

  const ok = await showConfirm({
    title: "Delete this conversation?",
    body:
      "\u201C" + conversation.title + "\u201D and its " + conversation.messages.length +
      " stored messages will be removed from this browser. This cannot be undone.",
    confirmLabel: "Delete",
  });
  if (!ok) return;

  state.conversations = state.conversations.filter((item) => item.id !== id);
  if (state.conversations.length === 0) state.conversations.push(makeConversation());
  if (state.activeId === id) state.activeId = sortConversations(state.conversations)[0].id;
  if (ui.editingId === id) ui.editingId = null;

  persist();
  renderAll({ scroll: "bottom" });
  toast("Conversation deleted");
}

/** Clear only the active conversation (its title stays). */
async function clearConversation() {
  const conversation = activeConversation();
  if (!conversation) return;

  if (conversation.messages.length === 0) {
    toast("This conversation is already empty");
    return;
  }

  const ok = await showConfirm({
    title: "Clear this conversation?",
    body: "Every message in \u201C" + conversation.title + "\u201D will be removed. The title is kept.",
    confirmLabel: "Clear",
  });
  if (!ok) return;

  conversation.messages = [];
  conversation.updatedAt = Date.now();
  persist();
  renderAll({ scroll: "bottom" });
  focusComposer();
  toast("Conversation cleared");
}

/** Delete every conversation stored in this browser. */
async function wipeAllConversations() {
  const ok = await showConfirm({
    title: "Delete all conversations?",
    body: "All conversations saved in this browser will be removed and one empty chat will remain. This cannot be undone.",
    confirmLabel: "Delete all",
  });
  if (!ok) return;

  state.conversations = [makeConversation()];
  state.activeId = state.conversations[0].id;
  ui.editingId = null;
  ui.query = "";
  el.searchInput.value = "";
  persist();
  renderAll({ scroll: "bottom" });
  el.settingsDialog.close();
  toast("All conversations deleted");
}

/**
 * Drop the newest answer and ask again - used by both Regenerate and Retry,
 * because in both cases the user message is already the last one after the
 * answer (or error message) is removed.
 */
async function rerunLastTurn() {
  const conversation = activeConversation();
  if (!conversation || ui.busy) return;

  const last = conversation.messages[conversation.messages.length - 1];
  if (!last || last.role !== "assistant") return;

  conversation.messages.pop();
  const userIndex = conversation.messages.length - 1;
  const userMessage = conversation.messages[userIndex];
  if (!userMessage || userMessage.role !== "user") {
    renderAll({ scroll: "preserve" });
    return;
  }

  persist();
  renderAll({ scroll: "preserve" });
  await requestReply(conversation.id, userIndex);
}

/* ---------------------------------------------------------- sidebar shell */

/** Slide the drawer in (small screens only). */
function openDrawer() {
  if (!window.matchMedia("(max-width: 900px)").matches) return;
  el.root.setAttribute("data-drawer", "open");
  el.scrim.hidden = false;
  el.drawer.setAttribute("aria-expanded", "true");
}

function closeDrawer() {
  if (!el.root.hasAttribute("data-drawer")) return;
  el.root.removeAttribute("data-drawer");
  el.scrim.hidden = true;
  el.drawer.setAttribute("aria-expanded", "false");
}

function updateCollapseButton() {
  const collapsed = el.root.getAttribute("data-sidebar") === "collapsed";
  const name = collapsed ? "chevrons-right" : "chevrons-left";
  el.collapse.dataset.icon = name;
  el.collapse.innerHTML = iconMarkup(name);
  const label = collapsed ? "Expand sidebar" : "Collapse sidebar";
  el.collapse.setAttribute("aria-label", label);
  el.collapse.title = label;
}

/** Desktop: switch between the wide sidebar and the icons-only rail. */
function toggleSidebar() {
  const collapsed = el.root.getAttribute("data-sidebar") === "collapsed";
  const next = collapsed ? "expanded" : "collapsed";
  el.root.setAttribute("data-sidebar", next);
  writeSidebarState(storage, next);
  updateCollapseButton();
}

/* ------------------------------------------------------- event delegation */

/** Sidebar rows: open, rename or delete. */
function onConversationListClick(event) {
  const row = event.target.closest(".conv");
  if (!row) return;
  const trigger = event.target.closest("[data-action]");
  const name = trigger ? trigger.dataset.action : "open";

  if (name === "open") selectConversation(row.dataset.id);
  else if (name === "rename") startRename(row.dataset.id);
  else if (name === "delete") deleteConversation(row.dataset.id);
}

/** Enter saves a rename, Escape throws it away. */
function onConversationListKeydown(event) {
  const input = event.target.closest('[data-action="rename-input"]');
  if (!input) return;
  const row = input.closest(".conv");
  if (!row) return;

  if (event.key === "Enter") {
    event.preventDefault();
    commitRename(row.dataset.id, input.value);
  } else if (event.key === "Escape") {
    event.preventDefault();
    cancelRename();
  }
}

/** Clicking away also saves the new title. */
function onConversationListFocusOut(event) {
  const input = event.target.closest('[data-action="rename-input"]');
  if (!input) return;
  const row = input.closest(".conv");
  if (!row) return;
  if (ui.editingId === row.dataset.id) commitRename(row.dataset.id, input.value);
}

/** Briefly swap a button label to confirm a copy. */
function markActionDone(button, label) {
  const text = button.querySelector("span");
  if (!text) return;
  const original = text.textContent;
  button.classList.add("is-done");
  text.textContent = label;
  window.setTimeout(() => {
    button.classList.remove("is-done");
    text.textContent = original;
  }, 1600);
}

/** Suggested prompt, Copy, Regenerate and Retry inside the thread. */
async function onThreadClick(event) {
  const trigger = event.target.closest("[data-action]");
  if (!trigger) return;
  const action = trigger.dataset.action;

  if (action === "suggestion") {
    el.input.value = trigger.dataset.prompt || "";
    autoGrow();
    updateCounter();
    focusComposer();
    const end = el.input.value.length;
    el.input.setSelectionRange(end, end);
    toast("Prompt added - press Enter to send");
    return;
  }

  if (action === "copy-message") {
    const row = trigger.closest(".msg");
    const conversation = activeConversation();
    const message =
      conversation && row ? conversation.messages.find((item) => item.id === row.dataset.id) : null;
    if (!message) return;
    const ok = await copyText(message.content);
    markActionDone(trigger, ok ? "Copied" : "Failed");
    toast(ok ? "Answer copied" : "Copying is blocked by the browser", ok ? "info" : "error");
    return;
  }

  if (action === "regenerate" || action === "retry") {
    await rerunLastTurn();
  }
}

/** Copy buttons inside rendered code blocks. */
async function onThreadCopyCode(event) {
  const button = event.target.closest("[data-copy-code]");
  if (!button) return;
  const block = button.closest(".code-block");
  const code = block ? block.querySelector("pre code") : null;
  if (!code) return;

  const ok = await copyText(code.textContent);
  markActionDone(button, ok ? "Copied" : "Failed");
  toast(ok ? "Code copied" : "Copying is blocked by the browser", ok ? "info" : "error");
}

/** Spotlight that follows the pointer across a suggestion card. */
function onSuggestionPointerMove(event) {
  const card = event.target.closest(".suggestion");
  if (!card || event.pointerType === "touch") return;
  const rect = card.getBoundingClientRect();
  card.style.setProperty("--mx", event.clientX - rect.left + "px");
  card.style.setProperty("--my", event.clientY - rect.top + "px");
}

/** Keyboard shortcuts that do not get in the way of typing. */
function onShortcuts(event) {
  const key = event.key.toLowerCase();
  const withModifier = event.ctrlKey || event.metaKey;

  if (withModifier && key === "k") {
    event.preventDefault();
    if (el.root.getAttribute("data-sidebar") === "collapsed" && !window.matchMedia("(max-width: 900px)").matches) {
      toggleSidebar();
    }
    el.searchInput.focus();
    el.searchInput.select();
    return;
  }

  if (withModifier && event.shiftKey && key === "o") {
    event.preventDefault();
    newChat();
    return;
  }

  if (event.key === "Escape") {
    if (ui.editingId) {
      cancelRename();
      return;
    }
    if (el.root.hasAttribute("data-drawer")) {
      closeDrawer();
      return;
    }
    if (el.settingsDialog.open) el.settingsDialog.close();
  }
}

/* -------------------------------------------------------------- start-up */

/** Ask the backend which models are configured (never the API key). */
async function loadConfig() {
  try {
    const response = await fetch("/api/config");
    if (!response.ok) throw new Error("config unavailable");
    const data = await response.json();

    ui.models = normaliseModels(data && data.models);
    if (!ui.models.length && data && typeof data.model === "string" && data.model.trim()) {
      // A backend that still reports one model name instead of a list.
      ui.models = [{ id: data.model.trim(), label: data.model.trim() }];
    }

    const reported =
      data && typeof data.default_model === "string" && data.default_model.trim()
        ? data.default_model.trim()
        : ui.models.length
          ? ui.models[0].id
          : "";
    ui.defaultModel = reported || null;

    // A model saved in this browser wins, as long as the backend still has it.
    const saved = readModel(storage);
    ui.model = modelById(saved) ? saved : ui.defaultModel;

    renderModelGrid();
    syncModelGrid();
    setBackendStatus(true, "Backend connected");
    updateModelUi(); // after the status, so the pill shows the model
  } catch (error) {
    ui.models = [];
    ui.model = null;
    ui.defaultModel = null;
    renderModelPlaceholder("The Python backend is unreachable, so the model list cannot be loaded.");
    setBackendStatus(false, "Backend unreachable");
    updateModelUi();
  }
}

function openSettings() {
  // The list is cached from start-up; re-tick it in case anything moved.
  syncModelGrid();
  updateModelUi();
  el.settingsCount.textContent = String(state.conversations.length);
  if (typeof el.settingsDialog.showModal === "function") el.settingsDialog.showModal();
  else el.settingsDialog.setAttribute("open", "");
}

function wireEvents() {
  // ---- composer ----
  el.composer.addEventListener("submit", (event) => {
    event.preventDefault();
    sendMessage();
  });

  el.input.addEventListener("input", () => {
    autoGrow();
    updateCounter();
  });

  el.input.addEventListener("keydown", (event) => {
    // Enter sends, Shift+Enter adds a line. isComposing keeps IME input intact.
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      sendMessage();
    }
  });

  // ---- sidebar ----
  el.newChat.addEventListener("click", newChat);
  el.collapse.addEventListener("click", toggleSidebar);
  el.drawer.addEventListener("click", openDrawer);
  el.scrim.addEventListener("click", closeDrawer);
  el.settingsBtn.addEventListener("click", openSettings);
  el.modelPill.addEventListener("click", openSettings); // the pill opens Settings too
  el.wipe.addEventListener("click", wipeAllConversations);

  el.convList.addEventListener("click", onConversationListClick);
  el.convList.addEventListener("keydown", onConversationListKeydown);
  el.convList.addEventListener("focusout", onConversationListFocusOut);

  el.searchInput.addEventListener("input", () => {
    ui.query = el.searchInput.value;
    renderConversations();
  });

  el.searchClear.addEventListener("click", () => {
    el.searchInput.value = "";
    ui.query = "";
    renderConversations();
    el.searchInput.focus();
  });

  // ---- thread ----
  el.threadInner.addEventListener("click", (event) => {
    onThreadCopyCode(event);
    onThreadClick(event);
  });
  el.threadInner.addEventListener("pointermove", onSuggestionPointerMove);
  el.thread.addEventListener("scroll", updateScrollButton, { passive: true });
  el.scrollBottom.addEventListener("click", () => scrollThreadToBottom("smooth"));
  el.clearBtn.addEventListener("click", clearConversation);

  // ---- settings ----
  el.themeGrid.addEventListener("change", (event) => {
    if (event.target && event.target.name === "theme") applyTheme(event.target.value);
  });

  el.modelGrid.addEventListener("change", (event) => {
    if (event.target && event.target.name === "model") applyModel(event.target.value);
  });

  // ---- global ----
  document.addEventListener("keydown", onShortcuts);
  window.addEventListener("resize", () => {
    if (!window.matchMedia("(max-width: 900px)").matches) closeDrawer();
  });
}

function init() {
  // 1. Icons for the static markup, then the theme radio group.
  hydrateIcons(document);
  renderThemeGrid();

  // 2. Theme: theme-boot.js already set one before the first paint; this
  //    call syncs the radio group and re-applies the stored value.
  const savedTheme = readTheme(storage);
  applyTheme(savedTheme || el.root.getAttribute("data-theme") || THEMES[0].id, { animate: false });

  // 3. Sidebar state (collapsed rail on desktop, drawer on mobile).
  const savedSidebar = readSidebarState(storage);
  if (savedSidebar === "collapsed" || savedSidebar === "expanded") {
    el.root.setAttribute("data-sidebar", savedSidebar);
  }
  updateCollapseButton();

  // 4. First paint of the sidebar, top bar and thread.
  autoGrow();
  updateCounter();
  renderAll({ scroll: "bottom" });

  wireEvents();

  // 5. The model list comes from the backend, so it is fetched last.
  renderModelPlaceholder("Reading the model list from the backend...");
  loadConfig();

  // 6. Focus the message box on desktop; on a phone that would pop the
  //    on-screen keyboard before the user is ready.
  if (!window.matchMedia("(max-width: 900px)").matches) focusComposer();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}