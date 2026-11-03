

const STATE_KEY = "tokenharbor.chat.v1";
const THEME_KEY = "tokenharbor.theme";
const SIDEBAR_KEY = "tokenharbor.sidebar";

export const LIMITS = {
  conversations: 50,
  messagesPerConversation: 240,
  historySentToApi: 40,
  titleLength: 60,
  usageCallsPerMessage: 50,
  contextCallsPerMessage: 50,
  compactionSummaryChars: 12000,
  priorityDecisionsPerCall: 8,
  skippedReasonsPerCall: 5,
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

// --- Token usage -----------------------------------------------------------
//
// The backend sends the real usage the provider reported. These helpers keep
// that data when a conversation is saved and read back, and drop anything that
// does not look like a token count. A missing field stays null so the UI can
// say "N/A" instead of guessing 0.
//
// A conversation saved by an older build may still carry estimation fields
// (`*_estimate`, `estimated_*`, tokenizer metadata). They are dropped here rather
// than migrated: every reader rebuilds its object from the fields it knows, so an
// unknown field simply never survives a save/load cycle and no history is lost.

function cleanTokenCount(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return Math.round(value);
}

function cleanUsageCall(raw) {
  if (!raw || typeof raw !== "object") return null;
  return {
    call_index: cleanTokenCount(raw.call_index),
    input_tokens: cleanTokenCount(raw.input_tokens),
    output_tokens: cleanTokenCount(raw.output_tokens),
    total_tokens: cleanTokenCount(raw.total_tokens),
    cached_input_tokens: cleanTokenCount(raw.cached_input_tokens),
    reasoning_tokens: cleanTokenCount(raw.reasoning_tokens),
    reported: raw.reported !== false,
  };
}

export function cleanUsage(raw) {
  if (!raw || typeof raw !== "object") return null;
  const totals = raw.totals && typeof raw.totals === "object" ? raw.totals : {};
  const calls = Array.isArray(raw.calls)
    ? raw.calls.map(cleanUsageCall).filter(Boolean).slice(0, LIMITS.usageCallsPerMessage)
    : [];

  return {
    available: raw.available === true,
    complete: raw.complete === true,
    derived_total: raw.derived_total === true,
    model_calls: cleanTokenCount(raw.model_calls),
    tool_calls: cleanTokenCount(raw.tool_calls),
    totals: {
      input_tokens: cleanTokenCount(totals.input_tokens),
      output_tokens: cleanTokenCount(totals.output_tokens),
      total_tokens: cleanTokenCount(totals.total_tokens),
      cached_input_tokens: cleanTokenCount(totals.cached_input_tokens),
      reasoning_tokens: cleanTokenCount(totals.reasoning_tokens),
    },
    calls,
  };
}

// --- Context, actual usage and compaction ----------------------------------
//
// The runtime does not count tokens locally: every size the server sends is
// provider-reported. These helpers keep that data when a conversation is saved and
// read back, and drop anything that does not look like a real number, so the UI can
// say "N/A" instead of inventing a value.

function cleanText(value, maxLength = 320) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text) return null;
  return text.length > maxLength ? text.slice(0, maxLength - 1) + "\u2026" : text;
}

function cleanEnum(value, allowed) {
  return typeof value === "string" && allowed.includes(value) ? value : null;
}

function cleanBudgetVerdict(raw) {
  if (!raw || typeof raw !== "object") return null;
  return {
    context_window_tokens: cleanTokenCount(raw.context_window_tokens),
    context_window_source: cleanText(raw.context_window_source, 24),
    // Where the window came from: a configured value or nothing usable. Kept
    // separate from the source so the UI can name it.
    context_window_origin: cleanEnum(raw.context_window_origin, [
      "configured",
      "verified",
      "unknown",
    ]),
    context_window_note: cleanText(raw.context_window_note, 400),
    max_output_tokens: cleanTokenCount(raw.max_output_tokens),
    context_safety_margin_tokens: cleanTokenCount(raw.context_safety_margin_tokens),
    max_input_budget_tokens: cleanTokenCount(raw.max_input_budget_tokens),
    configuration_problem: cleanText(raw.configuration_problem, 400),
  };
}

