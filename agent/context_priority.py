"""Deterministic priority scoring for the items of one prepared request.

Context management has to decide *what* to reduce before it decides how, so this
module scores every item: higher means "keep this", lower means "reduce this first".
It takes structural facts and tool metadata from the caller and returns a ranked list
with the reasons behind every score; it never measures or estimates tokens and never
calls a model.

The model:

| Kind | Base | Why |
| --- | --- | --- |
| `system` | 1000 | Instructions and honesty rules are never reduced. |
| `tool_unmatched` | 900 | A tool message with no matching tool call is suspicious; leave it alone. |
| `current_user` | 900 | The newest user message is the request being answered. |
| `turn_user` | 500 | A user message added inside the active turn (the loop's reminder). |
| `turn_assistant` | 400 | Assistant text produced in this turn. |
| `history_user` | 300 | An older saved user message. |
| `history_assistant` | 200 | An older saved assistant message. |
| `tool_recent` | 350 | A tool result from the newest round: the model has not read it yet. |
| `tool_older` | 150 | A tool result from an earlier round. |

Modifiers on top, all of them structural or metadata-based:

* `critical` tool result **+200** (its exact error text matters), already managed
  **-50** (and no longer reducible), shares a term with the current request **+150**,
  and age **-2** per message away from the newest, capped at **-200**, so the older
  of two equal items goes first.

There is deliberately no size modifier: the runtime does no local token counting, so
"large" is not a fact this module can know. Ties break by index (older first), and
`reasons` lists every part of a score.
"""

BASE_SCORES = {
    "system": 1000,
    "tool_unmatched": 900,
    "current_user": 900,
    "turn_user": 500,
    "turn_assistant": 400,
    "tool_recent": 350,
    "history_user": 300,
    "history_assistant": 200,
    "tool_older": 150,
}

CRITICAL_GAIN = 200
MANAGED_PENALTY = -50
RELEVANCE_GAIN = 150
AGE_PENALTY_PER_STEP = 2
AGE_PENALTY_MAX = 200

# The current request is compared with tool output using these plain terms: no
# stemming, no language model, so the same input always yields the same decision.
MIN_TERM_LENGTH = 4
MAX_REQUEST_TERMS = 16

# The kinds the adaptive manager may reduce, in the order it prefers to try them.
REDUCIBLE_KINDS = ("history_user", "history_assistant", "tool_older", "tool_recent")


def request_terms(text):
    """Pull the comparison terms out of the current user request, deterministically."""
    terms = []
    for word in str(text or "").lower().split():
        cleaned = "".join(character for character in word if character.isalnum() or character in "_-./")
        if len(cleaned) >= MIN_TERM_LENGTH and cleaned not in terms:
            terms.append(cleaned)
        if len(terms) >= MAX_REQUEST_TERMS:
            break
    return terms


def matched_terms(terms, content):
    """Which request terms appear in one text, for the relevance modifier."""
    haystack = str(content or "").lower()
    return [term for term in terms if term in haystack]


def score_item(kind, index, total, message, info=None, terms=(), enabled=True):
    """Return (score, reasons) for one item, exactly as documented above."""
    info = info or {}
    score = BASE_SCORES.get(kind, 0)
    reasons = [f"{kind} base ({score:+d})"]

    if not enabled:
        # With scoring switched off the base weights and the age decay still order
        # the items deterministically; the report says so.
        reasons.append("priority scoring is disabled: base weights only")

    if info.get("classification") == "critical":
        score += CRITICAL_GAIN
        reasons.append(f"critical tool result ({CRITICAL_GAIN:+d})")
    if info.get("managed"):
        score += MANAGED_PENALTY
        reasons.append(f"already a managed representation ({MANAGED_PENALTY:+d})")

    if kind in ("tool_recent", "tool_older"):
        hits = matched_terms(terms, message.get("content"))
        if hits:
            score += RELEVANCE_GAIN
            reasons.append(
                f"shares {len(hits)} term(s) with the current request ({RELEVANCE_GAIN:+d}): "
                + ", ".join(hits[:4])
            )

    age = min(AGE_PENALTY_MAX, max(0, (total - 1 - index)) * AGE_PENALTY_PER_STEP)
    if age and kind not in ("system", "current_user", "tool_unmatched"):
        score -= age
        reasons.append(f"{total - 1 - index} message(s) from the newest ({-age:+d})")

    return score, reasons


def rank_context_items(messages, history_count=0, tool_info=None, request_text="", enabled=True):
    """Rank every item of a prepared request, least important first.

    `tool_info` maps a message index to what the tool-result manager knows about
    it (`classification`, `managed`, `matched`, `newest_round`), so the two modules
    stay separate: this one scores, the manager reduces. There is no size fact here,
    because the runtime does not count tokens.
    """
    items = [message for message in messages if isinstance(message, dict)]
    tool_info = tool_info or {}
    terms = request_terms(request_text)
    total = len(items)
    system_count = (
        1 if items and str(items[0].get("role") or "") in ("system", "developer") else 0
    )

    newest_user_index = None
    for index in range(total - 1, -1, -1):
        if str(items[index].get("role") or "") == "user":
            newest_user_index = index
            break

    turn_start = system_count + max(0, history_count)
    ranked = []
    for index, message in enumerate(items):
        role = str(message.get("role") or "")
        info = tool_info.get(index) or {}

        if index == 0 and role in ("system", "developer"):
            kind = "system"
        elif role == "tool":
            if info.get("matched", True):
                kind = "tool_recent" if info.get("newest_round") else "tool_older"
            else:
                kind = "tool_unmatched"
        elif role == "user":
            if index == newest_user_index:
                kind = "current_user"
            else:
                kind = "turn_user" if index >= turn_start else "history_user"
        elif role == "assistant":
            kind = "turn_assistant" if index >= turn_start else "history_assistant"
        else:
            kind = "history_assistant"

        score, reasons = score_item(kind, index, total, message, info, terms, enabled)
        ranked.append(
            {
                "index": index,
                "kind": kind,
                "score": score,
                "classification": info.get("classification"),
                "reducible": kind in REDUCIBLE_KINDS and not bool(info.get("managed")),
                "reasons": reasons,
            }
        )

    # Least important first; ties go to the older message, so the order is stable.
    ranked.sort(key=lambda item: (item["score"], -item["index"]))
    return ranked


def decision_summary(ranked, limit=8):
    """The part of a ranking worth reporting: what could be reduced, in order."""
    reducible = [item for item in ranked if item["reducible"]]
    return {
        "reducible": len(reducible),
        "decisions": [
            {
                "index": item["index"],
                "kind": item["kind"],
                "score": item["score"],
                "classification": item["classification"],
                "reason": "; ".join(item["reasons"]),
            }
            for item in reducible[:limit]
        ],
    }
