const STORAGE_KEY = "python-ai.chat.v1";
const LEGACY_STORAGE_KEY = "tokenharbor.chat.v1";
const THEME_KEY = "tokenharbor.theme";
const SIDEBAR_KEY = "tokenharbor.sidebar";
const THEMES = [
  { id: "chatgpt-dark", name: "Dark", note: "Classic dark ChatGPT mode", mark: "◐", family: "dark" },
  { id: "chatgpt-light", name: "Light", note: "Clean light ChatGPT mode", mark: "◉", family: "light" },
];

const UNAVAILABLE = "Unavailable";
const AVATAR_FALLBACK = "/static/avatar-default.svg";

const ICONS = {
  model: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v4M12 17v4M3 12h4M17 12h4" /><circle cx="12" cy="12" r="3.2" /></svg>',
  tokens: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 19V5m0 14h16" /><path d="M8 15v-3m4 3V9m4 3v-5" /></svg>',
  context: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8" /><path d="M12 12 16.5 8" /></svg>',
  tools: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14.7 6.3a3.7 3.7 0 0 0 5 5l-7.9 7.9-5-5 7.9-7.9Z" /><path d="m6.3 17.7-2.6 2.6" /></svg>',
  compaction: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h16M4 12h16M4 16h10" /></svg>',
  dots: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" /></svg>',
  rename: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4l10-10-4-4L4 16v4Z" /><path d="m13.5 6.5 4 4" /></svg>',
  trash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M10 7V5h4v2M6.5 7l1 12h9l1-12" /></svg>',
};

const elements = {
  root: document.documentElement,
  sidebar: document.getElementById("sidebar"),
  mobileScrim: document.getElementById("mobile-scrim"),
  conversationList: document.getElementById("conversation-list"),
  conversationCount: document.getElementById("conversation-count"),
  noConversations: document.getElementById("no-conversations"),
  search: document.getElementById("conversation-search"),
  activeTitle: document.getElementById("active-title"),
  modelLabel: document.getElementById("model-label"),
  thread: document.getElementById("thread"),
  messageList: document.getElementById("message-list"),
  composer: document.getElementById("composer"),
  input: document.getElementById("message-input"),
  sendButton: document.getElementById("send-button"),
  insights: document.getElementById("insights-panel"),
  insightsContent: document.getElementById("conversation-insights"),
  insightsEyebrow: document.getElementById("insights-eyebrow"),
  insightsTitle: document.getElementById("insights-title"),
  copyAnalytics: document.getElementById("copy-analytics"),
  themeName: document.getElementById("current-theme-name"),
  themeDialog: document.getElementById("theme-dialog"),
  themeGrid: document.getElementById("theme-grid"),
  renameDialog: document.getElementById("rename-dialog"),
  renameForm: document.getElementById("rename-form"),
  renameInput: document.getElementById("rename-input"),
  deleteDialog: document.getElementById("delete-dialog"),
  deleteForm: document.getElementById("delete-form"),
};

function createConversation() {
  const now = Date.now();
  return {
    id: makeId(),
    title: "New conversation",
    createdAt: now,
    updatedAt: now,
    messages: [],
    summary: "",
    compactionCount: 0,
    lastCompactionInputTokens: null,
  };
}

