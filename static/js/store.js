

const STATE_KEY = "tokenharbor.chat.v1";
const THEME_KEY = "tokenharbor.theme";
const SIDEBAR_KEY = "tokenharbor.sidebar";

export const LIMITS = {
  conversations: 50,
  messagesPerConversation: 240,
  historySentToApi: 40,
  titleLength: 60,
};

function createMemoryStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
}

export function resolveStorage() {
  try {
    const storage = window.localStorage;
    const probe = "__tokenharbor_probe__";
    storage.setItem(probe, "1");
    storage.removeItem(probe);
    try {
      storage.removeItem("tokenharbor.model");
    } catch (error) {

    }
    return storage;
  } catch (error) {
    return createMemoryStorage();
  }
}

export function uid(prefix = "id") {
  let random = null;
  try {
    random =
      window.crypto && typeof window.crypto.randomUUID === "function"
        ? window.crypto.randomUUID()
        : null;
  } catch (error) {
    random = null;
  }
  if (!random) {
    random = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  }
  return prefix + "_" + random;
}

export function deriveTitle(text) {
  const flat = String(text || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[#*_>`~[\]()]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!flat) return "New chat";
  if (flat.length <= LIMITS.titleLength) return flat;
  const cut = flat.slice(0, LIMITS.titleLength);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 24 ? cut.slice(0, lastSpace) : cut).trim() + "...";
}

export function makeConversation(title = "New chat") {
  const now = Date.now();
  return { id: uid("c"), title, createdAt: now, updatedAt: now, messages: [] };
}

export function sortConversations(list) {
  return list.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

function cleanMessage(raw) {
  if (!raw || typeof raw !== "object") return null;
  const role = raw.role === "user" ? "user" : raw.role === "assistant" ? "assistant" : null;
  if (!role) return null;
  const content = typeof raw.content === "string" ? raw.content : "";
  if (!content.trim()) return null;

  const message = {
    id: typeof raw.id === "string" && raw.id ? raw.id : uid("m"),
    role,
    content,
    at: Number.isFinite(raw.at) ? raw.at : Date.now(),
  };
  if (raw.error === true) {
    message.error = true;
    message.detail = typeof raw.detail === "string" ? raw.detail : "The request failed.";
  }
  return message;
}

function cleanConversation(raw) {
  if (!raw || typeof raw !== "object") return null;
  const title =
    typeof raw.title === "string" && raw.title.trim() ? raw.title.trim().slice(0, 120) : "New chat";
  const messages = Array.isArray(raw.messages)
    ? raw.messages.map(cleanMessage).filter(Boolean).slice(-LIMITS.messagesPerConversation)
    : [];
  const createdAt = Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now();
  return {
    id: typeof raw.id === "string" && raw.id ? raw.id : uid("c"),
    title,
    createdAt,
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : createdAt,
    messages,
  };
}

export function readState(storage) {
  let parsed = null;
  try {
    parsed = JSON.parse(storage.getItem(STATE_KEY) || "null");
  } catch (error) {
    parsed = null;
  }

  const conversations =
    parsed && Array.isArray(parsed.conversations) ? parsed.conversations.map(cleanConversation).filter(Boolean) : [];

  const sorted = sortConversations(conversations).slice(0, LIMITS.conversations);
  if (sorted.length === 0) sorted.push(makeConversation());

  const wanted = parsed && typeof parsed.activeId === "string" ? parsed.activeId : null;
  const activeId = sorted.some((item) => item.id === wanted) ? wanted : sorted[0].id;

  return { conversations: sorted, activeId };
}

export function writeState(storage, state) {
  const payload = {
    version: 1,
    activeId: state.activeId,
    conversations: sortConversations(state.conversations)
      .slice(0, LIMITS.conversations)
      .map((conversation) => ({
        id: conversation.id,
        title: conversation.title,
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
        messages: conversation.messages.slice(-LIMITS.messagesPerConversation),
      })),
  };
  try {
    storage.setItem(STATE_KEY, JSON.stringify(payload));
    return true;
  } catch (error) {
    return false;
  }
}

function readKey(storage, key) {
  try {
    return storage.getItem(key);
  } catch (error) {
    return null;
  }
}

function writeKey(storage, key, value) {
  try {
    storage.setItem(key, value);
  } catch (error) {

  }
}

export function readTheme(storage) {
  return readKey(storage, THEME_KEY);
}

export function writeTheme(storage, theme) {
  writeKey(storage, THEME_KEY, theme);
}

export function readSidebarState(storage) {
  return readKey(storage, SIDEBAR_KEY);
}

export function writeSidebarState(storage, value) {
  writeKey(storage, SIDEBAR_KEY, value);
}
