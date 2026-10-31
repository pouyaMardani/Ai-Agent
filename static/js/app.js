

import { hydrateIcons, iconMarkup } from "./icons.js";
import { escapeHtml, renderMarkdown } from "./markdown.js";
import {
  LIMITS,
  cleanCompaction,
  cleanContext,
  cleanUsage,
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
  analytics: document.getElementById("analytics"),
  analyticsInner: document.getElementById("analytics-inner"),
  analyticsBtn: document.getElementById("analytics-btn"),
  analyticsScrim: document.getElementById("analytics-scrim"),
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
  expandedUsage: new Set(),
  expandedContext: new Set(),
  // Which assistant turn the analytics panel describes, and which model request
  // inside that turn. Both are resolved against the active conversation on every
  // render, so a selection can never point at a message that no longer exists.
  selectedId: null,
  selectedCall: null,
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

// --- Token usage UI --------------------------------------------------------
//
// One compact indicator per assistant response, shown outside the message
// bubble in the response-action row. It opens a small panel built from the
// usage the provider actually reported: a missing number is shown as N/A, never
// as 0, and nothing is estimated from the text.

const USAGE_UNAVAILABLE = "N/A";

function formatTokens(value) {
  if (!Number.isFinite(value)) return USAGE_UNAVAILABLE;
  return value.toLocaleString();
}

function usageCollapsedLabel(usage) {
  const total = usage.totals ? usage.totals.total_tokens : null;
  if (Number.isFinite(total)) {
    let label = formatTokens(total) + " tokens";
    if (Number.isFinite(usage.model_calls) && usage.model_calls > 0) {
      label += " \u00B7 " + usage.model_calls + (usage.model_calls === 1 ? " call" : " calls");
    }
    return label;
  }
  return usage.available ? "usage partly reported" : "usage not reported";
}

function usageBadge(usage) {
  if (!usage.available) return { text: "Not reported", tone: "muted" };
  if (usage.complete) return { text: "Complete data", tone: "ok" };
  return { text: "Partial data", tone: "warn" };
}

function usageRow(label, value, hint) {
  const row = document.createElement("div");
  row.className = "usage-row";

  const name = document.createElement("span");
  name.className = "usage-row__label";
  name.textContent = label;
  if (hint) name.title = hint;

  const number = document.createElement("span");
  number.className = "usage-row__value" + (Number.isFinite(value) ? "" : " is-empty");
  number.textContent = formatTokens(value);

  row.append(name, number);
  return row;
}

function usageBar(label, value, max, tone) {
  const wrap = document.createElement("div");
  wrap.className = "usage-bar" + (tone ? " usage-bar--" + tone : "");

  const name = document.createElement("span");
  name.className = "usage-bar__label";
  name.textContent = label;

  const track = document.createElement("span");
  track.className = "usage-bar__track";
  const fill = document.createElement("span");
  fill.className = "usage-bar__fill";
  const ratio =
    Number.isFinite(value) && Number.isFinite(max) && max > 0
      ? Math.max(0, Math.min(1, value / max))
      : 0;
  fill.style.width = Math.round(ratio * 100) + "%";
  track.appendChild(fill);

  wrap.append(name, track);
  return wrap;
}

function callDescription(index, total, toolCalls) {
  if (total <= 1) return "the only model request for this answer";
  if (index === 0) return "initial model request";
  if (index === total - 1) return "final model request - produced the answer above";
  return toolCalls > 0 ? "model request after tool results" : "follow-up model request";
}

function usageCallBlock(call, index, total, toolCalls) {
  const item = document.createElement("div");
  item.className = "usage-call";

  const head = document.createElement("div");
  head.className = "usage-call__head";
  const title = document.createElement("span");
  title.className = "usage-call__title";
  title.textContent = "Call " + (Number.isFinite(call.call_index) ? call.call_index : index + 1);
  const desc = document.createElement("span");
  desc.className = "usage-call__desc";
  desc.textContent = callDescription(index, total, toolCalls);
  head.append(title, desc);

  const nums = document.createElement("div");
  nums.className = "usage-call__nums";
  const parts = [
    ["Input", call.input_tokens, "Tokens this call read"],
    ["Output", call.output_tokens, "Tokens this call wrote, including any tool-call arguments"],
    ["Total", call.total_tokens, "Total reported for this call"],
  ];
  if (Number.isFinite(call.cached_input_tokens)) {
    parts.push(["Cached", call.cached_input_tokens, "Cached input tokens (part of input)"]);
  }
  if (Number.isFinite(call.reasoning_tokens)) {
    parts.push(["Reasoning", call.reasoning_tokens, "Reasoning tokens (part of output)"]);
  }
  parts.forEach(([key, value, hint]) => {
    const chip = document.createElement("span");
    chip.className = "usage-chip";
    chip.title = hint;
    const label = document.createElement("span");
    label.className = "usage-chip__key";
    label.textContent = key;
    const val = document.createElement("span");
    val.className = "usage-chip__val" + (Number.isFinite(value) ? "" : " is-empty");
    val.textContent = formatTokens(value);
    chip.append(label, val);
    nums.appendChild(chip);
  });

  if (!call.reported) {
    const miss = document.createElement("span");
    miss.className = "usage-call__missing";
    miss.textContent = "This call returned no usage data.";
    nums.appendChild(miss);
  }

  item.append(head, nums);
  return item;
}

function usageNote(usage) {
  if (!usage.available) {
    return (
      "The provider did not report token usage for this response, so no numbers are shown. " +
      "Nothing here is estimated from the length of the text."
    );
  }

  const missing = [];
  if (!Number.isFinite(usage.totals.cached_input_tokens)) missing.push("cached input");
  if (!Number.isFinite(usage.totals.reasoning_tokens)) missing.push("reasoning");

  const parts = [
    "Input tokens cover everything the model read, including tool results sent back in later calls, so a follow-up call can cost more input than the first.",
  ];
  if (!usage.complete) {
    parts.push("Some calls did not report every field, so values shown as N/A are unknown rather than zero.");
  }
  if (usage.derived_total) {
    parts.push("The total was added up locally from complete input and output, because the provider sent no total.");
  }
  if (missing.length > 0) {
    parts.push("The provider did not report " + missing.join(" or ") + " for this response.");
  }
  return parts.join(" ");
}

function buildUsagePanel(usage) {
  const panel = document.createElement("div");
  panel.className = "usage-panel";

  const head = document.createElement("div");
  head.className = "usage-panel__head";
  const title = document.createElement("span");
  title.className = "usage-panel__title";
  title.textContent = "Token Usage";
  const badge = usageBadge(usage);
  const tag = document.createElement("span");
  tag.className = "usage-panel__badge usage-panel__badge--" + badge.tone;
  tag.textContent = badge.text;
  head.append(title, tag);
  panel.appendChild(head);

  const totals = usage.totals || {};
  const rows = document.createElement("div");
  rows.className = "usage-panel__rows";
  rows.append(
    usageRow(
      "Input tokens",
      totals.input_tokens,
      "Tokens processed as input for the model calls in this response."
    ),
    usageRow(
      "Output tokens",
      totals.output_tokens,
      "Tokens generated by the model calls. This can include tool-call arguments, not only visible text."
    ),
    usageRow(
      usage.derived_total ? "Total tokens (derived)" : "Total tokens",
      totals.total_tokens,
      usage.derived_total
        ? "Not reported by the provider; added up locally from complete input and output."
        : "Total tokens the provider reported for this response."
    ),
    usageRow(
      "Cached input tokens",
      totals.cached_input_tokens,
      "Cached input the provider reused. Part of input, not extra usage."
    ),
    usageRow(
      "Reasoning tokens",
      totals.reasoning_tokens,
      "Reasoning the provider reported. Part of output, not extra usage."
    )
  );
  panel.appendChild(rows);

  const input = totals.input_tokens;
  const output = totals.output_tokens;
  const core = (Number.isFinite(input) ? input : 0) + (Number.isFinite(output) ? output : 0);
  if (core > 0) {
    const bars = document.createElement("div");
    bars.className = "usage-panel__bars";
    bars.append(usageBar("Input", input, core, "input"), usageBar("Output", output, core, "output"));
    if (Number.isFinite(totals.cached_input_tokens) && Number.isFinite(input) && input > 0) {
      bars.append(usageBar("Cached (of input)", totals.cached_input_tokens, input, "cached"));
    }
    if (Number.isFinite(totals.reasoning_tokens) && Number.isFinite(output) && output > 0) {
      bars.append(usageBar("Reasoning (of output)", totals.reasoning_tokens, output, "reasoning"));
    }
    const barNote = document.createElement("p");
    barNote.className = "usage-panel__hint";
    barNote.textContent =
      "Bars compare shares inside this response. Cached tokens are part of input and reasoning tokens are part of output, so they are not added on top.";
    bars.appendChild(barNote);
    panel.appendChild(bars);
  }

  const stats = document.createElement("div");
  stats.className = "usage-panel__stats";
  stats.append(
    usageRow("Model API calls", usage.model_calls, "Real requests this response made to the model."),
    usageRow(
      "Tool calls",
      usage.tool_calls,
      "Tools the agent ran. A tool run is not a model API call, and its result becomes input for the next call."
    )
  );
  panel.appendChild(stats);

  if (Array.isArray(usage.calls) && usage.calls.length > 0) {
    const calls = document.createElement("div");
    calls.className = "usage-panel__calls";
    const heading = document.createElement("p");
    heading.className = "usage-panel__subhead";
    heading.textContent = usage.calls.length > 1 ? "By model call" : "This model call";
    calls.appendChild(heading);
    usage.calls.forEach((call, index) => {
      calls.appendChild(usageCallBlock(call, index, usage.calls.length, usage.tool_calls));
    });
    panel.appendChild(calls);
  }

  const note = document.createElement("p");
  note.className = "usage-panel__note";
  note.textContent = usageNote(usage);
  panel.appendChild(note);

  return panel;
}

function buildUsageIndicator(message) {
  const usage = message && message.usage;
  if (!usage || typeof usage !== "object") return null;

  const wrap = document.createElement("div");
  wrap.className = "msg__usage";

  const panelId = "usage-panel-" + message.id;
  const expanded = ui.expandedUsage.has(message.id);
  if (expanded) wrap.classList.add("is-open");

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "usage-toggle";
  toggle.dataset.action = "toggle-usage";
  toggle.setAttribute("aria-controls", panelId);
  toggle.setAttribute("aria-expanded", expanded ? "true" : "false");
  toggle.title = usage.available
    ? "Show the token usage the provider reported for this answer"
    : "The provider did not report token usage for this answer";

  const glyph = document.createElement("span");
  glyph.className = "usage-toggle__glyph";
  glyph.setAttribute("aria-hidden", "true");
  glyph.textContent = "\u25C8";

  const label = document.createElement("span");
  label.className = "usage-toggle__label";
  label.textContent = usageCollapsedLabel(usage);

  const chevron = document.createElement("span");
  chevron.className = "usage-toggle__chevron";
  chevron.setAttribute("aria-hidden", "true");
  chevron.innerHTML = iconMarkup("arrow-down");

  toggle.append(glyph, label, chevron);

  const panel = buildUsagePanel(usage);
  panel.id = panelId;
  panel.hidden = !expanded;
  panel.setAttribute("role", "region");
  panel.setAttribute("aria-label", "Token usage details");

  wrap.append(toggle, panel);
  return wrap;
}

function setUsageExpanded(button, expanded) {
  const holder = button.closest(".msg__usage");
  const panel = holder ? holder.querySelector(".usage-panel") : null;
  button.setAttribute("aria-expanded", expanded ? "true" : "false");
  if (holder) holder.classList.toggle("is-open", expanded);
  if (panel) panel.hidden = !expanded;
}

// --- Context estimate & budget UI ------------------------------------------
//
// A second compact indicator next to Token Usage, answering a different
// question: how big was the input going to be BEFORE each model call, and how
// much room did the configured budget leave? Every number the estimator produced
// is labelled as an estimate, and estimates stay visibly apart from the usage the
// provider reported afterwards. The rows, chips and bars reuse the token-usage
// classes on purpose, so both cards speak one visual language in every theme.

function contextPrimaryCall(context) {
  return context.calls.length > 0 ? context.calls[context.calls.length - 1] : null;
}

function contextBudgetOf(context, call) {
  if (call && call.budget) return call.budget;
  return context.budget;
}

function formatPercent(value) {
  return Number.isFinite(value) ? Math.round(value) + "%" : USAGE_UNAVAILABLE;
}

function contextStateLabel(state, rejected) {
  if (rejected) return "Rejected before sending";
  if (state === "over") return "Over budget";
  if (state === "approaching") return "Near the limit";
  return "Comfortable";
}

function contextStateTone(state, rejected) {
  if (rejected || state === "over") return "over";
  if (state === "approaching") return "approaching";
  return "comfortable";
}

function contextStateOf(context, call) {
  const budget = contextBudgetOf(context, call);
  const rejected = Boolean((call && call.rejected) || context.rejected);
  const state = budget ? budget.budget_state : null;
  return {
    state,
    rejected,
    label: contextStateLabel(state, rejected),
    tone: contextStateTone(state, rejected),
  };
}

function contextEstimateBadge(context) {
  const status = context.estimation_status;
  if (status === "exact") return "Exact count";
  if (status === "estimated") return "Estimated (unverified)";
  if (status === "heuristic") return "Approximate";
  return context.is_exact ? "Exact count" : "Estimated";
}

function contextEstimateLabel(context) {
  const call = contextPrimaryCall(context);
  const estimate = (call && call.estimate) || context.last_call || context.first_call;
  const method = analyticsTokenizerName(estimate, context);
  const status = context.estimation_status || (estimate ? estimate.estimation_status : null);

  if (status === "exact") return "exact token count (" + method + ")";
  if (status === "estimated") {
    return "estimate with " + method + " - a compatible tokenizer, but not the model's own";
  }
  if (status === "heuristic") {
    return "approximate count from " + method + " (about 4 characters per token)";
  }
  // Snapshots written before the tokenizer metadata existed still describe
  // themselves with the method string alone.
  const legacy = context.estimation_method || "";
  if (context.is_exact) return "exact tokenizer count" + (legacy ? " (" + legacy + ")" : "");
  if (legacy.indexOf("tiktoken:") === 0) return "estimated with " + legacy;
  return "estimated from text length (character heuristic, about 4 characters per token)";
}

function contextCallLabel(index, total) {
  if (total <= 1 || index === 0) return "Initial model call";
  if (index === total - 1) return "Final model call";
  return "Tool-loop model call";
}

function contextCollapsedLabel(context) {
  const call = contextPrimaryCall(context);
  const estimate = call ? call.estimate : context.last_call;
  const budget = contextBudgetOf(context, call);
  const estimated = estimate ? estimate.estimated_input_tokens : null;
  if (!Number.isFinite(estimated)) return "context estimate unavailable";

  let label = "Est. " + formatTokens(estimated) + " in";
  if (budget && Number.isFinite(budget.max_input_budget_tokens)) {
    label += " of " + formatTokens(budget.max_input_budget_tokens);
  }
  if (budget && Number.isFinite(budget.budget_utilization_percent)) {
    label += " \u00B7 " + formatPercent(budget.budget_utilization_percent);
  }
  return label;
}

function usageValueRow(label, text, isMissing, hint) {
  const row = document.createElement("div");
  row.className = "usage-row";

  const name = document.createElement("span");
  name.className = "usage-row__label";
  name.textContent = label;
  if (hint) name.title = hint;

  const value = document.createElement("span");
  value.className = "usage-row__value" + (isMissing ? " is-empty" : "");
  value.textContent = text;

  row.append(name, value);
  return row;
}

function contextChip(key, value, hint) {
  const chip = document.createElement("span");
  chip.className = "usage-chip";
  chip.title = hint || "";

  const label = document.createElement("span");
  label.className = "usage-chip__key";
  label.textContent = key;

  const val = document.createElement("span");
  val.className = "usage-chip__val" + (Number.isFinite(value) ? "" : " is-empty");
  val.textContent = formatTokens(value);

  chip.append(label, val);
  return chip;
}

function contextDiscrepancyLine(discrepancy) {
  const line = document.createElement("p");
  line.className = "context-diff";

  const diff = discrepancy.difference_tokens;
  const num = document.createElement("span");
  num.className = "context-diff__num";
  const sign = Number.isFinite(diff) ? (diff > 0 ? "+" : diff < 0 ? "\u2212" : "\u00B1") : "";
  num.textContent = sign + formatTokens(Number.isFinite(diff) ? Math.abs(diff) : NaN) + " tokens";

  const note = document.createElement("span");
  note.className = "context-diff__note";
  note.textContent =
    " estimation discrepancy: this request was estimated at " +
    formatTokens(discrepancy.estimated_input_tokens) +
    " input tokens and the provider reported " +
    formatTokens(discrepancy.actual_input_tokens) +
    ". It is not an extra cost and not a token category of its own.";

  line.append(num, note);
  return line;
}

function buildContextPanel(context) {
  const panel = document.createElement("div");
  panel.className = "context-panel";

  const call = contextPrimaryCall(context);
  const state = contextStateOf(context, call);
  const budget = contextBudgetOf(context, call);

  const head = document.createElement("div");
  head.className = "usage-panel__head";
  const title = document.createElement("span");
  title.className = "usage-panel__title";
  title.textContent = "Context & Budget";

  const badges = document.createElement("span");
  badges.className = "context-panel__badges";
  const stateBadge = document.createElement("span");
  stateBadge.className = "usage-panel__badge usage-panel__badge--" + state.tone;
  stateBadge.textContent = state.label;
  const methodBadge = document.createElement("span");
  methodBadge.className = "usage-panel__badge usage-panel__badge--muted";
  methodBadge.textContent = contextEstimateBadge(context);
  badges.append(stateBadge, methodBadge);
  head.append(title, badges);
  panel.appendChild(head);

  if (budget && budget.configuration_problem) {
    const problem = document.createElement("p");
    problem.className = "context-panel__problem";
    problem.textContent = budget.configuration_problem;
    panel.appendChild(problem);
  }

  // 1. The budget itself, in the same row style as the token usage card.
  const rows = contextBudgetRows(context);
  if (context.model) {
    rows.prepend(
      usageValueRow("Active model", context.model, false, "The model these requests were sent to.")
    );
  }
  panel.appendChild(rows);

  // 2. How close the estimate came to the input budget.
  panel.appendChild(contextBudgetBar(context, call));

  // 3. Where the estimate came from.
  const method = document.createElement("p");
  method.className = "context-panel__method";
  method.textContent =
    "Estimation method: " +
    contextEstimateLabel(context) +
    ". Every number here is an estimate made before the request, not the provider's own token count.";
  panel.appendChild(method);

  const estimateBlock = document.createElement("div");
  estimateBlock.className = "usage-panel__stats";
  const estimateHead = document.createElement("p");
  estimateHead.className = "usage-panel__subhead";
  estimateHead.textContent = "Where the estimate comes from";
  estimateBlock.append(estimateHead, contextEstimateRows(context));
  panel.appendChild(estimateBlock);

  const notes = call && call.estimate.estimation_notes ? call.estimate.estimation_notes : "";
  if (notes) {
    const note = document.createElement("p");
    note.className = "usage-panel__note";
    note.textContent = notes;
    panel.appendChild(note);
  }
  // 4. Estimate against the usage the provider actually reported.
  const compareBlock = document.createElement("div");
  compareBlock.className = "usage-panel__stats";
  const compareHead = document.createElement("p");
  compareHead.className = "usage-panel__subhead";
  compareHead.textContent = context.rejected
    ? "Estimate (nothing was sent)"
    : "Estimate vs reported usage";
  compareBlock.append(compareHead, contextComparison(context));
  panel.appendChild(compareBlock);

  // 5. Every model call of this answer, so a tool loop stays visible call by call.
  const calls = context.calls;
  if (calls.length > 0) {
    const callList = document.createElement("div");
    callList.className = "usage-panel__calls";
    const heading = document.createElement("p");
    heading.className = "usage-panel__subhead";
    heading.textContent = calls.length > 1 ? "By model call" : "This model call";
    callList.appendChild(heading);
    calls.forEach((item, index) => {
      callList.appendChild(contextCallBlock(item, index, calls.length));
    });
    panel.appendChild(callList);
  }

  const note = document.createElement("p");
  note.className = "usage-panel__note";
  note.textContent = contextNote(context);
  panel.appendChild(note);

  return panel;
}

function contextBudgetRows(context) {
  const budget = contextBudgetOf(context, contextPrimaryCall(context));
  const rows = document.createElement("div");
  rows.className = "usage-panel__rows";
  if (!budget) return rows;

  rows.append(
    usageRow(
      "Maximum input budget",
      budget.max_input_budget_tokens,
      "Context window minus the maximum output allowance minus the safety margin."
    ),
    usageRow(
      "Estimated input (before the request)",
      budget.estimated_input_tokens,
      "What the estimator measured just before the model call. This is not the provider's count."
    ),
    usageRow(
      "Remaining input budget",
      budget.remaining_input_budget_tokens,
      "Maximum input budget minus the estimate. Shown as zero when the estimate is over budget."
    ),
    usageRow(
      "Context window",
      budget.context_window_tokens,
      budget.context_window_note || "The capacity this app budgets for."
    ),
    usageRow(
      "Maximum output allowance",
      budget.max_output_tokens,
      "Reserved for the answer before the request is sent."
    ),
    usageRow(
      "Safety margin",
      budget.context_safety_margin_tokens,
      "Reserve for estimation error and provider-specific overhead."
    )
  );

  if (budget.over_budget) {
    rows.appendChild(
      usageRow(
        "Over budget by",
        budget.over_budget_tokens,
        "How far the estimate is above the maximum input budget."
      )
    );
  }
  return rows;
}

function contextBudgetBar(context, call) {
  const budget = contextBudgetOf(context, call);
  const wrap = document.createElement("div");
  wrap.className = "context-budget-bar";
  if (!budget) return wrap;

  const state = contextStateOf(context, call);
  const label =
    "Estimated input vs maximum input budget: " +
    formatTokens(budget.estimated_input_tokens) +
    " / " +
    formatTokens(budget.max_input_budget_tokens) +
    " (" +
    formatPercent(budget.budget_utilization_percent) +
    ") \u00B7 " +
    state.label;

  wrap.appendChild(
    usageBar(
      label,
      budget.estimated_input_tokens,
      budget.max_input_budget_tokens,
      state.tone
    )
  );

  const hint = document.createElement("p");
  hint.className = "usage-panel__hint";
  hint.textContent =
    "The bar compares the estimate with the maximum input budget. Under 70% is comfortable, " +
    "70% to 100% is near the limit, and anything larger than the budget is over budget. " +
    "The label and the numbers above it carry the same information as the colour.";
  wrap.appendChild(hint);
  return wrap;
}

function contextEstimateRows(context) {
  const call = contextPrimaryCall(context);
  const estimate = call ? call.estimate : context.last_call || context.first_call;
  const rows = document.createElement("div");
  rows.className = "usage-panel__rows";
  if (!estimate) return rows;

  rows.append(
    usageRow(
      "System prompt",
      estimate.system_prompt_tokens,
      "Estimated share of the input taken by the system instructions. Their text is never shown here."
    ),
    usageRow(
      "Conversation history",
      estimate.history_tokens,
      "Estimated share taken by the saved conversation sent with this request."
    ),
    usageRow(
      "Tool definitions",
      estimate.tool_definitions_tokens,
      "Estimated share taken by the JSON schemas of the tools offered with this call."
    ),
    usageRow(
      "This turn and tool results",
      estimate.other_input_tokens,
      "Estimated share taken by your newest message, the assistant tool-call messages, the tool results and the loop reminder."
    ),
    usageValueRow(
      "Messages in this request",
      Number.isFinite(estimate.message_count) ? String(estimate.message_count) : USAGE_UNAVAILABLE,
      !Number.isFinite(estimate.message_count),
      "How many messages this request carried. Each message is counted once, so none is counted twice."
    )
  );
  return rows;
}

function contextComparison(context) {
  const call = contextPrimaryCall(context);
  const wrap = document.createElement("div");
  wrap.className = "context-compare";
  if (!call) return wrap;

  const actual = call.actual;
  const rows = document.createElement("div");
  rows.className = "usage-panel__rows";
  rows.append(
    usageRow(
      "Estimated input (before the call)",
      call.estimate.estimated_input_tokens,
      "What this app expected the call to read."
    ),
    usageRow(
      "Actual input (reported after the call)",
      actual ? actual.input_tokens : null,
      "What the provider said the call read. A missing value stays N/A and is never replaced with zero."
    ),
    usageRow(
      "Actual output (reported after the call)",
      actual ? actual.output_tokens : null,
      "What the provider said the call wrote."
    )
  );
  wrap.appendChild(rows);

  const reported =
    actual &&
    (Number.isFinite(actual.input_tokens) ||
      Number.isFinite(actual.output_tokens) ||
      Number.isFinite(actual.total_tokens));

  if (call.discrepancy) {
    wrap.appendChild(contextDiscrepancyLine(call.discrepancy));
  } else if (!reported) {
    const missing = document.createElement("p");
    missing.className = "context-diff context-diff--missing";
    missing.textContent =
      "The provider did not report usage for this call, so the estimate cannot be compared with an actual number.";
    wrap.appendChild(missing);
  }
  return wrap;
}

function contextCallBlock(call, index, total) {
  const item = document.createElement("div");
  item.className = "context-call";

  const head = document.createElement("div");
  head.className = "context-call__head";
  const title = document.createElement("span");
  title.className = "context-call__title";
  title.textContent = "Call " + (Number.isFinite(call.call_index) ? call.call_index : index + 1);
  const desc = document.createElement("span");
  desc.className = "context-call__desc";
  desc.textContent = contextCallLabel(index, total);
  head.append(title, desc);
  item.appendChild(head);

  const budget = call.budget;
  const rows = document.createElement("div");
  rows.className = "usage-panel__rows";
  rows.append(
    usageRow(
      "Estimated input",
      call.estimate.estimated_input_tokens,
      "Estimate made immediately before this call."
    ),
    usageValueRow(
      "Budget use",
      budget ? formatPercent(budget.budget_utilization_percent) : USAGE_UNAVAILABLE,
      !budget || !Number.isFinite(budget.budget_utilization_percent),
      "Estimated input as a share of the maximum input budget."
    ),
    usageRow(
      "Remaining budget",
      budget ? budget.remaining_input_budget_tokens : null,
      "Room left before this request would have been refused."
    ),
    usageRow(
      "Tool definitions (estimated)",
      call.estimate.tool_definitions_tokens,
      "Only the calls that offer tools pay for their schemas."
    )
  );
  item.appendChild(rows);

  const actual = call.actual;
  const chips = document.createElement("div");
  chips.className = "usage-call__nums";
  chips.append(
    contextChip("Actual input", actual ? actual.input_tokens : null, "Input tokens the provider reported for this call."),
    contextChip("Actual output", actual ? actual.output_tokens : null, "Output tokens the provider reported for this call."),
    contextChip("Actual total", actual ? actual.total_tokens : null, "Total the provider reported for this call.")
  );
  const reported =
    actual &&
    (Number.isFinite(actual.input_tokens) ||
      Number.isFinite(actual.output_tokens) ||
      Number.isFinite(actual.total_tokens));
  if (!reported) {
    const missing = document.createElement("span");
    missing.className = "usage-call__missing";
    missing.textContent = "This call returned no usage data.";
    chips.appendChild(missing);
  }
  item.appendChild(chips);

  if (call.discrepancy) item.appendChild(contextDiscrepancyLine(call.discrepancy));

  if (call.reduced && call.reduction_note) {
    const note = document.createElement("p");
    note.className = "context-call__note";
    note.textContent = call.reduction_note;
    item.appendChild(note);
  }

  if (call.rejected) {
    const refused = document.createElement("p");
    refused.className = "context-call__note context-call__note--over";
    refused.textContent = "This request was refused before it was sent, so no usage exists for it.";
    item.appendChild(refused);
  }
  return item;
}

function contextNote(context) {
  const budget = contextBudgetOf(context, contextPrimaryCall(context));
  const parts = [
    "Estimates are made just before each call from the exact messages and tool definitions about to be sent, so they are not the provider's token counts and can differ from the actual usage shown in Token Usage.",
  ];

  if (budget && budget.context_window_source === "default") {
    parts.push(
      "The context window shown here is this app's configured budget, because the provider's real limit is not known to this app."
    );
  }
  if (Number.isFinite(context.reduced_calls) && context.reduced_calls > 0) {
    parts.push(
      context.reduced_calls === 1
        ? "One request was shortened to fit the budget."
        : context.reduced_calls + " requests were shortened to fit the budget."
    );
  }
  if (context.rejected) {
    parts.push("This answer was refused by the budget check before any model call, so it has no actual usage.");
  }
  return parts.join(" ");
}

function buildContextIndicator(message) {
  const context = message && message.context;
  if (!context || typeof context !== "object") return null;

  const wrap = document.createElement("div");
  wrap.className = "msg__context";

  const panelId = "context-panel-" + message.id;
  const expanded = ui.expandedContext.has(message.id);
  if (expanded) wrap.classList.add("is-open");

  const state = contextStateOf(context, contextPrimaryCall(context));

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "context-toggle";
  toggle.dataset.action = "toggle-context";
  toggle.setAttribute("aria-controls", panelId);
  toggle.setAttribute("aria-expanded", expanded ? "true" : "false");
  toggle.title = context.rejected
    ? "Show why this request was refused by the context budget"
    : "Show the estimated context and the budget this request was sent with";

  const glyph = document.createElement("span");
  glyph.className = "context-toggle__glyph";
  glyph.setAttribute("aria-hidden", "true");
  glyph.textContent = "\u25A4";

  const label = document.createElement("span");
  label.className = "context-toggle__label";
  label.textContent = contextCollapsedLabel(context);

  const stateTag = document.createElement("span");
  stateTag.className = "context-toggle__state context-toggle__state--" + state.tone;
  stateTag.textContent = state.label;

  const chevron = document.createElement("span");
  chevron.className = "context-toggle__chevron";
  chevron.setAttribute("aria-hidden", "true");
  chevron.innerHTML = iconMarkup("arrow-down");

  toggle.append(glyph, label, stateTag, chevron);

  const panel = buildContextPanel(context);
  panel.id = panelId;
  panel.hidden = !expanded;
  panel.setAttribute("role", "region");
  panel.setAttribute("aria-label", "Context estimate and budget details");

  wrap.append(toggle, panel);
  return wrap;
}

function setContextExpanded(button, expanded) {
  const holder = button.closest(".msg__context");
  const panel = holder ? holder.querySelector(".context-panel") : null;
  button.setAttribute("aria-expanded", expanded ? "true" : "false");
  if (holder) holder.classList.toggle("is-open", expanded);
  if (panel) panel.hidden = !expanded;
}

// --- Analytics panel -------------------------------------------------------
//
// The analytics panel answers, for ONE selected assistant turn, the same two
// questions the inline indicators answer: what the provider reported (Token
// Tracking) and what this app estimated and budgeted before the request
// (Context & Budget). Everything is read from the snapshot stored on the
// message itself, so selecting an older turn shows that turn's numbers instead
// of the newest ones, and a provider count is never mixed into an estimated row.

function analyticsCalls(context) {
  if (!context) return [];
  if (Array.isArray(context.calls) && context.calls.length > 0) return context.calls;
  // Fallback for a snapshot saved before per-call records existed: describe the
  // turn as the single call the summary's own fields refer to.
  const single = context.last_call || context.first_call;
  if (!single) return [];
  return [
    {
      call_index: 1,
      estimate: single,
      budget: context.budget,
      reduced: false,
      dropped_messages: 0,
      reduction_note: null,
      rejected: context.rejected === true,
      actual: null,
      discrepancy: null,
    },
  ];
}

function analyticsLatestTurn(conversation) {
  if (!conversation || conversation.messages.length === 0) return null;
  for (let index = conversation.messages.length - 1; index >= 0; index -= 1) {
    const message = conversation.messages[index];
    if (message.role === "assistant") return message;
  }
  return null;
}

function analyticsTurnNumber(conversation, message) {
  if (!conversation || !message) return null;
  let turn = 0;
  for (const item of conversation.messages) {
    if (item.role === "assistant") turn += 1;
    if (item.id === message.id) return turn;
  }
  return null;
}

// Keeps ui.selectedId pointing at a message that still exists in the active
// conversation, so opening another chat and clearing one can never leave the
// panel describing a turn that is no longer there. The default is the newest
// assistant turn.
function syncSelectedTurn() {
  const conversation = activeConversation();
  const stillThere =
    conversation !== null &&
    conversation.messages.some(
      (message) => message.id === ui.selectedId && message.role === "assistant"
    );
  if (!stillThere) {
    const latest = analyticsLatestTurn(conversation);
    ui.selectedId = latest ? latest.id : null;
    ui.selectedCall = null;
  }
  return conversation;
}

function analyticsSelectedMessage(conversation) {
  if (!conversation) return null;
  const chosen = conversation.messages.find(
    (message) => message.id === ui.selectedId && message.role === "assistant"
  );
  return chosen || analyticsLatestTurn(conversation);
}

function analyticsTurnTitle(conversation, message) {
  if (!message) return null;
  const turn = analyticsTurnNumber(conversation, message);
  const clock = formatClock(message.at);
  return (Number.isFinite(turn) ? "Turn " + turn : "Assistant answer") + " \u00B7 " + clock;
}

function analyticsTokenizerName(estimate, context) {
  if (context && context.tokenizer_label) return context.tokenizer_label;
  if (!estimate) return null;
  const method = estimate.estimation_method || "";
  if (method.indexOf("tiktoken:") === 0) return "tiktoken (" + method.slice(9) + ")";
  if (method.indexOf("huggingface:") === 0) return "Hugging Face (" + method.slice(12) + ")";
  return estimate.tokenizer_name || "built-in character heuristic";
}

function analyticsCompatibility(estimate) {
  const value = estimate ? estimate.tokenizer_compatibility : null;
  if (value === "compatible") return { text: "Matches this model", tone: "ok" };
  if (value === "unverified") return { text: "Compatibility unverified", tone: "warn" };
  if (value === "unsupported") return { text: "No compatible tokenizer", tone: "muted" };
  return { text: USAGE_UNAVAILABLE, tone: "muted" };
}

function analyticsEstimation(estimate) {
  const value = estimate ? estimate.estimation_status : null;
  if (value === "exact") return { text: "Exact token count", tone: "ok" };
  if (value === "estimated") return { text: "Tokenizer estimate", tone: "warn" };
  if (value === "heuristic") return { text: "Character heuristic (approximate)", tone: "warn" };
  return { text: USAGE_UNAVAILABLE, tone: "muted" };
}

function analyticsUsageState(usage) {
  if (!usage || !usage.available) return { text: "Not reported by the provider", tone: "muted" };
  if (usage.complete) return { text: "Reported by the provider", tone: "ok" };
  return { text: "Partly reported", tone: "warn" };
}

// What summary-based compaction did before this turn's first model call. The text
// stays short; the reason, when there is one, becomes the row's tooltip.
function analyticsCompactionState(compaction) {
  const folded = Number.isFinite(compaction.compacted_messages) ? compaction.compacted_messages : 0;
  if (compaction.applied) {
    return {
      text: "Summarised " + folded + (folded === 1 ? " older message" : " older messages"),
      tone: "ok",
      hint: "Those messages were replaced by the stored summary in this request; the conversation itself still keeps them.",
    };
  }
  if (compaction.reused) {
    return {
      text: "Stored summary reused",
      tone: "muted",
      hint: "The stored summary already covered those older messages, so nothing had to be summarised again.",
    };
  }
  return {
    text: "Not applied",
    tone: "warn",
    hint: compaction.reason || "Compaction ran but did not change the request.",
  };
}

function analyticsBudgetState(budget) {
  const value = budget ? budget.budget_status : null;
  if (value === "within") return { text: "Within budget", tone: "ok" };
  if (value === "approaching") return { text: "Approaching the limit", tone: "warn" };
  if (value === "over") return { text: "Over budget", tone: "over" };
  if (value === "unknown") return { text: "Budget unknown", tone: "muted" };
  // Snapshots written before budget_status existed still carry budget_state.
  const fallback = budget ? budget.budget_state : null;
  if (fallback === "comfortable") return { text: "Within budget", tone: "ok" };
  if (fallback === "approaching") return { text: "Approaching the limit", tone: "warn" };
  if (fallback === "over") return { text: "Over budget", tone: "over" };
  return { text: USAGE_UNAVAILABLE, tone: "muted" };
}

function analyticsWindowSource(budget) {
  if (!budget) return null;
  const origin = budget.context_window_origin;
  if (origin === "verified") return "Verified model metadata";
  if (origin === "unknown") return "No usable window could be read";
  if (budget.context_window_source === "environment") return "Configured in .env";
  if (budget.context_window_source === "default") return "Configured default";
  if (origin === "configured") return "Configured value";
  return null;
}

function analyticsPill(text, tone) {
  const pill = document.createElement("span");
  pill.className = "analytics-pill" + (tone ? " analytics-pill--" + tone : "");
  pill.textContent = text;
  return pill;
}

// A card is a titled table of label/value rows, so a screen reader reads
// "Estimated input, 3,412" instead of two unrelated cells.
function analyticsCard(title, subtitle) {
  const card = document.createElement("section");
  card.className = "analytics-card";

  const head = document.createElement("header");
  head.className = "analytics-card__head";
  const name = document.createElement("h3");
  name.className = "analytics-card__title";
  name.textContent = title;
  head.appendChild(name);
  if (subtitle) {
    const note = document.createElement("p");
    note.className = "analytics-card__sub";
    note.textContent = subtitle;
    head.appendChild(note);
  }

  const table = document.createElement("table");
  table.className = "analytics-table";
  const body = document.createElement("tbody");
  table.appendChild(body);

  card.append(head, table);
  return { card, body };
}

function analyticsRow(body, label, value, options = {}) {
  const row = document.createElement("tr");

  const key = document.createElement("th");
  key.setAttribute("scope", "row");
  key.textContent = label;
  if (options.labelHint) key.title = options.labelHint;

  const cell = document.createElement("td");
  if (options.node) {
    cell.appendChild(options.node);
  } else if (Number.isFinite(value)) {
    cell.textContent = options.percent ? formatPercent(value) : formatTokens(value);
    cell.classList.add("is-num");
  } else if (typeof value === "string" && value.trim()) {
    cell.textContent = value;
  } else {
    cell.textContent = USAGE_UNAVAILABLE;
    cell.classList.add("is-empty");
  }
  if (options.strong) cell.classList.add("is-strong");
  if (options.hint) cell.title = options.hint;

  row.append(key, cell);
  body.appendChild(row);
  return row;
}

function analyticsCallTable(calls, selectedIndex) {
  const table = document.createElement("table");
  table.className = "analytics-table analytics-table--calls";

  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  ["Request", "Estimated input", "Actual input", "Actual output", "Budget use"].forEach((label) => {
    const cell = document.createElement("th");
    cell.setAttribute("scope", "col");
    cell.textContent = label;
    headRow.appendChild(cell);
  });
  head.appendChild(headRow);

  const body = document.createElement("tbody");
  calls.forEach((call, index) => {
    const row = document.createElement("tr");
    if (index === selectedIndex) row.className = "is-current";

    const name = document.createElement("th");
    name.setAttribute("scope", "row");
    name.textContent = "Call " + (Number.isFinite(call.call_index) ? call.call_index : index + 1);
    row.appendChild(name);

    const values = [
      call.estimate ? call.estimate.estimated_input_tokens : null,
      call.actual ? call.actual.input_tokens : null,
      call.actual ? call.actual.output_tokens : null,
      call.budget ? call.budget.budget_utilization_percent : null,
    ];
    values.forEach((value, position) => {
      const cell = document.createElement("td");
      if (Number.isFinite(value)) {
        cell.textContent =
          position === values.length - 1 ? formatPercent(value) : formatTokens(value);
        cell.classList.add("is-num");
      } else {
        cell.textContent = USAGE_UNAVAILABLE;
        cell.classList.add("is-empty");
      }
      row.appendChild(cell);
    });
    body.appendChild(row);
  });

  table.append(head, body);
  return table;
}

// --- Token estimation breakdown --------------------------------------------
//
// The provider counts the request it serialises, this app counts the text it
// sends plus a few documented overheads, and the two are never the same number.
// The breakdown names each part so that difference can be read instead of
// guessed: every row says whether it came from the tokenizer, from a documented
// rule, or from nowhere at all (the provider's own serialization, which this app
// cannot see). The keys and the numbers come from the backend in
// `estimate.breakdown.rows`; only the labels live here.

const BREAKDOWN_ORDER = [
  "system_content",
  "user_content",
  "assistant_content",
  "tool_content",
  "other_message_content",
  "structured_content",
  "tool_call_arguments",
  "tool_call_ids",
  "role_labels",
  "tool_definitions",
  "message_overhead",
  "tool_definition_overhead",
  "provider_serialization",
];

const BREAKDOWN_LABELS = {
  system_content: "System content",
  user_content: "User content",
  assistant_content: "Assistant content",
  tool_content: "Tool content",
  other_message_content: "Other message content",
  structured_content: "Structured content",
  tool_call_arguments: "Tool call arguments",
  tool_call_ids: "Tool call ids",
  role_labels: "Role labels",
  tool_definitions: "Tool definitions",
  message_overhead: "Message overhead",
  tool_definition_overhead: "Tool definition overhead",
  provider_serialization: "Provider serialization",
};

const BREAKDOWN_MEASUREMENTS = {
  tokenizer: "Tokenizer",
  estimated: "Estimated",
  unknown: "Unknown",
};

// The rows the backend knows, in its order, plus anything it sends that this list
// has not seen yet, so a new component never silently disappears.
function analyticsBreakdownRows(estimate) {
  const breakdown = estimate && estimate.breakdown ? estimate.breakdown : null;
  const rows = breakdown && Array.isArray(breakdown.rows) ? breakdown.rows : [];
  const ordered = BREAKDOWN_ORDER.map((key) => rows.find((row) => row.key === key)).filter(Boolean);
  const rest = rows.filter((row) => BREAKDOWN_ORDER.indexOf(row.key) === -1);

  return ordered.concat(rest).map((row) => ({
    key: row.key,
    label: BREAKDOWN_LABELS[row.key] || row.key,
    // A row that cannot be measured has no number, and it stays null here so the
    // panel shows N/A rather than a zero it does not believe.
    tokens: Number.isFinite(row.tokens) ? row.tokens : null,
    measurement: row.measurement,
    measurementLabel: BREAKDOWN_MEASUREMENTS[row.measurement] || USAGE_UNAVAILABLE,
  }));
}

function analyticsBreakdownTable(rows) {
  const table = document.createElement("table");
  table.className = "analytics-table analytics-table--breakdown";

  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  ["Component", "Tokens", "Measurement"].forEach((label) => {
    const cell = document.createElement("th");
    cell.setAttribute("scope", "col");
    cell.textContent = label;
    headRow.appendChild(cell);
  });
  head.appendChild(headRow);

  const body = document.createElement("tbody");
  rows.forEach((row) => {
    const line = document.createElement("tr");

    const name = document.createElement("th");
    name.setAttribute("scope", "row");
    name.textContent = row.label;
    if (row.measurement === "unknown") {
      name.title = "The provider's own formatting and special tokens; this app cannot see them.";
    }
    line.appendChild(name);

    const count = document.createElement("td");
    if (Number.isFinite(row.tokens)) {
      count.textContent = formatTokens(row.tokens);
      count.classList.add("is-num");
      if (row.measurement === "tokenizer") count.classList.add("is-strong");
    } else {
      count.textContent = USAGE_UNAVAILABLE;
      count.classList.add("is-empty");
    }
    line.appendChild(count);

    const measurement = document.createElement("td");
    measurement.className = "analytics-table__measure";
    measurement.textContent = row.measurementLabel;
    if (row.measurement === "unknown") measurement.classList.add("is-empty");
    line.appendChild(measurement);

    body.appendChild(line);
  });

  table.append(head, body);
  return table;
}

// The three metrics side by side: what the tokenizer counted, what this app
// estimated for the request, and what the provider reported after the call.
function analyticsBreakdownTotals(estimate, actual, discrepancy) {
  const breakdown = estimate && estimate.breakdown ? estimate.breakdown : null;
  const table = document.createElement("table");
  table.className = "analytics-table analytics-table--totals";
  const body = document.createElement("tbody");

  analyticsRow(body, "Measured text tokens", estimate ? estimate.text_token_count : null, {
    hint: "Counted by the active tokenizer over the exact text this app sent.",
  });
  analyticsRow(body, "Estimated overhead", breakdown ? breakdown.estimated_overhead_tokens : null, {
    hint: "Documented rules (per-message delimiters, per-schema wrapper), not measurements.",
  });
  analyticsRow(
    body,
    "Total estimated request input",
    estimate ? estimate.estimated_input_tokens : null,
    {
      strong: true,
      hint: "Measured text plus estimated overhead. This is this app's number, not the provider's.",
    }
  );
  analyticsRow(body, "Provider-reported actual input", actual ? actual.input_tokens : null, {
    strong: true,
    hint: "What the provider counted after it serialised the request.",
  });
  if (discrepancy) {
    analyticsRow(body, "Unaccounted difference", analyticsDiscrepancyText(discrepancy), {
      hint: "Provider count minus this estimate. It is not attributed to any component here, because the provider's own formatting is not visible from this app.",
    });
  }
  if (actual && Number.isFinite(actual.cached_input_tokens)) {
    analyticsRow(body, "Cached input (reported separately)", actual.cached_input_tokens, {
      hint: "Already inside the provider's input; shown on its own here and never added to it again.",
    });
  }

  table.appendChild(body);
  return table;
}

function analyticsBreakdownNotes(context) {
  const notes = [
    "Tokenizer rows count the exact text this app sent, through the tokenizer reported above.",
    "Estimated rows are documented rules, not measurements; the unknown row is a part of the request this app cannot see.",
    "The unaccounted difference is the provider's count minus this estimate, and it is not assigned to any single component.",
  ];

  const totals = context ? context.estimate_totals : null;
  if (
    totals &&
    Number.isFinite(totals.requests) &&
    totals.requests > 1 &&
    Number.isFinite(totals.estimated_input_tokens)
  ) {
    notes.push(
      "Across all " +
        totals.requests +
        " model requests of this turn: " +
        formatTokens(totals.text_token_count) +
        " measured text tokens plus " +
        formatTokens(totals.estimated_overhead_tokens) +
        " estimated overhead = " +
        formatTokens(totals.estimated_input_tokens) +
        " estimated input, with every request counted once."
    );
  }

  return notes;
}

function analyticsBreakdownDetails(estimate, actual, discrepancy, context, callLabel) {
  const rows = analyticsBreakdownRows(estimate);
  if (rows.length === 0) return null;

  const details = document.createElement("details");
  details.className = "analytics-details";

  const summary = document.createElement("summary");
  summary.textContent = "Token Estimation Breakdown" + (callLabel ? " (" + callLabel + ")" : "");
  details.appendChild(summary);
  details.appendChild(analyticsBreakdownTable(rows));
  details.appendChild(analyticsBreakdownTotals(estimate, actual, discrepancy));

  analyticsBreakdownNotes(context).forEach((text) => {
    const note = document.createElement("p");
    note.className = "analytics-note";
    note.textContent = text;
    details.appendChild(note);
  });

  return details;
}

// --- Tool result management -------------------------------------------------
//
// Tool output is managed separately from conversation history, so it gets its own
// section: what the server classified, what it replaced and what that saved. Every
// number here is the server's own tokenizer estimate, and it is never mixed with
// provider-reported usage.

const TOOL_RESULT_CLASSES = [
  ["small", "Small", "Always kept", "Already cheap: keeping it costs less than managing it."],
  ["normal", "Normal", "Kept unless needed", "Moderate size; reduced only when the request needs the room."],
  ["large", "Large", "Summarised when needed", "At or above the configured share of the input budget."],
  [
    "critical",
    "Critical",
    "Trimmed, never paraphrased",
    "Reports a failure or an error; its reported fields and error text are kept verbatim.",
  ],
];

function toolResultsSummaryText(toolResults) {
  const results = Number.isFinite(toolResults.results) ? toolResults.results : null;
  const managed = Number.isFinite(toolResults.managed_results) ? toolResults.managed_results : null;
  if (results === null || managed === null) return null;
  if (managed === 0) return "nothing replaced (" + results + " kept as returned)";
  const saved = Number.isFinite(toolResults.saved_tokens)
    ? formatTokens(toolResults.saved_tokens)
    : USAGE_UNAVAILABLE;
  return managed + " of " + results + " replaced, about " + saved + " tokens saved";
}

function countPairText(first, second) {
  const left = Number.isFinite(first) ? formatTokens(first) : USAGE_UNAVAILABLE;
  const right = Number.isFinite(second) ? formatTokens(second) : USAGE_UNAVAILABLE;
  return left + " / " + right;
}

function toolResultClassTable(toolResults) {
  const table = document.createElement("table");
  table.className = "analytics-table analytics-table--breakdown";

  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  ["Classification", "Results", "Treatment"].forEach((label) => {
    const cell = document.createElement("th");
    cell.setAttribute("scope", "col");
    cell.textContent = label;
    headRow.appendChild(cell);
  });
  head.appendChild(headRow);

  const body = document.createElement("tbody");
  TOOL_RESULT_CLASSES.forEach(([key, label, treatment, meaning]) => {
    const line = document.createElement("tr");

    const name = document.createElement("th");
    name.setAttribute("scope", "row");
    name.textContent = label;
    name.title = meaning;
    line.appendChild(name);

    const count = document.createElement("td");
    const value = toolResults.classified[key];
    if (Number.isFinite(value)) {
      count.textContent = formatTokens(value);
      count.classList.add("is-num");
      count.classList.add("is-strong");
    } else {
      count.textContent = USAGE_UNAVAILABLE;
      count.classList.add("is-empty");
    }
    line.appendChild(count);

    const note = document.createElement("td");
    note.className = "analytics-table__measure";
    note.textContent = treatment;
    note.title = meaning;
    line.appendChild(note);

    body.appendChild(line);
  });

  table.append(head, body);
  return table;
}

function toolResultsTotalsTable(toolResults) {
  const table = document.createElement("table");
  table.className = "analytics-table analytics-table--totals";
  const body = document.createElement("tbody");

  analyticsRow(body, "Tool results in the request", toolResults.results, {
    hint: "How many tool results the request carried when it was measured last.",
  });
  analyticsRow(body, "Replaced by a managed representation", toolResults.managed_results, {
    hint: "Results whose content is now a marked representation. The tool message and its tool_call_id are unchanged.",
  });
  analyticsRow(body, "Kept exactly as returned", toolResults.unchanged, {
    hint: "Small, recent or unmatched results, and any result that did not need reducing.",
  });
  analyticsRow(body, "Original size (estimate)", toolResults.original_tokens, { strong: true });
  analyticsRow(body, "Managed size (estimate)", toolResults.managed_tokens, { strong: true });
  analyticsRow(body, "Estimated tokens saved", toolResults.saved_tokens, { strong: true });
  analyticsRow(body, "Summaries written", toolResults.summarized, {
    hint: "Management requests of their own, with no tools. They are never counted as agent model calls.",
  });
  analyticsRow(body, "Trimmed deterministically", toolResults.trimmed, {
    hint: "Critical results are reduced by keeping their reported fields and error text, never by a paraphrase.",
  });
  analyticsRow(body, "Raw-result retrievals", toolResults.retrievals, {
    hint: "Reads of retained raw results during this turn, including the read-back that proves an original is recoverable before a result is replaced.",
  });
  analyticsRow(
    body,
    "Management requests (calls / failures)",
    countPairText(toolResults.management_requests.calls, toolResults.management_requests.failures),
    { hint: "Condensing requests of its own, kept apart from the agent's model calls." }
  );
  analyticsRow(
    body,
    "Adaptive passes (changed / passes)",
    countPairText(toolResults.adaptive.changed, toolResults.adaptive.passes),
    { hint: "How often context was managed between tool rounds, and how many passes ran in total." }
  );
  analyticsRow(
    body,
    "Retained raw results (entries / bytes)",
    countPairText(toolResults.store.entries, toolResults.store.bytes),
    { hint: "The in-memory store of original tool output; oldest entries are evicted first when it reaches its limit." }
  );

  table.appendChild(body);
  return table;
}

function priorityDecisionList(toolResults) {
  const wrap = document.createElement("div");

  const intro = document.createElement("p");
  intro.className = "analytics-note";
  intro.textContent =
    (toolResults.priority.enabled
      ? "Priority order, least important first ("
      : "Reduction order without priority scoring (") +
    formatTokens(toolResults.priority.reducible) +
    " reducible item(s)):";
  wrap.appendChild(intro);

  toolResults.priority.decisions.forEach((decision) => {
    const line = document.createElement("p");
    line.className = "analytics-note";
    line.textContent =
      "#" +
      formatTokens(decision.index) +
      " \u00B7 " +
      decision.kind +
      " \u00B7 score " +
      formatTokens(decision.score) +
      " \u00B7 " +
      (decision.reason || "no reason recorded");
    wrap.appendChild(line);
  });

  return wrap;
}

function analyticsToolResultsDetails(toolResults) {
  if (!toolResults || toolResults.available !== true) return null;

  const details = document.createElement("details");
  details.className = "analytics-details";

  const summary = document.createElement("summary");
  summary.textContent = "Tool Result Management";
  details.appendChild(summary);
  details.appendChild(toolResultClassTable(toolResults));
  details.appendChild(toolResultsTotalsTable(toolResults));

  if (toolResults.priority.decisions.length > 0) {
    details.appendChild(priorityDecisionList(toolResults));
  }

  toolResults.notes.forEach((text) => {
    const note = document.createElement("p");
    note.className = "analytics-note";
    note.textContent = text;
    details.appendChild(note);
  });

  const skipped = Object.entries(toolResults.skipped_reasons || {});
  if (skipped.length > 0) {
    const line = document.createElement("p");
    line.className = "analytics-note";
    line.textContent =
      "Left alone: " + skipped.map(([reason, count]) => count + " \u00D7 " + reason).join("; ") + ".";
    details.appendChild(line);
  }

  return details;
}

// Card 1: what the provider reported. Every row here either came back from the
// provider or is explicitly labelled an estimate.
function analyticsTokenCard(conversation, message, context, usage, calls, call, selectedIndex) {
  const card = analyticsCard(
    "Token Tracking",
    message.error === true
      ? "No model call was made for this turn"
      : "The selected model request, then this turn's totals"
  );
  const rows = card.body;

  analyticsRow(rows, "Selected turn", analyticsTurnTitle(conversation, message), {
    strong: true,
    hint: "Select another answer in the chat to move the panel to that turn.",
  });

  const estimate = call ? call.estimate : null;
  analyticsRow(rows, "Tokenizer", analyticsTokenizerName(estimate, context), {
    hint: "The counting method used for the estimate below.",
  });

  const compatibility = analyticsCompatibility(estimate);
  analyticsRow(rows, "Tokenizer compatibility", null, {
    node: analyticsPill(compatibility.text, compatibility.tone),
    hint: "How closely that counting method matches the model that answered.",
  });

  const estimation = analyticsEstimation(estimate);
  analyticsRow(rows, "Estimation status", null, {
    node: analyticsPill(estimation.text, estimation.tone),
    hint: "An estimate is never the model's own count, even when a real tokenizer produced it.",
  });

  // Compaction only appears when it actually ran for this turn.
  const compaction = context && context.compaction ? context.compaction : null;
  if (compaction) {
    const state = analyticsCompactionState(compaction);
    analyticsRow(rows, "Context compaction", null, {
      node: analyticsPill(state.text, state.tone),
      hint: state.hint,
    });
    if (Number.isFinite(compaction.estimate_after)) {
      analyticsRow(rows, "Input after compaction", compaction.estimate_after, {
        hint: "Measured again once the summary had replaced the oldest saved messages.",
      });
    }
  }

  // Tool-result management is a separate story from conversation compaction, so it
  // gets its own row and its own section.
  const toolResults = context && context.tool_results ? context.tool_results : null;
  if (toolResults) {
    analyticsRow(rows, "Tool result management", toolResultsSummaryText(toolResults), {
      hint: "Tool output is managed on its own: a large result becomes a marked managed representation, and the raw result stays retrievable on the server.",
    });
  }

  analyticsRow(rows, "Estimated input", estimate ? estimate.estimated_input_tokens : null, {
    hint: "Counted by this app before the request was sent. This is not provider usage.",
  });

  const actual = call ? call.actual : null;
  analyticsRow(rows, "Actual input", actual ? actual.input_tokens : null, {
    hint: "Reported by the provider after the request.",
  });
  analyticsRow(rows, "Actual output", actual ? actual.output_tokens : null, {
    hint: "Reported by the provider after the request.",
  });
  analyticsRow(rows, "Actual total", actual ? actual.total_tokens : null, {
    hint: "Reported by the provider after the request.",
  });
  if (actual && Number.isFinite(actual.cached_input_tokens)) {
    analyticsRow(rows, "Cached input", actual.cached_input_tokens, {
      hint: "Input the provider served from its cache.",
    });
  }
  if (actual && Number.isFinite(actual.reasoning_tokens)) {
    analyticsRow(rows, "Reasoning tokens", actual.reasoning_tokens, {
      hint: "Reasoning tokens the provider reported.",
    });
  }

  const discrepancy = call ? call.discrepancy : null;
  if (discrepancy) {
    analyticsRow(rows, "Estimation discrepancy", analyticsDiscrepancyText(discrepancy), {
      hint: "Provider-reported input minus the estimate: two ways of counting the same input, not extra usage.",
    });
  }

  const usageState = analyticsUsageState(usage);
  analyticsRow(rows, "Usage availability", null, {
    node: analyticsPill(usageState.text, usageState.tone),
    hint: "Whether the provider returned token usage for this turn.",
  });

  if (usage) {
    const totals = usage.totals || {};
    analyticsRow(rows, "Model API calls", usage.model_calls, {
      hint: "How many times the model was called while answering this turn.",
    });
    analyticsRow(rows, "Tool calls", usage.tool_calls, {
      hint: "How many tools ran while answering this turn.",
    });
    analyticsRow(rows, "Turn input (all requests)", totals.input_tokens, {
      strong: true,
      hint: "Sum of every model request in this turn, as reported by the provider.",
    });
    analyticsRow(rows, "Turn output (all requests)", totals.output_tokens, {
      strong: true,
      hint: "Sum of every model request in this turn, as reported by the provider.",
    });
    analyticsRow(rows, "Turn total (all requests)", totals.total_tokens, {
      strong: true,
      hint: "Sum of every model request in this turn, as reported by the provider.",
    });
  }

  if (calls.length > 1) {
    const details = document.createElement("details");
    details.className = "analytics-details";
    const summary = document.createElement("summary");
    summary.textContent = "Per-request breakdown (" + calls.length + " model requests)";
    details.append(summary, analyticsCallTable(calls, selectedIndex));
    card.card.appendChild(details);
  }

  // One breakdown per model request, named with the call it belongs to, so two
  // calls of the same turn can never be read as one.
  const callLabel =
    calls.length > 1 ? "Call " + (selectedIndex + 1) + " of " + calls.length : null;
  const breakdown = analyticsBreakdownDetails(
    estimate,
    actual,
    discrepancy,
    context,
    callLabel
  );
  if (breakdown) card.card.appendChild(breakdown);

  const toolDetails = analyticsToolResultsDetails(toolResults);
  if (toolDetails) card.card.appendChild(toolDetails);

  return card.card;
}

// Card 2: what this app estimated and budgeted before the request. The rows
// follow the arithmetic the backend documents:
// input budget = context window - reserved output - safety margin.
function analyticsBudgetCard(call, selectedIndex, calls) {
  const budget = call ? call.budget : null;
  const card = analyticsCard(
    "Context & Budget",
    "The selected request, judged against the configured budget"
  );
  const rows = card.body;

  if (calls.length > 1) {
    analyticsRow(rows, "Selected request", "Call " + (selectedIndex + 1) + " of " + calls.length, {
      hint: "Use the request buttons above to inspect another model call in this turn.",
    });
  }

  analyticsRow(rows, "Context window", budget ? budget.context_window_tokens : null, {
    hint: "The window this app works within. It is a configured budget, not a provider fact.",
  });
  analyticsRow(rows, "Context window source", analyticsWindowSource(budget), {
    hint: "Where that number came from.",
  });
  analyticsRow(rows, "Reserved for the answer", budget ? budget.max_output_tokens : null, {
    hint: "Kept free so the model always has room to answer.",
  });
  analyticsRow(rows, "Safety margin", budget ? budget.context_safety_margin_tokens : null, {
    hint: "Kept free as slack for a provider that counts the same request differently.",
  });
  analyticsRow(rows, "Input budget", budget ? budget.max_input_budget_tokens : null, {
    strong: true,
    hint: "Context window minus the reserved output and the safety margin.",
  });
  analyticsRow(rows, "Estimated input", budget ? budget.estimated_input_tokens : null, {
    hint: "What this app counted for this request before sending it.",
  });
  analyticsRow(rows, "Remaining budget", budget ? budget.remaining_input_budget_tokens : null, {
    hint: "Input budget minus the estimated input.",
  });
  if (budget && Number.isFinite(budget.over_budget_tokens) && budget.over_budget_tokens > 0) {
    analyticsRow(rows, "Over budget by", budget.over_budget_tokens, {
      hint: "How far past the input budget this request was.",
    });
  }
  analyticsRow(rows, "Budget used", budget ? budget.budget_utilization_percent : null, {
    percent: true,
    hint: "Share of the input budget this request used.",
  });

  const state = analyticsBudgetState(budget);
  analyticsRow(rows, "Budget status", null, {
    node: analyticsPill(state.text, state.tone),
    hint: "Approaching starts at the configured warning share of the input budget; over means nothing was left.",
  });

  const confidence =
    (budget && budget.estimation_confidence) ||
    (call && call.estimate ? call.estimate.estimation_confidence : null);
  analyticsRow(rows, "Estimation confidence", confidence, {
    hint: "How the input count behind this decision was produced.",
  });

  if (call && call.reduced) {
    const dropped = Number.isFinite(call.dropped_messages) ? call.dropped_messages : 0;
    analyticsRow(
      rows,
      "Context reduction",
      dropped + (dropped === 1 ? " older message left out" : " older messages left out"),
      { hint: call.reduction_note || "The oldest saved messages were left out to stay inside the budget." }
    );
  }

  if (budget && budget.configuration_problem) {
    const problem = document.createElement("p");
    problem.className = "analytics-note analytics-note--warn";
    problem.textContent = budget.configuration_problem;
    card.card.appendChild(problem);
  }

  if (budget && budget.budget_caveat) {
    const caveat = document.createElement("p");
    caveat.className = "analytics-note";
    caveat.textContent = budget.budget_caveat;
    card.card.appendChild(caveat);
  }

  return card.card;
}

function analyticsCallsSelector(calls, selectedIndex) {
  const group = document.createElement("div");
  group.className = "analytics__calls";
  group.setAttribute("role", "group");
  group.setAttribute("aria-label", "Model request");

  const label = document.createElement("span");
  label.className = "analytics__calls-label";
  label.textContent = "Model request";
  group.appendChild(label);

  calls.forEach((call, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "analytics__call";
    button.dataset.action = "select-call";
    button.dataset.index = String(index);
    button.setAttribute("aria-pressed", index === selectedIndex ? "true" : "false");
    button.textContent = "Call " + (Number.isFinite(call.call_index) ? call.call_index : index + 1);
    button.title = contextCallLabel(index, calls.length);
    group.appendChild(button);
  });

  return group;
}

// The panel and the copied report read the same snapshot: the active
// conversation, the selected turn, the context estimate and usage stored on it,
// the per-call records, and the call the reader is looking at. Nothing is
// fetched or recalculated, so the two can never disagree.
function analyticsSnapshot() {
  const conversation = activeConversation();
  const message = analyticsSelectedMessage(conversation);
  const context = message && message.context ? message.context : null;
  const usage = message && message.usage ? message.usage : null;
  const calls = analyticsCalls(context);
  const wanted = Number.isInteger(ui.selectedCall) ? ui.selectedCall : calls.length - 1;
  const selectedIndex = calls.length > 0 ? Math.min(Math.max(wanted, 0), calls.length - 1) : -1;
  return {
    conversation,
    message,
    context,
    usage,
    calls,
    selectedIndex,
    call: selectedIndex >= 0 ? calls[selectedIndex] : null,
  };
}

// Draws the whole panel from the selected turn's stored snapshot. Nothing is
// fetched here: every number already arrived with the answer.
function renderAnalytics() {
  const inner = el.analyticsInner;
  if (!inner) return;

  const { conversation, message, context, usage, calls, selectedIndex, call } =
    analyticsSnapshot();

  // Rebuilding the panel keeps it simple, so the reader's scroll position is
  // restored afterwards instead of jumping back to the top.
  const keepScroll = el.analytics.scrollTop;
  inner.innerHTML = "";

  const head = document.createElement("header");
  head.className = "analytics__head";

  const titles = document.createElement("div");
  titles.className = "analytics__titles";
  const title = document.createElement("h2");
  title.className = "analytics__title";
  title.textContent = "Analytics";
  const sub = document.createElement("p");
  sub.className = "analytics__sub";
  sub.textContent = message ? analyticsTurnTitle(conversation, message) : "No turn selected";
  titles.append(title, sub);

  const close = document.createElement("button");
  close.type = "button";
  close.className = "icon-btn icon-btn--tiny analytics__close";
  close.dataset.action = "close-analytics";
  close.setAttribute("aria-label", "Hide analytics");
  close.title = "Hide analytics";
  close.innerHTML = iconMarkup("close");

  // The copy button sits beside the close button and copies the whole report,
  // not only the rows that happen to be visible.
  const actions = document.createElement("div");
  actions.className = "analytics__actions";
  actions.append(analyticsCopyButton(Boolean(message && (context || usage))), close);

  head.append(titles, actions);
  inner.appendChild(head);

  if (!message || (!context && !usage)) {
    const empty = document.createElement("p");
    empty.className = "analytics__empty";
    empty.textContent =
      conversation && conversation.messages.length > 0
        ? "This turn has no token or context data. Select an answer the model produced."
        : "No analytics yet. Send a message and the token and context numbers for that turn appear here.";
    inner.appendChild(empty);
    el.analytics.scrollTop = keepScroll;
    return;
  }

  if (calls.length > 1) inner.appendChild(analyticsCallsSelector(calls, selectedIndex));

  inner.appendChild(
    analyticsTokenCard(conversation, message, context, usage, calls, call, selectedIndex)
  );
  inner.appendChild(analyticsBudgetCard(call, selectedIndex, calls));

  const estimate = call ? call.estimate : null;
  const parts = [];
  if (estimate && estimate.estimation_notes) parts.push(estimate.estimation_notes);
  const method = analyticsTokenizerName(estimate, context);
  if (method) {
    parts.push("Estimated input comes from " + method + " and is never the model's own count.");
  }
  if (usage && !usage.available) {
    parts.push("The provider reported no usage for this turn, so no actual token counts are shown.");
  }
  if (context && context.model) parts.push("Model: " + context.model + ".");
  if (parts.length > 0) {
    const notes = document.createElement("p");
    notes.className = "analytics-note";
    notes.textContent = parts.join(" ");
    inner.appendChild(notes);
  }

  el.analytics.scrollTop = keepScroll;
}

// --- Analytics report for the clipboard ------------------------------------
//
// One plain-text report for the whole selected turn, built from the same
// snapshot the panel renders: nothing is fetched or recalculated, a value that
// is not part of that snapshot is written as N/A instead of being guessed, and
// an estimated value is never placed beside a provider-reported one without
// saying which is which. It carries numbers only - no message text, no prompts
// and nothing from .env.

function reportField(label, value, format) {
  if (Number.isFinite(value)) {
    return label + ": " + (format ? format(value) : formatTokens(value));
  }
  const text = typeof value === "string" ? value.trim() : "";
  return label + ": " + (text || USAGE_UNAVAILABLE);
}

function reportSection(title, lines) {
  return [title, "-".repeat(title.length), ...lines, ""];
}

// How much summary a conversation carries, without printing the summary text into
// the report: the report describes the analytics, not the conversation.
function storedSummaryLabel(conversation) {
  const stored = conversation && conversation.compaction ? conversation.compaction : null;
  if (!stored) return "none";
  const characters = typeof stored.summary === "string" ? stored.summary.length : 0;
  const version = Number.isFinite(stored.summary_version) ? stored.summary_version : 1;
  const updates = Number.isFinite(stored.compaction_count) ? stored.compaction_count : 0;
  return (
    characters.toLocaleString() +
    " characters, version " +
    version +
    ", folded " +
    updates +
    (updates === 1 ? " time" : " times")
  );
}

// The same wording as the card row above, so the report and the panel cannot
// disagree about the same number.
function analyticsDiscrepancyText(discrepancy) {
  const difference = discrepancy.difference_tokens;
  const sign = difference > 0 ? "+" : difference < 0 ? "\u2212" : "\u00B1";
  const percent = Number.isFinite(discrepancy.difference_percent)
    ? " (" + formatPercent(discrepancy.difference_percent) + ")"
    : "";
  return sign + formatTokens(Math.abs(difference)) + " tokens" + percent;
}

const DISCREPANCY_DIRECTIONS = {
  under: "the app estimated less than the provider reported",
  over: "the app estimated more than the provider reported",
  match: "the estimate matched the provider",
};

function analyticsCopyButton(hasData) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "analytics__copy";
  button.dataset.action = "copy-analysis";
  button.innerHTML = iconMarkup("copy") + "<span>Copy Analysis</span>";

  if (hasData) {
    button.title = "Copy this turn's full analytics report as plain text";
    button.setAttribute("aria-label", "Copy the analytics report");
    return button;
  }

  // No turn is selected or it has no token or context data, so there is nothing
  // that could be copied yet.
  button.disabled = true;
  button.title = "Nothing to copy yet: select an answer that has token or context data";
  button.setAttribute("aria-label", "Copy the analytics report (nothing to copy)");
  return button;
}

