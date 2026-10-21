/**
 * Persistence + small data helpers.
 *
 * Everything the chat needs lives in localStorage: conversations, the chosen
 * theme, the chosen model and the sidebar state. There is no database and no
 * server-side storage - the Python backend stays stateless apart from the API
 * key and the list of models it reads from .env.
 *
 * Functions take the `storage` object as an argument instead of reaching for
 * `window.localStorage` everywhere. That keeps the module testable and lets
 * the app fall back to memory when storage is blocked (private mode).
 */

const STATE_KEY = "tokenharbor.chat.v1";
const THEME_KEY = "tokenharbor.theme";
const SIDEBAR_KEY = "tokenharbor.sidebar";
const MODEL_KEY = "tokenharbor.model";

/** Caps that keep localStorage small and API requests predictable. */
export const LIMITS = {
  conversations: 50,
  messagesPerConversation: 240,
  historySentToApi: 40, // must match the slice on the Python side
  titleLength: 60,
};

/** Stand-in used when localStorage is unavailable (private mode, blocked). */
function createMemoryStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
}

/** Return localStorage when it really works, otherwise an in-memory stand-in. */
export function resolveStorage() {
  try {
    const storage = window.localStorage;
    const probe = "__tokenharbor_probe__";
    storage.setItem(probe, "1");
    storage.removeItem(probe);
    return storage;
  } catch (error) {
    return createMemoryStorage();
  }
}

/** Short, collision-safe id (crypto.randomUUID when the browser has it). */
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

/**
 * Turn the first user message into a readable conversation title: markdown
 * markers and line breaks are removed so the sidebar stays tidy.
 */
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

/** A brand new, empty conversation. */
export function makeConversation(title = "New chat") {
  const now = Date.now();
  return { id: uid("c"), title, createdAt: now, updatedAt: now, messages: [] };
}

/** Newest activity first - the sidebar shows the most recent chats on top. */
export function sortConversations(list) {
  return list.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

/** Drop anything that is not a usable message. */
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

/** Repair one stored conversation: bad fields fall back to safe defaults. */
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

/**
 * Load the saved state. Anything that does not look right is dropped instead
 * of crashing the app, and an empty history always yields one blank chat.
 * @param {Storage} storage
 * @returns {{ conversations: Array, activeId: string }}
 */
export function readState(storage) {
  let parsed = null;
  try {
    parsed = JSON.parse(storage.getItem(STATE_KEY) || "null");
  } catch (error) {
    parsed = null; // corrupt JSON simply starts a fresh session
  }

  const conversations =
    parsed && Array.isArray(parsed.conversations) ? parsed.conversations.map(cleanConversation).filter(Boolean) : [];

  const sorted = sortConversations(conversations).slice(0, LIMITS.conversations);
  if (sorted.length === 0) sorted.push(makeConversation());

  const wanted = parsed && typeof parsed.activeId === "string" ? parsed.activeId : null;
  const activeId = sorted.some((item) => item.id === wanted) ? wanted : sorted[0].id;

  return { conversations: sorted, activeId };
}

/** Save the state, trimming the parts that would otherwise grow forever. */
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
    return false; // e.g. quota exceeded: the session keeps working in memory
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
    /* ignore: the change still applies for this session */
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

/**
 * The model id picked in Settings, or null when nothing was saved yet.
 * The app checks it against the list from /api/config, so a stale value is
 * ignored instead of being sent to the server.
 */
export function readModel(storage) {
  const value = readKey(storage, MODEL_KEY);
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function writeModel(storage, model) {
  writeKey(storage, MODEL_KEY, String(model || ""));
}