function cleanActualUsage(raw) {
  if (!raw || typeof raw !== "object") return null;
  return {
    input_tokens: cleanTokenCount(raw.input_tokens),
    output_tokens: cleanTokenCount(raw.output_tokens),
    total_tokens: cleanTokenCount(raw.total_tokens),
    cached_input_tokens: cleanTokenCount(raw.cached_input_tokens),
    reasoning_tokens: cleanTokenCount(raw.reasoning_tokens),
  };
}

function cleanContextCall(raw) {
  if (!raw || typeof raw !== "object") return null;
  return {
    call_index: cleanTokenCount(raw.call_index),
    rejected: raw.rejected === true,
    // A provider-reported context-length failure, which carries no token count of its
    // own.
    context_failure: raw.context_failure === true,
    // The provider's reported usage for this call; null when it reported none.
    actual: cleanActualUsage(raw.actual),
  };
}

// --- Compaction -------------------------------------------------------------
//
// Compaction metadata belongs to the conversation, not to one request: the summary
// is what lets older messages stay out of a request without losing what they said.
// It is stored beside the messages, so it survives a reload, and anything that does
// not look like a summary is dropped rather than sent back to the server.

export function cleanCompaction(raw) {
  if (!raw || typeof raw !== "object") return null;
  const summary = typeof raw.summary === "string" ? raw.summary.trim() : "";
  if (!summary) return null;
  return {
    summary: summary.slice(0, LIMITS.compactionSummaryChars),
    summary_version: cleanTokenCount(raw.summary_version),
    last_compacted_message_id: cleanText(raw.last_compacted_message_id, 160),
    last_compacted_at: cleanTokenCount(raw.last_compacted_at),
    compaction_count: cleanTokenCount(raw.compaction_count),
  };
}

// What the post-response compaction decision did with the provider's actual input
// usage. This is a report, never the summary itself. A snapshot written before the
// post-response architecture carries no `post_response` flag, so a report that was
// only marked `attempted` is still accepted.
function cleanCompactionReport(raw) {
  if (!raw || typeof raw !== "object") return null;
  const postResponse = raw.post_response === true;
  if (!postResponse && raw.attempted !== true) return null;
  return {
    post_response: postResponse,
    attempted: raw.attempted === true,
    applied: raw.applied === true,
    reused: raw.reused === true,
    attempts: cleanTokenCount(raw.attempts),
    reason: cleanText(raw.reason, 400),
    compacted_messages: cleanTokenCount(raw.compacted_messages),
    trigger_tokens: cleanTokenCount(raw.trigger_tokens),
    // The provider's actual input usage the decision was made from, and whether the
    // response reported it at all. There is no estimate next to it by design.
    actual_input_tokens: cleanTokenCount(raw.actual_input_tokens),
    usage_available: raw.usage_available === true,
    trigger_exceeded: raw.trigger_exceeded === true,
    summary_requests: cleanTokenCount(raw.summary_requests),
  };
}

// --- Tool result management -------------------------------------------------
//
// What the server did with this turn's tool output: how many results it saw, how it
// classified them, and how many it replaced with a managed representation. Nothing
// here is a token count: the server does not estimate tokens, so it reports counts
// and decisions only.

function cleanSignedCount(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.round(value);
}

function cleanPriorityDecision(raw) {
  if (!raw || typeof raw !== "object") return null;
  const kind = cleanText(raw.kind, 40);
  if (!kind) return null;
  return {
    index: cleanTokenCount(raw.index),
    kind,
    score: cleanSignedCount(raw.score),
    classification: cleanEnum(raw.classification, ["critical", "normal"]),
    reason: cleanText(raw.reason, 400),
  };
}

function cleanReasonCounts(raw) {
  const cleaned = {};
  Object.entries(raw && typeof raw === "object" ? raw : {})
    .slice(0, LIMITS.skippedReasonsPerCall)
    .forEach(([reason, count]) => {
      const text = cleanText(reason, 160);
      const value = cleanTokenCount(count);
      if (text && value !== null) cleaned[text] = value;
    });
  return cleaned;
}