function makeId() {
  if (window.crypto && typeof window.crypto.randomUUID === "function") {
    return window.crypto.randomUUID();
  }
  return `orbit_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function readSavedState(key) {
  try {
    return JSON.parse(localStorage.getItem(key) || "null");
  } catch (error) {
    return null;
  }
}

function normalizeMessage(raw) {
  if (!raw || typeof raw !== "object" || !["user", "assistant"].includes(raw.role)) {
    return null;
  }
  return {
    id: raw.id || makeId(),
    role: raw.role,
    content: typeof raw.content === "string" ? raw.content : String(raw.content || ""),
    createdAt: raw.createdAt || raw.timestamp || Date.now(),
    usage: raw.usage || null,
    compaction: raw.compaction || null,
    retryUserId: raw.retryUserId || null,
    requestUserId: raw.requestUserId || null,
    toolCalls: Array.isArray(raw.toolCalls) ? raw.toolCalls : null,
    retryPrompt: typeof raw.retryPrompt === "string" ? raw.retryPrompt : null,
    model: raw.model || null,
    isError: raw.isError === true,
  };
}

function normalizeConversation(raw) {
  if (!raw || typeof raw !== "object") {
    return createConversation();
  }
  const oldCompaction = raw.compaction && typeof raw.compaction === "object" ? raw.compaction : {};
  const messages = Array.isArray(raw.messages) ? raw.messages.map(normalizeMessage).filter(Boolean) : [];
  return {
    id: raw.id || makeId(),
    title: typeof raw.title === "string" && raw.title.trim() ? raw.title : "New conversation",
    createdAt: raw.createdAt || Date.now(),
    updatedAt: raw.updatedAt || raw.createdAt || Date.now(),
    messages,
    summary: typeof raw.summary === "string" ? raw.summary : (oldCompaction.summary || ""),
    compactionCount: Number(raw.compactionCount ?? oldCompaction.count) || 0,
    lastCompactionInputTokens:
      raw.lastCompactionInputTokens ?? oldCompaction.triggered_input_tokens ?? null,
  };
}

function readState() {
  const current = readSavedState(STORAGE_KEY);
  const previous = readSavedState(LEGACY_STORAGE_KEY);
  const conversationsById = new Map();
  for (const saved of [previous, current]) {
    if (!saved || !Array.isArray(saved.conversations)) continue;
    for (const item of saved.conversations) {
      const conversation = normalizeConversation(item);
      conversationsById.set(conversation.id, conversation);
    }
  }

  const conversations = Array.from(conversationsById.values());
  if (!conversations.length) conversations.push(createConversation());
  conversations.sort((a, b) => timestampValue(b.updatedAt) - timestampValue(a.updatedAt));
  let activeId = current?.activeId || previous?.activeId || conversations[0].id;
  if (!conversations.some((conversation) => conversation.id === activeId)) activeId = conversations[0].id;
  for (const conversation of conversations) {
    let lastUser = null;
    for (let index = 0; index < conversation.messages.length; index += 1) {
      const message = conversation.messages[index];
      if (message.role === "user") lastUser = message;
      if (message.role === "assistant" && !message.retryUserId) {
        const matchingUser = message.retryPrompt
          ? conversation.messages.slice(0, index).reverse().find(
            (item) => item.role === "user" && item.content === message.retryPrompt,
          )
          : null;
        if (matchingUser || lastUser) message.retryUserId = (matchingUser || lastUser).id;
      }
    }
  }
  return { conversations, activeId };
}

const state = readState();
const pendingConversationIds = new Set();
let renameConversationId = null;
let deleteConversationId = null;
let selectedAnalytics = null;
let contextMenu = null;

function activeConversation() {
  return state.conversations.find((conversation) => conversation.id === state.activeId) || state.conversations[0];
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      conversations: state.conversations,
      activeId: state.activeId,
    }));
  } catch (error) {
    showToast("Could not save this conversation in browser storage.");
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function safeInlineMarkdown(text) {
  let html = escapeHtml(text);
  const codeBlocks = [];
  html = html.replace(/`([^`\n]+)`/g, (match, code) => {
    const marker = `ORBITINLINE${codeBlocks.length}X`;
    codeBlocks.push(`<code class="inline-code">${code}</code>`);
    return marker;
  });
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (match, label, href) => {
    const safeHref = href.replaceAll("&amp;", "&");
    return `<a href="${escapeHtml(safeHref)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  });
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/~~(.+?)~~/g, "<del>$1</del>");
  html = html.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  codeBlocks.forEach((code, index) => {
    html = html.replace(`ORBITINLINE${index}X`, code);
  });
  return html;
}

function markdownToHtml(markdown) {
  const fencedBlocks = [];
  const text = String(markdown || "").replace(/```([\w.+-]*)[ \t]*\n?([\s\S]*?)```/g, (match, language, code) => {
    const marker = `ORITBLOCK${fencedBlocks.length}X`;
    const encodedCode = encodeURIComponent(code.replace(/\n$/, ""));
    const label = escapeHtml(language || "code");
    fencedBlocks.push(
      `<div class="code-frame"><div class="code-frame__bar"><span>${label}</span><button class="code-copy" type="button" data-code="${encodedCode}">Copy</button></div><pre><code>${escapeHtml(code.replace(/\n$/, ""))}</code></pre></div>`,
    );
    return `\n${marker}\n`;
  });
  const lines = text.split(/\r?\n/);
  const output = [];
  let paragraph = [];
  let listType = null;

  function flushParagraph() {
    if (paragraph.length) {
      output.push(`<p>${paragraph.map(safeInlineMarkdown).join("<br>")}</p>`);
      paragraph = [];
    }
  }

  function closeList() {
    if (listType) {
      output.push(`</${listType}>`);
      listType = null;
    }
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fencedMatch = line.match(/^ORITBLOCK(\d+)X$/);
    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    const listItem = line.match(/^\s*([-*+]|\d+\.)\s+(.+)$/);
    const quote = line.match(/^\s*>\s?(.*)$/);
    const tableRow = line.includes("|") && index + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[index + 1]);

    if (!line.trim()) {
      flushParagraph();
      closeList();
      continue;
    }
    if (fencedMatch) {
      flushParagraph();
      closeList();
      output.push(fencedBlocks[Number(fencedMatch[1])]);
      continue;
    }
    if (heading) {
      flushParagraph();
      closeList();
      const level = Math.min(heading[1].length + 1, 6);
      output.push(`<h${level}>${safeInlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }
    if (quote) {
      flushParagraph();
      closeList();
      output.push(`<blockquote><p>${safeInlineMarkdown(quote[1])}</p></blockquote>`);
      continue;
    }
    if (tableRow) {
      flushParagraph();
      closeList();
      const headers = splitTableRow(line);
      index += 1;
      const rows = [];
      while (index + 1 < lines.length && lines[index + 1].includes("|")) {
        index += 1;
        rows.push(splitTableRow(lines[index]));
      }
      const head = headers.map((cell) => `<th>${safeInlineMarkdown(cell)}</th>`).join("");
      const body = rows.map((row) => `<tr>${row.map((cell) => `<td>${safeInlineMarkdown(cell)}</td>`).join("")}</tr>`).join("");
      output.push(`<div class="table-scroll"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`);
      continue;
    }
    if (listItem) {
      flushParagraph();
      const wantedType = /^\d/.test(listItem[1]) ? "ol" : "ul";
      if (listType !== wantedType) {
        closeList();
        listType = wantedType;
        output.push(`<${listType}>`);
      }
      output.push(`<li>${safeInlineMarkdown(listItem[2])}</li>`);
      continue;
    }
    closeList();
    paragraph.push(line);
  }
  flushParagraph();
  closeList();
  return output.join("");
}

function splitTableRow(line) {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

function formatTime(timestamp) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function timestampValue(timestamp) {
  const value = typeof timestamp === "number" ? timestamp : Date.parse(timestamp);
  return Number.isFinite(value) ? value : 0;
}

function relativeDate(timestamp) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "Older";
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  if (day === today) return "Today";
  if (day === today - 86400000) return "Yesterday";
  if (day >= today - 6 * 86400000) return "Previous 7 days";
  return "Older";
}

function makeButton(label, className, action, ariaLabel) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = label;
  if (ariaLabel) button.setAttribute("aria-label", ariaLabel);
  button.addEventListener("click", action);
  return button;
}

function renderConversationList() {
  closeConversationMenu();
  elements.conversationList.replaceChildren();
  const query = elements.search.value.trim().toLowerCase();
  const filtered = state.conversations.filter((conversation) => {
    if (!query) return true;
    return conversation.title.toLowerCase().includes(query) ||
      conversation.messages.some((message) => message.content.toLowerCase().includes(query));
  }).sort((a, b) => timestampValue(b.updatedAt) - timestampValue(a.updatedAt));
  elements.conversationCount.textContent = String(filtered.length);
  elements.noConversations.hidden = filtered.length !== 0;

  const groups = new Map();
  for (const conversation of filtered) {
    const group = relativeDate(conversation.updatedAt);
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(conversation);
  }

  for (const groupName of ["Today", "Yesterday", "Previous 7 days", "Older"]) {
    const groupConversations = groups.get(groupName);
    if (!groupConversations || !groupConversations.length) continue;
    const group = document.createElement("section");
    group.className = "conversation-group";
    const heading = document.createElement("h2");
    heading.className = "conversation-group__title";
    heading.textContent = groupName;
    group.appendChild(heading);
    for (const conversation of groupConversations) {
      group.appendChild(renderConversationRow(conversation));
    }
    elements.conversationList.appendChild(group);
  }
}