function analyticsReportText(snapshot) {
  const { conversation, message, context, usage, calls, selectedIndex, call } = snapshot;
  if (!message || (!context && !usage)) return null;

  const estimate = call ? call.estimate : null;
  const budget = call ? call.budget : null;
  const actual = call ? call.actual : null;
  const discrepancy = call ? call.discrepancy : null;
  const totals = usage && usage.totals ? usage.totals : {};
  const tokenizerAvailable = estimate
    ? estimate.tokenizer_available
    : context
      ? context.tokenizer_available
      : null;
  const rejectedCalls = calls.filter((item) => item.rejected).length;
  const reducedCalls = Number.isFinite(context && context.reduced_calls)
    ? context.reduced_calls
    : calls.length > 0
      ? calls.filter((item) => item.reduced).length
      : null;

  const lines = [];
  lines.push("ANALYTICS REPORT", "================", "");
  lines.push(reportField("Generated", new Date().toLocaleString()));
  lines.push(reportField("Application", "Token Harbor Chat"));
  lines.push(
    "Estimated values were counted by this app before the request; actual values were reported by the provider after it."
  );
  lines.push("");

  lines.push(
    ...reportSection("GENERAL", [
      reportField("Conversation", (conversation && conversation.title) || null),
      reportField("Turn", analyticsTurnTitle(conversation, message)),
      reportField("Turn recorded at", message.at ? new Date(message.at).toLocaleString() : null),
      reportField("Turn failed before answering", message.error === true ? "yes" : "no"),
      reportField("Model", context ? context.model : null),
      "Provider: N/A (the API reports the model id only)",
      reportField(
        "Selected model request",
        calls.length > 0 ? "Call " + (selectedIndex + 1) + " of " + calls.length : null
      ),
      reportField("Model requests in this turn", usage ? usage.model_calls : null),
      reportField(
        "Stored messages in this conversation",
        conversation ? conversation.messages.length : null
      ),
      reportField("Stored summary", storedSummaryLabel(conversation)),
      reportField("Newest messages replayed as history", LIMITS.historySentToApi),
    ])
  );

  lines.push(
    ...reportSection("TOKEN USAGE", [
      reportField("Estimated input (app estimate)", estimate ? estimate.estimated_input_tokens : null),
      reportField("Measured text tokens (tokenizer)", estimate ? estimate.text_token_count : null),
      reportField(
        "Estimated request overhead",
        estimate && estimate.breakdown ? estimate.breakdown.estimated_overhead_tokens : null
      ),
      reportField("Actual input (provider)", actual ? actual.input_tokens : null),
      reportField("Actual output (provider)", actual ? actual.output_tokens : null),
      reportField("Actual total (provider)", actual ? actual.total_tokens : null),
      reportField("Cached input (provider)", actual ? actual.cached_input_tokens : null),
      reportField("Reasoning tokens (provider)", actual ? actual.reasoning_tokens : null),
      reportField("Estimation discrepancy", discrepancy ? analyticsDiscrepancyText(discrepancy) : null),
      reportField(
        "Discrepancy direction",
        discrepancy ? DISCREPANCY_DIRECTIONS[discrepancy.direction] : null
      ),
      reportField("Turn input, all requests (provider)", usage ? totals.input_tokens : null),
      reportField("Turn output, all requests (provider)", usage ? totals.output_tokens : null),
      reportField("Turn total, all requests (provider)", usage ? totals.total_tokens : null),
      reportField("Turn total derived by the app", usage ? (usage.derived_total ? "yes" : "no") : null),
      reportField("Usage availability", usage ? analyticsUsageState(usage).text : null),
      reportField("Tool executions in this turn", usage ? usage.tool_calls : null),
      reportField("Tokenizer backend", context ? context.tokenizer_backend : null),
      reportField("Tokenizer name", context ? context.tokenizer_name : null),
      reportField("Tokenizer label", context ? context.tokenizer_label : null),
      reportField("Tokenizer compatibility", analyticsCompatibility(estimate).text),
      reportField("Estimation status", analyticsEstimation(estimate).text),
      reportField(
        "Tokenizer loaded",
        tokenizerAvailable === null ? null : tokenizerAvailable ? "yes" : "no"
      ),
      reportField("Estimation method", context ? context.estimation_method : null),
      reportField("Method notes and limitations", estimate ? estimate.estimation_notes : null),
    ])
  );

  // The breakdown behind those numbers, with the measurement named per row, so an
  // estimate can never be read as a measurement or the other way round.
  const breakdownRows = analyticsBreakdownRows(estimate);
  if (breakdownRows.length > 0) {
    const rowLines = breakdownRows.map(
      (row) =>
        row.label +
        ": " +
        (row.tokens === null ? USAGE_UNAVAILABLE : formatTokens(row.tokens)) +
        " (" +
        row.measurementLabel +
        ")"
    );
    rowLines.push(
      reportField("Measured text tokens", estimate.text_token_count),
      reportField("Estimated request overhead", estimate.breakdown.estimated_overhead_tokens),
      reportField("Total estimated request input", estimate.estimated_input_tokens),
      reportField("Provider-reported actual input", actual ? actual.input_tokens : null),
      reportField(
        "Unaccounted difference",
        discrepancy ? analyticsDiscrepancyText(discrepancy) : null
      ),
      "Note: tokenizer rows count the exact text this app sent; estimated rows are documented rules; the unknown row cannot be measured from here.",
      "Note: the unaccounted difference is the provider's count minus this estimate, and it is not assigned to any single component."
    );
    if (actual && Number.isFinite(actual.cached_input_tokens)) {
      rowLines.push(
        reportField("Cached input (provider, reported separately)", actual.cached_input_tokens) +
          " - already inside the actual input, never added to it again"
      );
    }
    lines.push(...reportSection("TOKEN ESTIMATION BREAKDOWN (SELECTED REQUEST)", rowLines));
  }

  lines.push(
    ...reportSection("CONTEXT BUDGET", [
      reportField("Context window", budget ? budget.context_window_tokens : null),
      reportField("Context window source", analyticsWindowSource(budget)),
      reportField("Context window note", budget ? budget.context_window_note : null),
      reportField(
        "Output allowance, reserved for the answer",
        budget ? budget.max_output_tokens : null
      ),
      reportField("Safety margin", budget ? budget.context_safety_margin_tokens : null),
      reportField("Maximum input budget", budget ? budget.max_input_budget_tokens : null),
      reportField("Estimated input", budget ? budget.estimated_input_tokens : null),
      reportField("Remaining input budget", budget ? budget.remaining_input_budget_tokens : null),
      reportField("Over budget by", budget ? budget.over_budget_tokens : null),
      reportField(
        "Budget utilization",
        budget ? budget.budget_utilization_percent : null,
        formatPercent
      ),
      reportField("Budget status", analyticsBudgetState(budget).text),
      reportField("Request accepted for sending", budget ? (budget.accepted ? "yes" : "no") : null),
      reportField(
        "Estimation confidence",
        budget && budget.estimation_confidence
          ? budget.estimation_confidence
          : estimate
            ? estimate.estimation_confidence
            : null
      ),
      reportField("Budget caveat", budget ? budget.budget_caveat : null),
      reportField("Budget configuration problem", budget ? budget.configuration_problem : null),
    ])
  );

  const callLines = [];
  calls.forEach((item, index) => {
    const itemEstimate = item.estimate;
    const itemActual = item.actual;
    const itemBudget = item.budget;
    const dropped = Number.isFinite(item.dropped_messages) ? item.dropped_messages : 0;
    const number = Number.isFinite(item.call_index) ? item.call_index : index + 1;
    if (index > 0) callLines.push("");
    callLines.push(
      "Call " +
        number +
        " - " +
        contextCallLabel(index, calls.length) +
        (index === selectedIndex ? "  [shown in the panel]" : "")
    );
    callLines.push(
      "  " +
        reportField(
          "Estimated input (app estimate)",
          itemEstimate ? itemEstimate.estimated_input_tokens : null
        )
    );
    callLines.push("  " + reportField("Actual input (provider)", itemActual ? itemActual.input_tokens : null));
    callLines.push("  " + reportField("Actual output (provider)", itemActual ? itemActual.output_tokens : null));
    callLines.push("  " + reportField("Actual total (provider)", itemActual ? itemActual.total_tokens : null));
    callLines.push(
      "  " +
        reportField(
          "Tool definitions counted (schemas plus wrapper)",
          itemEstimate ? itemEstimate.tool_definitions_tokens : null
        )
    );
    callLines.push(
      "  " +
        reportField(
          "Estimation discrepancy",
          item.discrepancy ? analyticsDiscrepancyText(item.discrepancy) : null
        )
    );
    callLines.push("  " + reportField("Rejected before sending", item.rejected ? "yes" : "no"));
    callLines.push(
      "  " + reportField("Accepted for sending", itemBudget ? (itemBudget.accepted ? "yes" : "no") : null)
    );
    callLines.push(
      "  " +
        reportField(
          "Budget utilization",
          itemBudget ? itemBudget.budget_utilization_percent : null,
          formatPercent
        )
    );
    if (item.reduced) {
      callLines.push(
        "  " +
          reportField(
            "Saved history dropped",
            dropped + (dropped === 1 ? " older message left out" : " older messages left out")
          )
      );
      if (item.reduction_note) callLines.push("  " + reportField("Reduction note", item.reduction_note));
    }
  });
  lines.push(
    ...reportSection(
      "API CALL BREAKDOWN",
      calls.length > 0 ? callLines : ["N/A (no model request is recorded for this turn)"]
    )
  );

  // The same arithmetic over the whole turn, counted once per request that was
  // really sent, so a per-call breakdown is never added up twice.
  const estimateTotals = context ? context.estimate_totals : null;
  if (estimateTotals && Number.isFinite(estimateTotals.requests) && estimateTotals.requests > 1) {
    lines.push(
      ...reportSection("TURN ESTIMATE TOTALS", [
        reportField("Model requests added up", estimateTotals.requests),
        reportField("Measured text tokens, all requests", estimateTotals.text_token_count),
        reportField(
          "Estimated request overhead, all requests",
          estimateTotals.estimated_overhead_tokens
        ),
        reportField("Estimated input, all requests", estimateTotals.estimated_input_tokens),
        "Note: each request of this turn is counted exactly once; no per-call breakdown is shared between calls.",
      ])
    );
  }

  lines.push(
    ...reportSection("TOOL USAGE", [
      reportField("Tool executions in this turn", usage ? usage.tool_calls : null),
      reportField("Model requests in this turn", usage ? usage.model_calls : null),
      reportField(
        "Tool definitions sent with the selected request",
        estimate ? estimate.tool_definition_count : null
      ),
      reportField(
        "Tool definitions counted (schemas plus wrapper)",
        estimate ? estimate.tool_definitions_tokens : null
      ),
      "Tool names per execution: N/A (the analytics snapshot keeps the tool count, not per-tool records)",
      "Execution status and timing: N/A (not part of the analytics snapshot)",
    ])
  );

  // What compaction did before this turn's first call, when it ran at all.
  const compactionLines = [];
  if (context && context.compaction) {
    const compaction = context.compaction;
    compactionLines.push(
      reportField("Context compaction", analyticsCompactionState(compaction).text),
      reportField("Messages folded into the summary", compaction.compacted_messages),
      reportField("Estimated input before compaction", compaction.estimate_before),
      reportField("Estimated input after compaction", compaction.estimate_after),
      reportField("Compaction target met", compaction.met_target ? "yes" : "no"),
      reportField("Compaction note", compaction.reason)
    );
  }

  lines.push(
    ...reportSection("CONTEXT MANAGEMENT", [
      reportField(
        "Stored messages in this conversation",
        conversation ? conversation.messages.length : null
      ),
      reportField("Messages counted in the selected request", estimate ? estimate.message_count : null),
      reportField("System prompt (app estimate)", estimate ? estimate.system_prompt_tokens : null),
      reportField("Saved conversation history (app estimate)", estimate ? estimate.history_tokens : null),
      reportField("Other input this turn (app estimate)", estimate ? estimate.other_input_tokens : null),
      reportField(
        "Newest user message (app estimate)",
        estimate ? estimate.latest_user_message_tokens : null
      ),
      reportField("Context growth across the turn", context ? context.context_growth_tokens : null),
      reportField("Requests that dropped saved history", reducedCalls),
      reportField("Requests rejected before sending", calls.length > 0 ? rejectedCalls : null),
      reportField("Newest messages replayed as history", LIMITS.historySentToApi),
      "Messages omitted by the history limit: N/A (the snapshot records the limit, not how many older messages were left out)",
      ...compactionLines,
    ])
  );

  // Tool-result management is its own story, so it gets its own section: what was
  // classified, what was replaced, and what that saved. All of these are this app's
  // estimates; the provider-reported counts stay in TOKEN USAGE.
  const toolResultLines = [];
  const toolResults = context ? context.tool_results : null;
  if (toolResults && toolResults.available === true) {
    const classes = [toolResults.classified.small, toolResults.classified.normal, toolResults.classified.large, toolResults.classified.critical];
    toolResultLines.push(
      reportField("Tool results in the request", toolResults.results),
      reportField(
        "Classification (small / normal / large / critical)",
        classes.map((value) => (Number.isFinite(value) ? formatTokens(value) : USAGE_UNAVAILABLE)).join(" / ")
      ),
      reportField("Replaced by a managed representation", toolResults.managed_results),
      reportField("Kept exactly as returned", toolResults.unchanged),
      reportField("Original size (estimate)", toolResults.original_tokens),
      reportField("Managed size (estimate)", toolResults.managed_tokens),
      reportField("Estimated tokens saved", toolResults.saved_tokens),
      reportField("Summaries written", toolResults.summarized),
      reportField("Trimmed deterministically", toolResults.trimmed),
      reportField("Raw-result retrievals", toolResults.retrievals),
      reportField(
        "Management requests",
        countPairText(toolResults.management_requests.calls, toolResults.management_requests.failures) +
          " (calls / failures)"
      ),
      reportField(
        "Adaptive passes",
        countPairText(toolResults.adaptive.changed, toolResults.adaptive.passes) + " (changed / passes)"
      ),
      reportField(
        "Retained raw results",
        countPairText(toolResults.store.entries, toolResults.store.bytes) + " (entries / bytes)"
      ),
      "Note: these are this app's tokenizer estimates and are never mixed with the provider-reported counts above.",
      "Note: a management request is a condensing call of this app's own; it is not an agent model call and never appears in Token Usage."
    );
    toolResults.priority.decisions.forEach((decision) => {
      toolResultLines.push(
        "Priority #" +
          decision.index +
          " (" +
          decision.kind +
          ", score " +
          decision.score +
          "): " +
          (decision.reason || "no reason recorded")
      );
    });
    Object.entries(toolResults.skipped_reasons || {}).forEach(([reason, count]) => {
      toolResultLines.push("Left alone " + count + " time(s): " + reason);
    });
    toolResults.notes.forEach((note) => toolResultLines.push("Note: " + note));
    lines.push(...reportSection("TOOL RESULT MANAGEMENT", toolResultLines));
  }

  const warnings = [];
  if (message.error === true) {
    warnings.push("The request failed: " + (message.detail || "the server did not explain why."));
  }
  if (context && context.rejected) {
    warnings.push("The context budget refused the last request before it was sent.");
  }
  if (rejectedCalls > 0) {
    warnings.push(
      rejectedCalls === 1
        ? "1 model request was refused locally by the context budget and never sent."
        : rejectedCalls + " model requests were refused locally by the context budget and never sent."
    );
  }
  if (
    estimate &&
    (estimate.estimation_status !== "exact" || estimate.tokenizer_compatibility !== "compatible")
  ) {
    warnings.push(
      "Tokenizer fallback: estimates come from " +
        (estimate.tokenizer_label || analyticsTokenizerName(estimate, context)) +
        " (" +
        analyticsEstimation(estimate).text.toLowerCase() +
        ", " +
        analyticsCompatibility(estimate).text.toLowerCase() +
        ")."
    );
  }
  if (usage && !usage.available) {
    warnings.push("The provider reported no token usage for this turn, so no actual counts exist.");
  } else if (usage && !usage.complete) {
    warnings.push("The provider reported usage only partly, so some actual counts are N/A.");
  }
  if (usage && usage.derived_total) {
    warnings.push(
      "The turn total was derived by adding the reported input and output, because no total was sent."
    );
  }
  if (budget && budget.configuration_problem) {
    warnings.push("Context budget configuration: " + budget.configuration_problem);
  }
  if (budget && budget.budget_caveat) {
    warnings.push("Context budget caveat: " + budget.budget_caveat);
  }
  if (context && context.compaction && !context.compaction.applied && !context.compaction.reused) {
    warnings.push(
      "Context compaction did not change the request: " +
        (context.compaction.reason || "no reason was reported") +
        "."
    );
  }
  if (toolResults && Number.isFinite(toolResults.management_requests.failures) && toolResults.management_requests.failures > 0) {
    warnings.push(
      toolResults.management_requests.failures +
        " tool-result management request(s) failed, so those results were kept in full."
    );
  }
  lines.push(
    ...reportSection("WARNINGS", warnings.length > 0 ? warnings.map((item) => "- " + item) : ["None."])
  );
  lines.push(
    "End of report. Estimated values are this app's own counts; actual values were reported by the provider."
  );

  // The sections already carry their own spacing, so only runs of blank lines
  // are collapsed. The report stays copy-paste friendly either way.
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

// Copying is refused while a request is in flight, so the clipboard can never
// receive a snapshot that the arriving answer is about to replace.
async function copyAnalyticsReport(button) {
  if (ui.busy) {
    toast("Wait for the current answer to finish, then copy the analysis.", "error");
    return;
  }

  const text = analyticsReportText(analyticsSnapshot());
  if (!text) {
    toast("There is no analytics to copy for this turn.", "error");
    return;
  }

  const ok = await copyText(text);
  markActionDone(button, ok ? "Copied!" : "Failed");
  toast(ok ? "Analytics report copied" : "Copying is blocked by the browser", ok ? "info" : "error");
  if (ok) announce("Analytics report copied to the clipboard");
}

function updateSelectedTurn() {
  el.threadInner.querySelectorAll(".msg--assistant[data-id]").forEach((row) => {
    const selected = Boolean(ui.selectedId) && row.dataset.id === ui.selectedId;
    row.classList.toggle("is-selected", selected);
    const button = row.querySelector('[data-action="inspect"]');
    if (button) button.setAttribute("aria-pressed", selected ? "true" : "false");
  });
}

function selectAnalyticsTurn(messageId) {
  if (!messageId || ui.selectedId === messageId) return;
  ui.selectedId = messageId;
  ui.selectedCall = null;
  updateSelectedTurn();
  renderAnalytics();
}

// Clicking anywhere on an answer moves the panel to that turn. A click that is
// part of selecting text, or that lands on a control, keeps the current turn so
// copying and regenerating never move the panel by accident.
function onThreadSelect(event) {
  if (event.target.closest("[data-action], [data-copy-code], button, a, summary, input, textarea")) {
    return;
  }
  const row = event.target.closest(".msg--assistant");
  if (!row || !row.dataset.id) return;

  const selection = typeof window.getSelection === "function" ? window.getSelection() : null;
  if (selection && !selection.isCollapsed && String(selection).trim()) return;

  selectAnalyticsTurn(row.dataset.id);
}

function openAnalytics() {
  if (!window.matchMedia("(max-width: 1080px)").matches) return;
  el.root.setAttribute("data-analytics", "open");
  if (el.analyticsScrim) el.analyticsScrim.hidden = false;
  if (el.analyticsBtn) el.analyticsBtn.setAttribute("aria-expanded", "true");
}

function closeAnalytics() {
  if (!el.root.hasAttribute("data-analytics")) return;
  el.root.removeAttribute("data-analytics");
  if (el.analyticsScrim) el.analyticsScrim.hidden = true;
  if (el.analyticsBtn) el.analyticsBtn.setAttribute("aria-expanded", "false");
}

async function onAnalyticsClick(event) {
  const trigger = event.target.closest("[data-action]");
  if (!trigger) return;
  const action = trigger.dataset.action;

  if (action === "close-analytics") {
    closeAnalytics();
    return;
  }

  if (action === "copy-analysis") {
    await copyAnalyticsReport(trigger);
    return;
  }

  if (action === "select-call") {
    const index = Number(trigger.dataset.index);
    if (!Number.isInteger(index)) return;
    ui.selectedCall = index;
    renderAnalytics();
  }
}

// The button that points the analytics panel at one answer. It stays visible in
// the action row and states its pressed state, so the panel and the selected
// turn can never disagree.
function analyticsInspectButton(message) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "msg__action";
  button.dataset.action = "inspect";
  button.title = "Show this turn in the analytics panel";
  button.setAttribute("aria-pressed", message.id === ui.selectedId ? "true" : "false");
  button.innerHTML = iconMarkup("gauge") + "<span>Analytics</span>";
  return button;
}