function cleanToolResults(raw) {
  if (!raw || typeof raw !== "object" || raw.available !== true) return null;
  const classified = raw.classified && typeof raw.classified === "object" ? raw.classified : {};
  const priority = raw.priority && typeof raw.priority === "object" ? raw.priority : {};
  const requests =
    raw.management_requests && typeof raw.management_requests === "object" ? raw.management_requests : {};
  const store = raw.store && typeof raw.store === "object" ? raw.store : {};

  return {
    available: true,
    results: cleanTokenCount(raw.results),
    classified: {
      critical: cleanTokenCount(classified.critical),
      normal: cleanTokenCount(classified.normal),
    },
    bytes: cleanTokenCount(raw.bytes),
    managed_bytes: cleanTokenCount(raw.managed_bytes),
    large_candidates: cleanTokenCount(raw.large_candidates),
    large_bytes: cleanTokenCount(raw.large_bytes),
    managed_results: cleanTokenCount(raw.managed_results),
    managed_this_turn: cleanTokenCount(raw.managed_this_turn),
    summarized: cleanTokenCount(raw.summarized),
    trimmed: cleanTokenCount(raw.trimmed),
    unchanged: cleanTokenCount(raw.unchanged),
    retrievals: cleanTokenCount(raw.retrievals),
    passes: cleanTokenCount(raw.passes),
    changed_passes: cleanTokenCount(raw.changed_passes),
    blocked_passes: cleanTokenCount(raw.blocked_passes),
    priority: {
      enabled: priority.enabled === true,
      reducible: cleanTokenCount(priority.reducible),
      decisions: Array.isArray(priority.decisions)
        ? priority.decisions
            .slice(0, LIMITS.priorityDecisionsPerCall)
            .map(cleanPriorityDecision)
            .filter(Boolean)
        : [],
    },
    management_requests: {
      calls: cleanTokenCount(requests.calls),
      failures: cleanTokenCount(requests.failures),
    },
    store: {
      entries: cleanTokenCount(store.entries),
      bytes: cleanTokenCount(store.bytes),
      max_bytes: cleanTokenCount(store.max_bytes),
      evictions: cleanTokenCount(store.evictions),
      refused: cleanTokenCount(store.refused),
    },
    skipped_reasons: cleanReasonCounts(raw.skipped_reasons),
    notes: Array.isArray(raw.notes)
      ? raw.notes.map((note) => cleanText(note, 300)).filter(Boolean).slice(0, 4)
      : [],
  };
}

export function cleanContext(raw) {
  if (!raw || typeof raw !== "object") return null;
  const calls = Array.isArray(raw.calls)
    ? raw.calls.map(cleanContextCall).filter(Boolean).slice(0, LIMITS.contextCallsPerMessage)
    : [];
  const context = {
    available: raw.available === true,
    model: cleanText(raw.model, 120),
    budget: cleanBudgetVerdict(raw.budget),
    model_calls: cleanTokenCount(raw.model_calls),
    // The post-response compaction decision and the tool-result report, neither of
    // which carries an estimate.
    compaction: cleanCompactionReport(raw.compaction),
    tool_results: cleanToolResults(raw.tool_results),
    // Provider-reported context-length failures and the bounded re-sends after them.
    context_failures: cleanTokenCount(raw.context_failures),
    context_retries: cleanTokenCount(raw.context_retries),
    // The usage of the summary-generation calls, kept in a section of its own so it is
    // never mixed with the conversation's own usage.
    management_usage: cleanUsage(raw.management_usage),
    rejected: raw.rejected === true,
    calls,
  };
  if (!context.model && !context.budget && calls.length === 0) return null;
  return context;
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
  // Context and budget belong to the response itself, so they are kept for a
  // refused request too: that is exactly when the numbers explain what happened.
  const context = cleanContext(raw.context);
  if (context) message.context = context;
  if (raw.error === true) {
    message.error = true;
    message.detail = typeof raw.detail === "string" ? raw.detail : "The request failed.";
  } else {
    const usage = cleanUsage(raw.usage);
    if (usage) message.usage = usage;
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
    // A conversation saved before compaction existed simply has none.
    compaction: cleanCompaction(raw.compaction),
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
        // The summary travels with the conversation it describes; null for the
        // conversations that have never been compacted.
        compaction: conversation.compaction || null,
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