function renderConversationRow(conversation) {
  const row = document.createElement("div");
  row.className = `conversation-row${conversation.id === state.activeId ? " is-active" : ""}`;

  const dot = document.createElement("span");
  dot.className = "conversation-row__dot";
  dot.setAttribute("aria-hidden", "true");

  const open = document.createElement("button");
  open.type = "button";
  open.className = "conversation-row__open";
  open.addEventListener("click", () => {
    closeConversationMenu();
    state.activeId = conversation.id;
    saveState();
    renderAll();
    closeMobileSidebar();
  });

  const title = document.createElement("span");
  title.className = "conversation-row__title";
  title.textContent = conversation.title;
  const preview = document.createElement("span");
  preview.className = "conversation-row__preview";
  preview.textContent = conversation.messages.at(-1)?.content || "An empty conversation";
  const time = document.createElement("span");
  time.className = "conversation-row__time";
  time.textContent = formatTime(conversation.updatedAt);
  open.append(title, preview, time);

  const actions = document.createElement("div");
  actions.className = "conversation-row__actions";
  const menuButton = document.createElement("button");
  menuButton.type = "button";
  menuButton.className = "row-action row-action--menu";
  menuButton.setAttribute("aria-label", `Actions for ${conversation.title}`);
  menuButton.setAttribute("aria-haspopup", "menu");
  menuButton.innerHTML = ICONS.dots;
  menuButton.addEventListener("click", (event) => {
    event.stopPropagation();
    if (contextMenu && contextMenu.dataset.conversationId === conversation.id) {
      closeConversationMenu();
    } else {
      openConversationMenu(menuButton, conversation);
    }
  });
  actions.appendChild(menuButton);

  row.append(dot, open, actions);
  return row;
}

function onContextMenuPointerDown(event) {
  if (contextMenu && !contextMenu.contains(event.target)) closeConversationMenu();
}

function onContextMenuKeydown(event) {
  if (event.key === "Escape") closeConversationMenu();
}

function closeConversationMenu() {
  if (!contextMenu) return;
  contextMenu.remove();
  contextMenu = null;
  document.removeEventListener("pointerdown", onContextMenuPointerDown, true);
  document.removeEventListener("keydown", onContextMenuKeydown, true);
  window.removeEventListener("resize", closeConversationMenu);
  window.removeEventListener("scroll", closeConversationMenu, true);
}

function makeContextMenuItem(label, icon, action, variant) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "context-menu__item" + (variant ? ` context-menu__item--${variant}` : "");
  button.setAttribute("role", "menuitem");
  button.innerHTML = `${icon}<span></span>`;
  button.querySelector("span").textContent = label;
  button.addEventListener("click", action);
  return button;
}

function openConversationMenu(trigger, conversation) {
  closeConversationMenu();
  const menu = document.createElement("div");
  menu.className = "context-menu";
  menu.setAttribute("role", "menu");
  menu.dataset.conversationId = conversation.id;
  menu.append(
    makeContextMenuItem("Rename", ICONS.rename, () => {
      closeConversationMenu();
      openRenameDialog(conversation);
    }),
    makeContextMenuItem("Delete", ICONS.trash, () => {
      closeConversationMenu();
      openDeleteDialog(conversation);
    }, "danger"),
  );
  document.body.appendChild(menu);
  contextMenu = menu;

  const triggerRect = trigger.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  const isRtl = getComputedStyle(menu).direction === "rtl";
  let top = triggerRect.bottom + 6;
  if (top + menuRect.height > window.innerHeight - 8) {
    top = Math.max(8, triggerRect.top - menuRect.height - 6);
  }
  let left = isRtl ? triggerRect.left : triggerRect.right - menuRect.width;
  left = Math.min(Math.max(8, left), window.innerWidth - menuRect.width - 8);
  menu.style.top = `${top}px`;
  menu.style.left = `${left}px`;

  document.addEventListener("pointerdown", onContextMenuPointerDown, true);
  document.addEventListener("keydown", onContextMenuKeydown, true);
  window.addEventListener("resize", closeConversationMenu);
  window.addEventListener("scroll", closeConversationMenu, true);
}

function getUsageValue(usage, name, alternateName) {
  if (!usage) return null;
  const direct = usage[name] ?? usage[alternateName];
  if (direct !== undefined && direct !== null) return direct;
  const providerUsage = usage.provider_usage || {};
  if (name === "cached_tokens") {
    return providerUsage.cached_tokens ??
      providerUsage.cache_read_input_tokens ??
      providerUsage.input_tokens_details?.cached_tokens ??
      providerUsage.prompt_tokens_details?.cached_tokens ??
      null;
  }
  if (name === "reasoning_tokens") {
    return providerUsage.reasoning_tokens ??
      providerUsage.completion_tokens_details?.reasoning_tokens ??
      providerUsage.output_tokens_details?.reasoning_tokens ??
      null;
  }
  if (usage.totals) {
    const oldName = name === "cached_tokens" ? "cached_input_tokens" : name;
    return usage.totals[oldName] ?? null;
  }
  return null;
}

function insightRow(label, value) {
  const row = document.createElement("div");
  row.className = "insight-row";
  const labelEl = document.createElement("span");
  labelEl.className = "insight-row__label";
  labelEl.textContent = label;
  const valueEl = document.createElement("span");
  valueEl.className = "insight-row__value";
  if (value === null || value === undefined || value === "" ||
      (typeof value === "number" && !Number.isFinite(value))) {
    valueEl.classList.add("is-unavailable");
    valueEl.textContent = UNAVAILABLE;
  } else {
    valueEl.textContent = typeof value === "number" && Number.isFinite(value)
      ? value.toLocaleString()
      : String(value);
  }
  row.append(labelEl, valueEl);
  return row;
}

function insightNote(text) {
  const el = document.createElement("p");
  el.className = "insight-note-inline";
  el.textContent = text;
  return el;
}