function messageActions(isLast, message) {
  const actions = document.createElement("div");
  actions.className = "msg__actions";

  // Left: this response's context estimate and its token usage, both kept
  // outside the message bubble.
  const contextIndicator = buildContextIndicator(message);
  if (contextIndicator) actions.appendChild(contextIndicator);

  const indicator = buildUsageIndicator(message);
  if (indicator) actions.appendChild(indicator);

  // Right: the response actions, revealed on hover exactly like before.
  const buttons = document.createElement("div");
  buttons.className = "msg__actions__buttons";

  buttons.appendChild(analyticsInspectButton(message));

  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "msg__action";
  copy.dataset.action = "copy-message";
  copy.title = "Copy this answer";
  copy.innerHTML = iconMarkup("copy") + "<span>Copy</span>";
  buttons.appendChild(copy);

  if (isLast && !ui.busy) {
    const again = document.createElement("button");
    again.type = "button";
    again.className = "msg__action";
    again.dataset.action = "regenerate";
    again.title = "Ask the model again";
    again.innerHTML = iconMarkup("refresh") + "<span>Regenerate</span>";
    buttons.appendChild(again);
  }

  actions.appendChild(buttons);
  return actions;
}

function renderMessage(conversation, message, index) {
  const row = document.createElement("article");
  row.className = "msg msg--" + message.role;
  row.dataset.id = message.id;

  // The selected answer is the one the analytics panel describes.
  if (message.role === "assistant" && message.id === ui.selectedId) {
    row.classList.add("is-selected");
  }

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

    // A refused request still carries the numbers that explain why it was refused.
    const refusedContext = buildContextIndicator(message);
    if (refusedContext) {
      body.appendChild(refusedContext);
      const actions = document.createElement("div");
      actions.className = "msg__actions";
      const buttons = document.createElement("div");
      buttons.className = "msg__actions__buttons";
      buttons.appendChild(analyticsInspectButton(message));
      actions.appendChild(buttons);
      body.appendChild(actions);
    }
  } else {
    const panel = document.createElement("div");
    panel.className = "msg__panel md";
    panel.innerHTML = renderMarkdown(message.content);
    body.append(panel, messageActions(isLast, message));
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
  // The analytics selection is resolved first, because renderMessage marks the
  // row the panel is describing.
  const conversation = syncSelectedTurn();
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
  renderAnalytics();
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
    // The id travels with the message so the server can record which stored
    // message a compaction summary covers. It is never sent to the model.
    .map((item) => ({ role: item.role, content: item.content, id: item.id }));
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
  let failureContext = null;
  let failureCompaction = null;
  let data = null;

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: userMessage.content,
        history: historyPayload(conversation, userIndex),
        // The summary of the older part of this conversation, if it has one. The
        // server sanitises it and ignores anything that is not that shape.
        compaction: conversation.compaction || null,
      }),
    });

    try {
      data = await response.json();
    } catch (error) {
      data = null;
    }

    if (!response.ok) {
      const error = new Error(
        (data && data.detail) || "The server could not answer. Please try again."
      );
      // A refused request also sends the context numbers that explain it, and the
      // summary compaction managed to produce before the request was judged.
      if (data && data.context) error.context = data.context;
      if (data && data.compaction) error.compaction = data.compaction;
      throw error;
    }
    reply =
      data && typeof data.reply === "string" && data.reply.trim()
        ? data.reply
        : "(The model returned an empty response.)";
  } catch (error) {
    failure = error && error.message ? error.message : "Something went wrong. Please try again.";
    failureContext = cleanContext(error && error.context);
    failureCompaction = cleanCompaction(error && error.compaction);
  }

