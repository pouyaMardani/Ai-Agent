

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
  breakdownRowsPerCall: 24,
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

// --- Context estimate and budget -------------------------------------------
//
// The backend sends what it estimated BEFORE each model call and what the
// provider reported AFTER it. The two are kept in separate fields here as well,
// and a missing number stays null so the UI can say "N/A" instead of showing a
// zero that would look like a measurement.

function cleanText(value, maxLength = 320) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text) return null;
  return text.length > maxLength ? text.slice(0, maxLength - 1) + "\u2026" : text;
}

function cleanPercent(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return Math.round(value * 10) / 10;
}

function cleanEnum(value, allowed) {
  return typeof value === "string" && allowed.includes(value) ? value : null;
}

function cleanBreakdownRows(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((row) => {
      if (!row || typeof row !== "object") return null;
      const key = cleanText(row.key, 40);
      if (!key) return null;
      return {
        key,
        // A row the app cannot measure carries no number at all, and that stays
        // null so the panel can say "N/A" instead of showing a zero it does not
        // believe.
        tokens: cleanTokenCount(row.tokens),
        measurement: cleanEnum(row.measurement, ["tokenizer", "estimated", "unknown"]),
      };
    })
    .filter(Boolean)
    .slice(0, LIMITS.breakdownRowsPerCall);
}

function cleanBreakdown(raw) {
  if (!raw || typeof raw !== "object") return null;
  const rows = cleanBreakdownRows(raw.rows);
  if (rows.length === 0) return null;
  return {
    rows,
    estimated_overhead_tokens: cleanTokenCount(raw.estimated_overhead_tokens),
    tool_schema_count: cleanTokenCount(raw.tool_schema_count),
  };
}

function cleanEstimate(raw) {
  if (!raw || typeof raw !== "object") return null;
  const estimate = {
    estimated_input_tokens: cleanTokenCount(raw.estimated_input_tokens),
    // What the active tokenizer counted in the request text, next to the
    // request-level estimate above it, plus the per-component breakdown behind
    // both numbers.
    text_token_count: cleanTokenCount(raw.text_token_count),
    breakdown: cleanBreakdown(raw.breakdown),
    estimation_method: cleanText(raw.estimation_method, 80),
    is_exact: raw.is_exact === true,
    system_prompt_tokens: cleanTokenCount(raw.system_prompt_tokens),
    history_tokens: cleanTokenCount(raw.history_tokens),
    tool_definitions_tokens: cleanTokenCount(raw.tool_definitions_tokens),
    other_input_tokens: cleanTokenCount(raw.other_input_tokens),
    // The newest user message is also inside other_input_tokens; it is kept
    // separately because it is the part the person just typed.
    latest_user_message_tokens: cleanTokenCount(raw.latest_user_message_tokens),
    message_count: cleanTokenCount(raw.message_count),
    tool_definition_count: cleanTokenCount(raw.tool_definition_count),
    estimation_notes: cleanText(raw.estimation_notes, 400),
    // Which counting method produced this number, and how far it can be trusted.
    tokenizer_backend: cleanText(raw.tokenizer_backend, 40),
    tokenizer_name: cleanText(raw.tokenizer_name, 160),
    tokenizer_label: cleanText(raw.tokenizer_label, 200),
    tokenizer_compatibility: cleanEnum(raw.tokenizer_compatibility, [
      "compatible",
      "unverified",
      "unsupported",
    ]),
    tokenizer_available: raw.tokenizer_available === true,
    estimation_status: cleanEnum(raw.estimation_status, ["exact", "estimated", "heuristic"]),
    estimation_confidence: cleanText(raw.estimation_confidence, 60),
  };
  if (estimate.estimated_input_tokens === null) return null;
  return estimate;
}