function insightCard(icon, title, ...children) {
  const card = document.createElement("section");
  card.className = "insight-card";
  const head = document.createElement("div");
  head.className = "insight-card__head";
  const iconEl = document.createElement("span");
  iconEl.className = "insight-card__icon";
  iconEl.innerHTML = icon;
  const titleEl = document.createElement("h3");
  titleEl.className = "insight-card__title";
  titleEl.textContent = title;
  head.append(iconEl, titleEl);
  card.append(head, ...children);
  return card;
}

function getSelectedMessageContext(conversation, message) {
  if (message.role === "assistant") return message;
  const linkedResponses = conversation.messages.filter(
    (item) => item.role === "assistant" &&
      (item.requestUserId === message.id || (!item.requestUserId && item.retryUserId === message.id)),
  );
  return linkedResponses.length === 1 ? linkedResponses[0] : null;
}

function getCompactionOccurred(compaction, requestMessage) {
  if (typeof compaction?.occurred === "boolean") return compaction.occurred;
  if (compaction?.summary) return true;
  return requestMessage && !requestMessage.isError ? false : null;
}

function getCompactionReduction(compaction) {
  const before = compaction?.before_input_tokens ?? compaction?.triggered_input_tokens;
  const after = compaction?.after_input_tokens;
  if (typeof before !== "number" || !Number.isFinite(before) ||
      typeof after !== "number" || !Number.isFinite(after)) {
    return null;
  }
  return before - after;
}

function getToolCallNames(toolCalls) {
  return toolCalls.map((call) => (typeof call === "string" ? call : call?.name))
    .filter((name) => typeof name === "string" && name);
}

function renderInsights() {
  const conversation = activeConversation();
  const latest = [...conversation.messages].reverse().find(
    (message) => message.role === "assistant" && !message.isError,
  );
  elements.modelLabel.textContent = latest?.model || "AI assistant";
  const selectedMessage = selectedAnalytics?.conversationId === conversation.id
    ? conversation.messages.find((message) => message.id === selectedAnalytics.messageId) || null
    : null;
  elements.insightsContent.replaceChildren();
  if (!selectedMessage) {
    elements.insightsEyebrow.textContent = "MESSAGE ANALYTICS";
    elements.insightsTitle.textContent = "Request analytics";
    elements.insightsContent.replaceChildren();
    return;
  }

  const requestMessage = getSelectedMessageContext(conversation, selectedMessage);
  elements.insightsEyebrow.textContent = "SELECTED MESSAGE";
  elements.insightsTitle.textContent = "Request analytics";

  const usage = requestMessage?.usage;
  const tokenCard = insightCard(ICONS.tokens, "Token Usage");
  tokenCard.append(
    insightRow("Actual input tokens", getUsageValue(usage, "input_tokens", "prompt_tokens")),
    insightRow("Actual output tokens", getUsageValue(usage, "output_tokens", "completion_tokens")),
    insightRow("Actual total tokens", getUsageValue(usage, "total_tokens")),
  );
  const cachedTokens = getUsageValue(usage, "cached_tokens", "cached_input_tokens");
  const reasoningTokens = getUsageValue(usage, "reasoning_tokens");
  if (cachedTokens !== null && cachedTokens !== undefined) {
    tokenCard.appendChild(insightRow("Cached input tokens", cachedTokens));
  }
  if (reasoningTokens !== null && reasoningTokens !== undefined) {
    tokenCard.appendChild(insightRow("Reasoning tokens", reasoningTokens));
  }
  elements.insightsContent.appendChild(tokenCard);

  const compactionCard = insightCard(ICONS.compaction, "Compaction");
  const compaction = requestMessage?.compaction;
  const compactionOccurred = getCompactionOccurred(compaction, requestMessage);
  compactionCard.append(
    insightRow("Configured trigger threshold", compaction?.trigger_threshold ?? null),
    insightRow(
      "Compaction",
      compactionOccurred === null ? null : (compactionOccurred ? "Occurred" : "No compaction"),
    ),
  );
  if (compactionOccurred) {
    const beforeTokens = compaction.before_input_tokens ?? compaction.triggered_input_tokens;
    const afterTokens = compaction.after_input_tokens;
    compactionCard.append(
      insightRow(
        "Provider-reported input tokens",
        `Before: ${analyticsTextValue(beforeTokens)} → After: ${analyticsTextValue(afterTokens)}`,
      ),
    );
    if (afterTokens === null || afterTokens === undefined) {
      compactionCard.appendChild(
        insightNote("This compaction flow does not measure post-compaction context size."),
      );
    }
    const reduction = getCompactionReduction(compaction);
    if (reduction !== null) {
      compactionCard.appendChild(insightRow("Actual token reduction", reduction));
    }

    const summaryUsage = compaction.summary_usage;
    if (summaryUsage) {
      const summaryValues = [
        ["Summary input tokens", getUsageValue(summaryUsage, "input_tokens", "prompt_tokens")],
        ["Summary output tokens", getUsageValue(summaryUsage, "output_tokens", "completion_tokens")],
        ["Summary total tokens", getUsageValue(summaryUsage, "total_tokens")],
        ["Summary cached input tokens", getUsageValue(summaryUsage, "cached_tokens", "cached_input_tokens")],
        ["Summary reasoning tokens", getUsageValue(summaryUsage, "reasoning_tokens")],
      ];
      const availableSummaryValues = summaryValues.filter(([, value]) => value !== null && value !== undefined);
      if (availableSummaryValues.length) {
        compactionCard.appendChild(insightNote("Summary generation provider usage"));
        for (const [label, value] of availableSummaryValues) {
          compactionCard.appendChild(insightRow(label, value));
        }
      }
    }
  }
  elements.insightsContent.appendChild(compactionCard);

  const toolsCard = insightCard(ICONS.tools, "Tool Calls");
  const toolCalls = requestMessage?.toolCalls;
  if (Array.isArray(toolCalls)) {
    toolsCard.appendChild(insightRow("Total executed calls", toolCalls.length));
    const toolNames = getToolCallNames(toolCalls);
    if (!toolNames.length) {
      toolsCard.appendChild(insightNote("No tools executed."));
    }
    for (const name of toolNames) {
      const toolName = document.createElement("div");
      toolName.className = "insight-tool-name";
      toolName.textContent = name;
      toolsCard.appendChild(toolName);
    }
  } else {
    toolsCard.appendChild(insightRow("Total executed calls", null));
  }
  elements.insightsContent.appendChild(toolsCard);
}

