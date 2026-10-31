"""Deterministic priority scoring for the items of one prepared request.

Context management has to decide *what* to reduce before it decides how. This
module answers that question with a plain additive score: higher means "keep this",
lower means "this is the least costly thing to reduce". Nothing here estimates
tokens, calls a model or stores anything - it takes token counts and tool metadata
from the caller and returns a ranked list with the reasons for every score, so the
analytics can explain a decision instead of just showing a number.

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

Modifiers, applied on top:

* `critical` tool result: **+200** - a failure or an error message the answer must
  be able to describe; reduce it last and with special care.
* `large` tool result: **-100** - the biggest win when it is reduced.
* already managed result: **-50**, and it is no longer reducible.
* shares a term with the current request: **+150** - relevance beats age.
* age: **-2** per message away from the newest, capped at **-200**, so of two
  otherwise equal items the older one is reduced first.

Ties are broken by index: the older message comes first. Every score is the sum of
documented parts, and `reasons` lists them.
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
LARGE_PENALTY = -100
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


def _kind_for(index, message, history_count, system_count, tool_info, newest_user_index):
    """Which documented kind one message belongs to."""
    role = str(message.get("role") or "")
    if index == 0 and role in ("system", "developer"):
        return "system"
    if role == "tool":
        info = tool_info.get(index) or {}
        if not info.get("matched", True):
            return "tool_unmatched"
        return "tool_recent" if info.get("newest_round") else "tool_older"
    if index == newest_user_index and role == "user":
        return "current_user"
    in_turn = index >= system_count + max(0, history_count)
    if role == "user":
        return "turn_user" if in_turn else "history_user"
    if role == "assistant":
        return "turn_assistant" if in_turn else "history_assistant"
    return "history_assistant"


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
    if info.get("classification") == "large":
        score += LARGE_PENALTY
        reasons.append(f"large tool result ({LARGE_PENALTY:+d})")
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
    it (`tokens`, `classification`, `managed`, `matched`, `newest_round`), so the
    two modules stay separate: this one scores, the manager measures and reduces.
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

    ranked = []
    for index, message in enumerate(items):
        kind = _kind_for(index, message, history_count, system_count, tool_info, newest_user_index)
        info = tool_info.get(index) or {}
        score, reasons = score_item(kind, index, total, message, info, terms, enabled)
        ranked.append(
            {
                "index": index,
                "kind": kind,
                "score": score,
                "tokens": info.get("tokens"),
                "classification": info.get("classification"),
                "reducible": kind in REDUCIBLE_KINDS and not bool(info.get("managed")),
                "reasons": reasons,
            }
        )

    # Least important first, and ties go to the older message, so the order is
    # stable across runs and never depends on dictionary iteration order.
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
                "tokens": item["tokens"],
                "reason": "; ".join(item["reasons"]),
            }
            for item in reducible[:limit]
        ],
    }