function cleanBudgetVerdict(raw) {
  if (!raw || typeof raw !== "object") return null;
  return {
    context_window_tokens: cleanTokenCount(raw.context_window_tokens),
    context_window_source: cleanText(raw.context_window_source, 24),
    // Where the window came from: a configured value, verified metadata or
    // nothing usable. Kept separate from the source so the UI can name it.
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
    estimated_input_tokens: cleanTokenCount(raw.estimated_input_tokens),
    remaining_input_budget_tokens: cleanTokenCount(raw.remaining_input_budget_tokens),
    over_budget_tokens: cleanTokenCount(raw.over_budget_tokens),
    over_budget: raw.over_budget === true,
    budget_utilization_percent: cleanPercent(raw.budget_utilization_percent),
    budget_state: cleanEnum(raw.budget_state, ["comfortable", "approaching", "over"]),
    // The same judgement in the vocabulary the UI shows, plus the caveat that
    // says when the decision rests on an approximate count.
    budget_status: cleanEnum(raw.budget_status, ["within", "approaching", "over", "unknown"]),
    budget_caveat: cleanText(raw.budget_caveat, 400),
    estimation_confidence: cleanText(raw.estimation_confidence, 60),
    accepted: raw.accepted !== false,
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

function cleanDiscrepancy(raw) {
  if (!raw || typeof raw !== "object") return null;
  const estimated = cleanTokenCount(raw.estimated_input_tokens);
  const actual = cleanTokenCount(raw.actual_input_tokens);
  if (estimated === null || actual === null) return null;
  return {
    estimated_input_tokens: estimated,
    actual_input_tokens: actual,
    difference_tokens: Number.isFinite(raw.difference_tokens)
      ? Math.round(raw.difference_tokens)
      : null,
    difference_percent: cleanPercent(Math.abs(Number(raw.difference_percent))),
    direction: cleanEnum(raw.direction, ["under", "over", "match"]),
  };
}

function cleanContextCall(raw) {
  if (!raw || typeof raw !== "object") return null;
  const estimate = cleanEstimate(raw.estimate);
  if (!estimate) return null;
  return {
    call_index: cleanTokenCount(raw.call_index),
    estimate,
    budget: cleanBudgetVerdict(raw.budget),
    reduced: raw.reduced === true,
    dropped_messages: cleanTokenCount(raw.dropped_messages),
    reduction_note: cleanText(raw.reduction_note, 400),
    rejected: raw.rejected === true,
    actual: cleanActualUsage(raw.actual),
    discrepancy: cleanDiscrepancy(raw.discrepancy),
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

// What compaction did before this turn's first model call, if it ran at all. This
// is a report, never the summary itself.
function cleanCompactionReport(raw) {
  if (!raw || typeof raw !== "object" || raw.attempted !== true) return null;
  return {
    attempted: true,
    applied: raw.applied === true,
    reused: raw.reused === true,
    attempts: cleanTokenCount(raw.attempts),
    reason: cleanText(raw.reason, 400),
    compacted_messages: cleanTokenCount(raw.compacted_messages),
    estimate_before: cleanTokenCount(raw.estimate_before),
    estimate_after: cleanTokenCount(raw.estimate_after),
    met_target: raw.met_target === true,
    trigger_tokens: cleanTokenCount(raw.trigger_tokens),
    target_tokens: cleanTokenCount(raw.target_tokens),
  };
}

// --- Tool result management -------------------------------------------------
//
// What the server did with this turn's tool output: how many results it saw, how it
// classified them, how many it replaced with a managed representation and what that
// saved. Every number here is the server's own tokenizer estimate, so it stays apart
// from the provider-reported usage exactly like the rest of `context`.

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
    tokens: cleanTokenCount(raw.tokens),
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
  const adaptive = raw.adaptive && typeof raw.adaptive === "object" ? raw.adaptive : {};
  const requests =
    raw.management_requests && typeof raw.management_requests === "object" ? raw.management_requests : {};
  const store = raw.store && typeof raw.store === "object" ? raw.store : {};

  return {
    available: true,
    results: cleanTokenCount(raw.results),
    classified: {
      small: cleanTokenCount(classified.small),
      normal: cleanTokenCount(classified.normal),
      large: cleanTokenCount(classified.large),
      critical: cleanTokenCount(classified.critical),
    },
    managed_results: cleanTokenCount(raw.managed_results),
    managed_this_turn: cleanTokenCount(raw.managed_this_turn),
    summarized: cleanTokenCount(raw.summarized),
    trimmed: cleanTokenCount(raw.trimmed),
    unchanged: cleanTokenCount(raw.unchanged),
    original_tokens: cleanTokenCount(raw.original_tokens),
    managed_tokens: cleanTokenCount(raw.managed_tokens),
    saved_tokens: cleanTokenCount(raw.saved_tokens),
    retrievals: cleanTokenCount(raw.retrievals),
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
    adaptive: {
      passes: cleanTokenCount(adaptive.passes),
      changed: cleanTokenCount(adaptive.changed),
      blocked: cleanTokenCount(adaptive.blocked),
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

function cleanEstimateTotals(raw) {
  if (!raw || typeof raw !== "object") return null;
  return {
    requests: cleanTokenCount(raw.requests),
    estimated_input_tokens: cleanTokenCount(raw.estimated_input_tokens),
    text_token_count: cleanTokenCount(raw.text_token_count),
    estimated_overhead_tokens: cleanTokenCount(raw.estimated_overhead_tokens),
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
    estimation_method: cleanText(raw.estimation_method, 80),
    is_exact: raw.is_exact === true,
    // Turn-level tokenizer metadata, describing the method used by the most
    // recent model call of this answer.
    tokenizer_backend: cleanText(raw.tokenizer_backend, 40),
    tokenizer_name: cleanText(raw.tokenizer_name, 160),
    tokenizer_label: cleanText(raw.tokenizer_label, 200),
    tokenizer_compatibility: cleanEnum(raw.tokenizer_compatibility, [
      "compatible",
      "unverified",
      "unsupported",
    ]),
    tokenizer_available: raw.tokenizer_available === true,
    estimation_status: cleanEnum(raw.estimation_status, ["exact", "estimated", "heuristic"]),
    estimation_confidence: cleanText(raw.estimation_confidence, 60),
    model_calls: cleanTokenCount(raw.model_calls),
    reduced_calls: cleanTokenCount(raw.reduced_calls),
    // The turn's own estimate arithmetic, added up once per request that was
    // really sent, so a turn total never counts a breakdown twice.
    estimate_totals: cleanEstimateTotals(raw.estimate_totals),
    compaction: cleanCompactionReport(raw.compaction),
    tool_results: cleanToolResults(raw.tool_results),
    rejected: raw.rejected === true,
    first_call: cleanEstimate(raw.first_call),
    last_call: cleanEstimate(raw.last_call),
    context_growth_tokens: cleanTokenCount(raw.context_growth_tokens),
    calls,
  };
  if (!context.first_call && !context.last_call && calls.length === 0) return null;
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
  // Context estimate and budget belong to the response itself, so they are kept
  // for a refused request too: that is exactly when the numbers explain what
  // happened.
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