function analyticsTextValue(value) {
  if (value === null || value === undefined || value === "" ||
      (typeof value === "number" && !Number.isFinite(value))) {
    return UNAVAILABLE;
  }
  return typeof value === "number" && Number.isFinite(value) ? value.toLocaleString() : String(value);
}

function buildAnalyticsText(conversation, selectedMessage) {
  const requestMessage = getSelectedMessageContext(conversation, selectedMessage);
  const usage = requestMessage?.usage;
  const compaction = requestMessage?.compaction;
  const compactionOccurred = getCompactionOccurred(compaction, requestMessage);
  const toolCalls = requestMessage?.toolCalls;
  const lines = [
    "Request Analytics",
    `Model: ${analyticsTextValue(requestMessage?.model)}`,
    "",
    "Provider-reported token usage",
    `Input tokens: ${analyticsTextValue(getUsageValue(usage, "input_tokens", "prompt_tokens"))}`,
    `Output tokens: ${analyticsTextValue(getUsageValue(usage, "output_tokens", "completion_tokens"))}`,
    `Total tokens: ${analyticsTextValue(getUsageValue(usage, "total_tokens"))}`,
  ];
  const cachedTokens = getUsageValue(usage, "cached_tokens", "cached_input_tokens");
  const reasoningTokens = getUsageValue(usage, "reasoning_tokens");
  if (cachedTokens !== null && cachedTokens !== undefined) {
    lines.push(`Cached input tokens: ${analyticsTextValue(cachedTokens)}`);
  }
  if (reasoningTokens !== null && reasoningTokens !== undefined) {
    lines.push(`Reasoning tokens: ${analyticsTextValue(reasoningTokens)}`);
  }
  lines.push(
    "",
    "Compaction",
    `Configured trigger threshold: ${analyticsTextValue(compaction?.trigger_threshold)}${compaction?.trigger_threshold == null ? "" : " tokens"}`,
    `Occurred: ${compactionOccurred === null ? UNAVAILABLE : (compactionOccurred ? "Yes" : "No")}`,
  );

  if (compactionOccurred) {
    lines.push(
      `Before (provider-reported input tokens): ${analyticsTextValue(compaction.before_input_tokens ?? compaction.triggered_input_tokens)}`,
      `After: ${analyticsTextValue(compaction.after_input_tokens)}`,
    );
    if (compaction.after_input_tokens === null || compaction.after_input_tokens === undefined) {
      lines.push("Note: The current compaction flow does not measure post-compaction context size.");
    }
    const reduction = getCompactionReduction(compaction);
    if (reduction !== null) lines.push(`Actual token reduction: ${analyticsTextValue(reduction)}`);
    const summaryUsage = compaction.summary_usage;
    if (summaryUsage) {
      lines.push(
        "",
        "Summary generation provider usage",
        `Input tokens: ${analyticsTextValue(getUsageValue(summaryUsage, "input_tokens", "prompt_tokens"))}`,
        `Output tokens: ${analyticsTextValue(getUsageValue(summaryUsage, "output_tokens", "completion_tokens"))}`,
        `Total tokens: ${analyticsTextValue(getUsageValue(summaryUsage, "total_tokens"))}`,
        `Cached input tokens: ${analyticsTextValue(getUsageValue(summaryUsage, "cached_tokens", "cached_input_tokens"))}`,
        `Reasoning tokens: ${analyticsTextValue(getUsageValue(summaryUsage, "reasoning_tokens"))}`,
      );
    }
  }

  lines.push("", "Tool calls");
  if (Array.isArray(toolCalls)) {
    lines.push(`Total: ${toolCalls.length}`, "Executed tools:");
    const toolNames = getToolCallNames(toolCalls);
    lines.push(...(toolNames.length ? toolNames.map((name) => `- ${name}`) : ["- None"]));
  } else {
    lines.push(`Total: ${UNAVAILABLE}`, `Executed tools: ${UNAVAILABLE}`);
  }
  return lines.join("\n");
}

