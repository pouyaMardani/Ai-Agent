

import { hydrateIcons, iconMarkup } from "./icons.js";
import { escapeHtml, renderMarkdown } from "./markdown.js";
import {
  LIMITS,
  deriveTitle,
  makeConversation,
  readSidebarState,
  readState,
  readTheme,
  resolveStorage,
  sortConversations,
  uid,
  writeSidebarState,
  writeState,
  writeTheme,
} from "./store.js";

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
  settingsCount: document.getElementById("settings-count"),
  wipe: document.getElementById("wipe-btn"),
  confirmDialog: document.getElementById("confirm-dialog"),
  confirmTitle: document.getElementById("confirm-title"),
  confirmText: document.getElementById("confirm-text"),
  confirmOk: document.getElementById("confirm-ok"),
  toasts: document.getElementById("toasts"),
};

const storage = resolveStorage();
let state = readState(storage);

const ui = {
  busy: false,
  pendingId: null,
  editingId: null,
  query: "",
};

function activeConversation() {
  return state.conversations.find((conversation) => conversation.id === state.activeId) || null;
}

function persist() {
  writeState(storage, state);
}

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

function formatClock(timestamp) {
  return new Date(timestamp).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function announce(text) {
  el.srStatus.textContent = text;
}

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

async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (error) {

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

el.confirmDialog.returnValue = "cancel";
    if (el.confirmDialog.open) el.confirmDialog.close();

    el.confirmDialog.addEventListener("close", finish);
    el.confirmDialog.showModal();
  });
}

function setBackendStatus(ok, text) {
  el.statusDot.className = "status-dot" + (ok ? " is-ok" : " is-bad");
  el.statusText.textContent = text;
}

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

function applyTheme(id, options = {}) {
  const theme = THEMES.find((item) => item.id === id) || THEMES[0];
  const changed = el.root.getAttribute("data-theme") !== theme.id;

  el.root.setAttribute("data-theme", theme.id);
  writeTheme(storage, theme.id);

  const schemeMeta = document.querySelector('meta[name="color-scheme"]');
  if (schemeMeta) schemeMeta.setAttribute("content", theme.id === "studio" ? "light" : "dark");

  el.themeGrid.querySelectorAll("[data-theme-option]").forEach((node) => {
    const selected = node.dataset.themeOption === theme.id;
    node.classList.toggle("is-selected", selected);
    const input = node.querySelector("input");
    if (input) input.checked = selected;
  });

  if (changed && options.animate !== false && !prefersReducedMotion()) {
    el.root.classList.add("is-theme-shifting");
    window.setTimeout(() => el.root.classList.remove("is-theme-shifting"), 640);
  }
}

function isNearBottom() {
  const distance = el.thread.scrollHeight - el.thread.scrollTop - el.thread.clientHeight;
  return distance < 120;
}

function scrollThreadToBottom(behavior = "smooth") {
  if (behavior === "smooth" && prefersReducedMotion()) behavior = "auto";
  el.thread.scrollTo({ top: el.thread.scrollHeight, behavior });
}

function updateScrollButton() {
  const conversation = activeConversation();
  const hasMessages = Boolean(conversation && conversation.messages.length);
  el.scrollBottom.hidden = !hasMessages || isNearBottom();
}

function monogram(title) {
  const first = String(title || "").trim().charAt(0);
  return first ? first.toUpperCase() : "#";
}

function conversationMeta(conversation) {
  const count = conversation.messages.length;
  const label = count === 0 ? "empty" : count === 1 ? "1 message" : count + " messages";
  return formatWhen(conversation.updatedAt) + " \u00B7 " + label;
}

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

function renderMessage(conversation, message, index) {
  const row = document.createElement("article");
  row.className = "msg msg--" + message.role;
  row.dataset.id = message.id;

  const isLast = index === conversation.messages.length - 1;

  if (message.role === "user") {
    const bubble = document.createElement("div");
    bubble.className = "bubble";

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
    panel.innerHTML = renderMarkdown(message.content);
    body.append(panel, messageActions(isLast));
  }

  row.append(avatar, body);
  return row;
}

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

hydrateIcons(el.threadInner);

  if (mode === "preserve") el.thread.scrollTop = previousScroll;
  else if (mode === "smooth") scrollThreadToBottom("smooth");
  else scrollThreadToBottom("auto");

  updateScrollButton();
}

function renderAll(options = {}) {
  renderConversations();
  renderTopbar();
  renderThread(options);
}

function autoGrow() {
  el.input.style.height = "auto";
  el.input.style.height = Math.min(el.input.scrollHeight, 220) + "px";
}

function updateCounter() {
  const length = el.input.value.length;
  el.counter.textContent = length === 0 ? "" : length.toLocaleString() + " characters";
}

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