const target = state.conversations.find((item) => item.id === conversationId);
  if (target) {
    if (failure) {
      const refused = {
        id: uid("m"),
        role: "assistant",
        content: failure,
        detail: failure,
        error: true,
        at: Date.now(),
      };
      if (failureContext) refused.context = failureContext;
      // A refused turn can still have produced a summary, so it is kept: the next
      // message then does not have to summarise the same history again.
      if (failureCompaction) target.compaction = failureCompaction;
      target.messages.push(refused);
      // A refused request is still a turn worth explaining, so the panel moves
      // to it: its numbers are the reason the request was refused.
      ui.selectedId = refused.id;
      ui.selectedCall = null;
      announce("The request failed");
      toast(failure, "error");
    } else {
      // The usage and the context estimate belong to this assistant message
      // only, and are sanitized before they are stored so a partial provider
      // response can never crash the UI. Estimates and reported usage stay in
      // separate fields.
      const answer = { id: uid("m"), role: "assistant", content: reply, at: Date.now() };
      const usage = cleanUsage(data && data.usage);
      if (usage) answer.usage = usage;
      const context = cleanContext(data && data.context);
      if (context) answer.context = context;
      // The summary describes the conversation, not this answer, so it is stored
      // beside the messages.
      const compaction = cleanCompaction(data && data.compaction);
      if (compaction) target.compaction = compaction;
      target.messages.push(answer);
      // The newest answer becomes the turn the analytics panel describes, so a
      // fresh reply is never hidden behind an older selection.
      ui.selectedId = answer.id;
      ui.selectedCall = null;
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
  // The summary described those messages, so it goes with them.
  conversation.compaction = null;
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

  if (action === "toggle-usage") {
    const row = trigger.closest(".msg");
    const id = row ? row.dataset.id : "";
    const isOpen = trigger.getAttribute("aria-expanded") === "true";
    if (id) {
      if (isOpen) ui.expandedUsage.delete(id);
      else ui.expandedUsage.add(id);
    }
    setUsageExpanded(trigger, !isOpen);
    return;
  }

  if (action === "toggle-context") {
    const row = trigger.closest(".msg");
    const id = row ? row.dataset.id : "";
    const isOpen = trigger.getAttribute("aria-expanded") === "true";
    if (id) {
      if (isOpen) ui.expandedContext.delete(id);
      else ui.expandedContext.add(id);
    }
    setContextExpanded(trigger, !isOpen);
    return;
  }

  if (action === "inspect") {
    const row = trigger.closest(".msg");
    const id = row ? row.dataset.id : "";
    if (id) {
      selectAnalyticsTurn(id);
      // On a narrow screen the panel is an overlay, so pointing it at a row must
      // also reveal it. On a wide screen the panel is already visible and
      // openAnalytics() deliberately does nothing.
      openAnalytics();
    }
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
    if (el.root.hasAttribute("data-analytics")) {
      closeAnalytics();
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

  // The analytics panel is delegated from its own container, which is never
  // rebuilt, so selecting a request keeps working after every re-render.
  if (el.analyticsBtn) {
    el.analyticsBtn.addEventListener("click", () => {
      if (el.root.hasAttribute("data-analytics")) closeAnalytics();
      else openAnalytics();
    });
  }
  if (el.analyticsScrim) el.analyticsScrim.addEventListener("click", closeAnalytics);
  if (el.analytics) el.analytics.addEventListener("click", onAnalyticsClick);

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
    onThreadSelect(event);
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
    if (!window.matchMedia("(max-width: 1080px)").matches) closeAnalytics();
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