async function copyTextToClipboard(text) {
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (error) {
    // Fall through to the legacy copy method.
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("aria-hidden", "true");
  textarea.tabIndex = -1;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";
  document.body.appendChild(textarea);
  try {
    textarea.focus();
    textarea.select();
    return typeof document.execCommand === "function" && document.execCommand("copy");
  } catch (error) {
    return false;
  } finally {
    textarea.remove();
  }
}

async function copySelectedAnalytics() {
  const conversation = activeConversation();
  const selectedMessage = selectedAnalytics?.conversationId === conversation.id
    ? conversation.messages.find((message) => message.id === selectedAnalytics.messageId) || null
    : null;
  if (!selectedMessage) {
    showToast("Choose Analyze on a message before copying analytics.");
    return;
  }

  try {
    const copied = await copyTextToClipboard(buildAnalyticsText(conversation, selectedMessage));
    showToast(copied ? "Analytics copied to clipboard." : "Could not copy analytics to the clipboard.");
  } catch (error) {
    showToast("Could not copy analytics to the clipboard.");
  }
}

function selectMessageForAnalysis(message) {
  const isSameSelection = selectedAnalytics?.conversationId === state.activeId &&
    selectedAnalytics.messageId === message.id;
  if (isSameSelection && elements.insights.classList.contains("is-open")) {
    setAnalyticsOpen(false);
    return;
  }
  selectedAnalytics = { conversationId: state.activeId, messageId: message.id };
  renderThread(false);
  renderInsights();
  setAnalyticsOpen(true);
}

function renderEmptyState() {
  const welcome = document.createElement("div");
  welcome.className = "welcome";
  const visual = document.createElement("div");
  visual.className = "core-visual";
  visual.setAttribute("aria-hidden", "true");
  visual.innerHTML = `
    <div class="core-orbit core-orbit--one"></div>
    <div class="core-orbit core-orbit--two"></div>
    <div class="core-orbit core-orbit--three"></div>
    <div class="core-glass"><span></span></div>
    <div class="core-spark core-spark--one"></div>
    <div class="core-spark core-spark--two"></div>
    <div class="core-spark core-spark--three"></div>
  `;
  const label = document.createElement("div");
  label.className = "welcome__eyebrow";
  label.innerHTML = '<span></span> YOUR THOUGHT PARTNER';
  const heading = document.createElement("h1");
  heading.innerHTML = "A little space<br />to think <em>bigger.</em>";
  const description = document.createElement("p");
  description.textContent = "Bring a question, a half-formed idea, or a problem you want to untangle.";
  const prompts = document.createElement("div");
  prompts.className = "prompt-chips";
  const suggestions = [
    ["✳", "Help me explore an idea"],
    ["⌘", "Explain something simply"],
    ["↗", "Find a fresh perspective"],
  ];
  suggestions.forEach(([icon, text]) => {
    const button = makeButton(`${icon}  ${text}`, "prompt-chip", () => {
      elements.input.value = `${text}: `;
      elements.input.focus();
      resizeInput();
    });
    prompts.appendChild(button);
  });
  welcome.append(visual, label, heading, description, prompts);
  elements.messageList.appendChild(welcome);
}

function renderMessage(message) {
  const article = document.createElement("article");
  article.className = `message message--${message.role}${message.isError ? " message--error" : ""}`;
  article.dataset.messageId = message.id;
  if (selectedAnalytics?.conversationId === state.activeId &&
      selectedAnalytics.messageId === message.id) {
    article.classList.add("is-analytics-selected");
  }
  const avatar = document.createElement("div");
  avatar.className = `message__avatar message__avatar--${message.role}`;
  if (message.role === "assistant") {
    avatar.textContent = "✳";
  } else {
    const image = document.createElement("img");
    image.className = "message__avatar__image";
    image.src = AVATAR_FALLBACK;
    image.alt = "";
    image.setAttribute("aria-hidden", "true");
    avatar.appendChild(image);
  }
  const content = document.createElement("div");
  content.className = "message__body";
  const heading = document.createElement("div");
  heading.className = "message__heading";
  const speaker = document.createElement("strong");
  speaker.textContent = message.role === "assistant" ? "Orbit" : "You";
  const timestamp = document.createElement("time");
  timestamp.textContent = formatTime(message.createdAt);
  heading.append(speaker, timestamp);
  const bubble = document.createElement("div");
  bubble.className = "message__content";
  const hasPersian = /[\u0591-\u08FF]/.test(message.content || "");
  bubble.setAttribute("dir", hasPersian ? "rtl" : "ltr");
  if (message.role === "assistant" && !message.isError) {
    bubble.innerHTML = markdownToHtml(message.content);
  } else {
    bubble.textContent = message.content;
  }
  content.append(heading, bubble);

  const actions = document.createElement("div");
  actions.className = "message-actions";
  if (message.role === "assistant") {
    actions.append(
      makeButton("Copy", "message-action", async () => {
        try {
          await navigator.clipboard.writeText(message.content);
          showToast("Response copied.");
        } catch (error) {
          showToast("Could not access the clipboard.");
        }
      }),
      makeButton("Retry", "message-action", () => retryResponse(message), "Regenerate this response"),
    );
  }
  actions.append(makeButton("Analyze", "message-action", () => selectMessageForAnalysis(message)));
  content.appendChild(actions);
  article.append(avatar, content);
  return article;
}

function renderPendingMessage() {
  const article = document.createElement("div");
  article.className = "message message--assistant message--pending";
  const avatar = document.createElement("div");
  avatar.className = "message__avatar message__avatar--assistant";
  avatar.textContent = "✳";
  const body = document.createElement("div");
  body.className = "message__body";
  const heading = document.createElement("div");
  heading.className = "message__heading";
  heading.innerHTML = "<strong>Orbit</strong><span>Thinking</span>";
  const dots = document.createElement("div");
  dots.className = "thinking-indicator";
  dots.innerHTML = "<i></i><i></i><i></i>";
  body.append(heading, dots);
  article.append(avatar, body);
  elements.messageList.appendChild(article);
}

function renderThread(scrollToBottom = true) {
  const previousTop = elements.thread.scrollTop;
  const conversation = activeConversation();
  elements.messageList.replaceChildren();
  if (!conversation.messages.length) {
    renderEmptyState();
  } else {
    conversation.messages.forEach((message) => elements.messageList.appendChild(renderMessage(message)));
  }
  if (pendingConversationIds.has(conversation.id)) renderPendingMessage();
  if (scrollToBottom) {
    requestAnimationFrame(() => {
      elements.thread.scrollTo({ top: elements.thread.scrollHeight, behavior: "smooth" });
    });
  } else {
    elements.thread.scrollTop = previousTop;
  }
}

function renderAll(scrollToBottom = true) {
  const conversation = activeConversation();
  if (selectedAnalytics &&
      (selectedAnalytics.conversationId !== conversation.id ||
       !conversation.messages.some((message) => message.id === selectedAnalytics.messageId))) {
    selectedAnalytics = null;
    setAnalyticsOpen(false);
  }
  elements.activeTitle.textContent = conversation.title;
  renderConversationList();
  renderThread(scrollToBottom);
  renderInsights();
  elements.sendButton.disabled = pendingConversationIds.has(conversation.id);
  elements.input.disabled = pendingConversationIds.has(conversation.id);
}

function openNewConversation() {
  const conversation = createConversation();
  state.conversations.unshift(conversation);
  state.activeId = conversation.id;
  elements.search.value = "";
  saveState();
  renderAll();
  elements.input.focus();
}

function showToast(message) {
  let toast = document.querySelector(".toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.className = "toast";
    toast.setAttribute("role", "status");
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.add("is-visible");
  window.clearTimeout(showToast.timeoutId);
  showToast.timeoutId = window.setTimeout(() => toast.classList.remove("is-visible"), 2400);
}

async function requestReply(conversation, userMessage, history) {
  pendingConversationIds.add(conversation.id);
  renderAll();
  const payload = {
    message: userMessage.content,
    history: history.map((message) => ({ role: message.role, content: message.content })),
    compaction: conversation.summary
      ? { summary: conversation.summary, count: conversation.compactionCount }
      : null,
  };
  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || "The request could not be completed.");

    const compaction = data.compaction || null;
    const assistant = {
      id: makeId(),
      role: "assistant",
      content: data.reply || "",
      createdAt: Date.now(),
      retryUserId: userMessage.id,
      requestUserId: userMessage.id,
      usage: data.usage || null,
      compaction,
      model: data.model || null,
      toolCalls: Array.isArray(data.toolCalls) ? data.toolCalls : null,
    };
    conversation.messages.push(assistant);
    if (compaction?.summary) {
      conversation.summary = compaction.summary;
      conversation.compactionCount = Number(compaction.count) || conversation.compactionCount + 1;
      conversation.lastCompactionInputTokens = compaction.triggered_input_tokens ?? null;
    }
    assistant.compactionCount = conversation.compactionCount;
    elements.modelLabel.textContent = assistant.model || "AI assistant";
  } catch (error) {
    conversation.messages.push({
      id: makeId(),
      role: "assistant",
      content: error.message || "The request could not be completed.",
      createdAt: Date.now(),
      retryUserId: userMessage.id,
      requestUserId: userMessage.id,
      isError: true,
    });
  } finally {
    pendingConversationIds.delete(conversation.id);
    conversation.updatedAt = Date.now();
    saveState();
    if (state.activeId === conversation.id) renderAll();
    else renderConversationList();
  }
}