function historyPayload(conversation, userIndex) {
  return conversation.messages
    .slice(0, userIndex)
    .slice(-LIMITS.historySentToApi)
    .filter((item) => (item.role === "user" || item.role === "assistant") && item.content.trim())
    .map((item) => ({ role: item.role, content: item.content }));
}

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
      }),
    });

    let data = null;
    try {
      data = await response.json();
    } catch (error) {
      data = null;
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

async function sendMessage() {
  const conversation = activeConversation();
  const text = el.input.value.trim();
  if (!conversation || ui.busy || !text) return;

  el.input.value = "";
  autoGrow();
  updateCounter();

  const userMessage = { id: uid("m"), role: "user", content: text, at: Date.now() };
  conversation.messages.push(userMessage);

const isFirstTurn = conversation.messages.filter((message) => message.role === "user").length === 1;
  if (isFirstTurn) conversation.title = deriveTitle(text);
  conversation.updatedAt = userMessage.at;
  persist();

  renderAll({ scroll: "smooth" });
  await requestReply(conversation.id, conversation.messages.length - 1);
}

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

function selectConversation(id) {
  if (state.activeId !== id) {
    state.activeId = id;
    ui.editingId = null;
    persist();
    renderAll({ scroll: "bottom" });
  }
  closeDrawer();
}

function startRename(id) {
  ui.editingId = id;
  renderConversations();
  const input = el.convList.querySelector('[data-action="rename-input"]');
  if (input) {
    input.focus();
    input.select();
  }
}

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

function toggleSidebar() {
  const collapsed = el.root.getAttribute("data-sidebar") === "collapsed";
  const next = collapsed ? "expanded" : "collapsed";
  el.root.setAttribute("data-sidebar", next);
  writeSidebarState(storage, next);
  updateCollapseButton();
}

function onConversationListClick(event) {
  const row = event.target.closest(".conv");
  if (!row) return;
  const trigger = event.target.closest("[data-action]");
  const name = trigger ? trigger.dataset.action : "open";

  if (name === "open") selectConversation(row.dataset.id);
  else if (name === "rename") startRename(row.dataset.id);
  else if (name === "delete") deleteConversation(row.dataset.id);
}

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

function onConversationListFocusOut(event) {
  const input = event.target.closest('[data-action="rename-input"]');
  if (!input) return;
  const row = input.closest(".conv");
  if (!row) return;
  if (ui.editingId === row.dataset.id) commitRename(row.dataset.id, input.value);
}

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

function onSuggestionPointerMove(event) {
  const card = event.target.closest(".suggestion");
  if (!card || event.pointerType === "touch") return;
  const rect = card.getBoundingClientRect();
  card.style.setProperty("--mx", event.clientX - rect.left + "px");
  card.style.setProperty("--my", event.clientY - rect.top + "px");
}

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

async function loadConfig() {
  try {
    const response = await fetch("/api/config");
    if (!response.ok) throw new Error("config unavailable");
    setBackendStatus(true, "Backend connected");
  } catch (error) {
    setBackendStatus(false, "Backend unreachable");
  }
}

function openSettings() {
  el.settingsCount.textContent = String(state.conversations.length);
  if (typeof el.settingsDialog.showModal === "function") el.settingsDialog.showModal();
  else el.settingsDialog.setAttribute("open", "");
}

function wireEvents() {

  el.composer.addEventListener("submit", (event) => {
    event.preventDefault();
    sendMessage();
  });

  el.input.addEventListener("input", () => {
    autoGrow();
    updateCounter();
  });

  el.input.addEventListener("keydown", (event) => {

    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      sendMessage();
    }
  });

el.newChat.addEventListener("click", newChat);
  el.collapse.addEventListener("click", toggleSidebar);
  el.drawer.addEventListener("click", openDrawer);
  el.scrim.addEventListener("click", closeDrawer);
  el.settingsBtn.addEventListener("click", openSettings);
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

el.threadInner.addEventListener("click", (event) => {
    onThreadCopyCode(event);
    onThreadClick(event);
  });
  el.threadInner.addEventListener("pointermove", onSuggestionPointerMove);
  el.thread.addEventListener("scroll", updateScrollButton, { passive: true });
  el.scrollBottom.addEventListener("click", () => scrollThreadToBottom("smooth"));
  el.clearBtn.addEventListener("click", clearConversation);

el.themeGrid.addEventListener("change", (event) => {
    if (event.target && event.target.name === "theme") applyTheme(event.target.value);
  });

document.addEventListener("keydown", onShortcuts);
  window.addEventListener("resize", () => {
    if (!window.matchMedia("(max-width: 900px)").matches) closeDrawer();
  });
}

function init() {

  hydrateIcons(document);
  renderThemeGrid();

const savedTheme = readTheme(storage);
  applyTheme(savedTheme || el.root.getAttribute("data-theme") || THEMES[0].id, { animate: false });

const savedSidebar = readSidebarState(storage);
  if (savedSidebar === "collapsed" || savedSidebar === "expanded") {
    el.root.setAttribute("data-sidebar", savedSidebar);
  }
  updateCollapseButton();

autoGrow();
  updateCounter();
  renderAll({ scroll: "bottom" });

  wireEvents();

loadConfig();

if (!window.matchMedia("(max-width: 900px)").matches) focusComposer();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}