function sendMessage(text) {
  const content = text.trim();
  if (!content) return;
  const conversation = activeConversation();
  if (pendingConversationIds.has(conversation.id)) return;
  const userMessage = { id: makeId(), role: "user", content, createdAt: Date.now() };
  const history = conversation.messages.slice();
  conversation.messages.push(userMessage);
  conversation.updatedAt = Date.now();
  if (conversation.messages.filter((message) => message.role === "user").length === 1) {
    conversation.title = content.replace(/\s+/g, " ").slice(0, 48) || "New conversation";
  }
  saveState();
  renderAll();
  requestReply(conversation, userMessage, history);
}

function retryResponse(message) {
  const conversation = activeConversation();
  if (pendingConversationIds.has(conversation.id)) return;
  const userIndex = conversation.messages.findIndex((item) => item.id === message.retryUserId);
  if (userIndex < 0) {
    showToast("The original message for this response is unavailable.");
    return;
  }
  const userMessage = conversation.messages[userIndex];
  const history = conversation.messages.slice(0, userIndex);
  conversation.messages.splice(userIndex + 1);
  conversation.updatedAt = Date.now();
  saveState();
  renderAll();
  requestReply(conversation, userMessage, history);
}

function openRenameDialog(conversation) {
  renameConversationId = conversation.id;
  elements.renameInput.value = conversation.title;
  elements.renameDialog.showModal();
  elements.renameInput.focus();
  elements.renameInput.select();
}

function openDeleteDialog(conversation) {
  deleteConversationId = conversation.id;
  elements.deleteDialog.showModal();
}

function deleteConversation(id) {
  state.conversations = state.conversations.filter((conversation) => conversation.id !== id);
  if (!state.conversations.length) state.conversations.push(createConversation());
  if (state.activeId === id) state.activeId = state.conversations[0].id;
  saveState();
  renderAll();
}

function readTheme() {
  let theme = null;
  try {
    theme = localStorage.getItem(THEME_KEY);
  } catch (error) {
    return "aurora";
  }
  try {
    const parsed = JSON.parse(theme);
    if (typeof parsed === "string") theme = parsed;
    else if (parsed && typeof parsed.id === "string") theme = parsed.id;
  } catch (error) {
    // Older versions saved the theme name without JSON encoding.
  }
  const migrations = {
    midnight: "chatgpt-dark",
    aurora: "chatgpt-dark",
    ocean: "chatgpt-dark",
    studio: "chatgpt-light",
    cyberpunk: "chatgpt-dark",
    obsidian: "chatgpt-dark",
    pearl: "chatgpt-light",
    solar: "chatgpt-light",
    "midnight-aurora": "chatgpt-dark",
    "obsidian-luxe": "chatgpt-dark",
    "cyberpunk-neon": "chatgpt-dark",
    "emerald-dimension": "chatgpt-dark",
    "cosmic-indigo": "chatgpt-dark",
    "crimson-noir": "chatgpt-dark",
    "arctic-glass": "chatgpt-dark",
    "pearl-luxe": "chatgpt-light",
    "solar-warm": "chatgpt-light",
    "obsidian-champagne": "chatgpt-dark",
    "midnight-amethyst": "chatgpt-dark",
    "forest-jade": "chatgpt-dark",
    "blue-slate": "chatgpt-dark",
    "burgundy-velvet": "chatgpt-dark",
    "mocha-noir": "chatgpt-dark",
    "porcelain-pearl": "chatgpt-light",
    "sage-atelier": "chatgpt-light",
    "sandstone": "chatgpt-light",
    "misty-lavender": "chatgpt-light",
    "arctic-pearl": "chatgpt-light",
    "warm-terracotta": "chatgpt-light",
  };
  const selected = migrations[theme] || theme;
  return THEMES.some((item) => item.id === selected) ? selected : "chatgpt-dark";
}

function applyTheme(theme) {
  if (!THEMES.some((item) => item.id === theme)) return;
  elements.root.dataset.theme = theme;
  const themeInfo = THEMES.find((item) => item.id === theme);
  elements.themeName.textContent = themeInfo.name;
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch (error) {
    showToast("The theme will not be remembered by this browser.");
  }
  elements.themeGrid.querySelectorAll(".theme-card").forEach((card) => {
    const selected = card.dataset.theme === theme;
    card.classList.toggle("is-selected", selected);
    card.setAttribute("aria-pressed", String(selected));
  });
}

function renderThemeOptions() {
  elements.themeGrid.replaceChildren();
  for (const theme of THEMES) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "theme-card";
    button.dataset.theme = theme.id;
    button.dataset.family = theme.family || "dark";
    button.setAttribute("aria-label", `${theme.name}: ${theme.note}`);
    const swatch = document.createElement("span");
    swatch.className = "theme-card__preview";
    swatch.dataset.previewTheme = theme.id;
    swatch.innerHTML = '<i></i><i></i><i></i><span></span>';
    const copy = document.createElement("span");
    copy.className = "theme-card__copy";
    const name = document.createElement("strong");
    name.textContent = theme.name;
    const note = document.createElement("small");
    note.textContent = theme.note;
    copy.append(name, note);
    const mark = document.createElement("span");
    mark.className = "theme-card__mark";
    mark.textContent = theme.mark;
    button.append(swatch, copy, mark);
    button.addEventListener("click", () => applyTheme(theme.id));
    elements.themeGrid.appendChild(button);
  }
}

function resizeInput() {
  elements.input.style.height = "auto";
  elements.input.style.height = `${Math.min(elements.input.scrollHeight, 190)}px`;
}

function openMobileSidebar() {
  setAnalyticsOpen(false);
  elements.sidebar.classList.add("is-open");
  elements.mobileScrim.hidden = false;
  elements.mobileScrim.classList.remove("is-analytics-scrim");
  document.body.classList.add("drawer-open");
}

function closeMobileSidebar() {
  elements.sidebar.classList.remove("is-open");
  elements.mobileScrim.hidden = true;
  elements.mobileScrim.classList.remove("is-analytics-scrim");
  document.body.classList.remove("drawer-open");
}

function setAnalyticsOpen(isOpen) {
  elements.insights.classList.toggle("is-open", isOpen);
  elements.insights.setAttribute("aria-hidden", String(!isOpen));
  document.body.classList.toggle("analytics-open", isOpen);
  const toggle = document.getElementById("toggle-analytics");
  if (toggle) toggle.setAttribute("aria-expanded", String(isOpen));
  const asOverlay = isOpen && window.matchMedia("(max-width: 1024px)").matches;
  if (asOverlay) {
    closeMobileSidebar();
    elements.mobileScrim.hidden = false;
    elements.mobileScrim.classList.add("is-analytics-scrim");
  } else {
    elements.mobileScrim.hidden = true;
    elements.mobileScrim.classList.remove("is-analytics-scrim");
  }
}

function closeAnalytics() {
  setAnalyticsOpen(false);
}

document.getElementById("new-chat").addEventListener("click", openNewConversation);
document.getElementById("collapse-sidebar").addEventListener("click", () => {
  document.body.classList.toggle("sidebar-collapsed");
  try {
    localStorage.setItem(SIDEBAR_KEY, document.body.classList.contains("sidebar-collapsed") ? "collapsed" : "expanded");
  } catch (error) {
    showToast("The sidebar preference could not be saved.");
  }
});
document.getElementById("open-sidebar").addEventListener("click", openMobileSidebar);
document.getElementById("open-themes").addEventListener("click", () => elements.themeDialog.showModal());
document.getElementById("close-themes").addEventListener("click", () => elements.themeDialog.close());
document.getElementById("toggle-analytics").addEventListener("click", () => {
  if (!selectedAnalytics || selectedAnalytics.conversationId !== state.activeId) {
    showToast("Choose Analyze on a message to view its analytics.");
    return;
  }
  setAnalyticsOpen(!elements.insights.classList.contains("is-open"));
});
document.getElementById("close-analytics").addEventListener("click", closeAnalytics);
elements.copyAnalytics.addEventListener("click", copySelectedAnalytics);
elements.mobileScrim.addEventListener("click", () => {
  closeMobileSidebar();
  closeAnalytics();
});
elements.search.addEventListener("input", renderConversationList);
elements.composer.addEventListener("submit", (event) => {
  event.preventDefault();
  const message = elements.input.value;
  elements.input.value = "";
  resizeInput();
  sendMessage(message);
});
elements.input.addEventListener("input", resizeInput);
elements.input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    elements.composer.requestSubmit();
  }
});
elements.messageList.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-code]");
  if (!button) return;
  try {
    await navigator.clipboard.writeText(decodeURIComponent(button.dataset.code));
    button.textContent = "Copied";
    window.setTimeout(() => { button.textContent = "Copy"; }, 1400);
  } catch (error) {
    showToast("Could not access the clipboard.");
  }
});
elements.renameForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const conversation = state.conversations.find((item) => item.id === renameConversationId);
  const title = elements.renameInput.value.trim();
  if (conversation && title) {
    conversation.title = title;
    conversation.updatedAt = Date.now();
    saveState();
    renderAll(false);
  }
  elements.renameDialog.close();
});
elements.deleteForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (deleteConversationId) deleteConversation(deleteConversationId);
  elements.deleteDialog.close();
});
document.getElementById("cancel-rename").addEventListener("click", () => elements.renameDialog.close());
document.getElementById("cancel-delete").addEventListener("click", () => elements.deleteDialog.close());
document.addEventListener("keydown", (event) => {
  const target = event.target;
  const editing = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    openNewConversation();
  } else if (event.key === "/" && !editing) {
    event.preventDefault();
    elements.search.focus();
  } else if (event.key === "Escape") {
    closeMobileSidebar();
    closeAnalytics();
  }
});

function enablePointerAtmosphere() {
  const finePointer = window.matchMedia("(hover: hover) and (pointer: fine)");
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  if (!finePointer.matches || reducedMotion.matches) return;
  let frame = 0;
  let pointerX = 0;
  let pointerY = 0;
  window.addEventListener("pointermove", (event) => {
    pointerX = event.clientX;
    pointerY = event.clientY;
    if (frame) return;
    frame = requestAnimationFrame(() => {
      elements.root.style.setProperty("--pointer-x", `${pointerX}px`);
      elements.root.style.setProperty("--pointer-y", `${pointerY}px`);
      elements.root.style.setProperty("--core-x", `${(pointerX - window.innerWidth / 2) * 0.012}px`);
      elements.root.style.setProperty("--core-y", `${(pointerY - window.innerHeight * 0.45) * 0.012}px`);
      frame = 0;
    });
  }, { passive: true });
}

try {
  if (localStorage.getItem(SIDEBAR_KEY) === "collapsed") document.body.classList.add("sidebar-collapsed");
} catch (error) {
  // The sidebar still works when browser storage is unavailable.
}
renderThemeOptions();
applyTheme(readTheme());
enablePointerAtmosphere();
renderAll(false);
setAnalyticsOpen(false);
window.matchMedia("(max-width: 1024px)").addEventListener("change", () => {
  setAnalyticsOpen(elements.insights.classList.contains("is-open"));
});
