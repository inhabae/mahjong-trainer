"""Stable identities for source games and their reconstructed decisions."""

from hashlib import sha256
import json

from app.models.report import ParsedReport


def decision_id(round_id: str, decision_index: int) -> str:
    """Return the stable row identity used by reports for one game."""
    return f"{round_id}:{decision_index}"


def _fallback_identity(report: ParsedReport) -> list[dict]:
    """Build a content identity when no embedded replay log is available."""
    return [
        {
            "round_id": round_.id,
            "decisions": [
                {
                    "turn": decision.turn,
                    "actual_action": decision.actual_action,
                    "hand": decision.concealed_hand,
                    "drawn_tile": decision.drawn_tile,
                    "call_tile": decision.call_tile,
                    "call_from": decision.call_from,
                    "legal_actions": [item.action for item in decision.legal_actions],
                }
                for decision in round_.decisions
            ],
        }
        for round_ in report.rounds
    ]


def source_game_id(report: ParsedReport) -> str:
    """Hash gameplay content, excluding filename and report-generation metadata."""
    if report.rounds and all(
        round_.original_game_log and isinstance(round_.original_game_log.get("log"), list)
        for round_ in report.rounds
    ):
        identity = [round_.original_game_log["log"] for round_ in report.rounds]
    else:
        identity = _fallback_identity(report)
    canonical = json.dumps(identity, ensure_ascii=False, sort_keys=True,
                           separators=(",", ":")).encode("utf-8")
    return f"game-sha256:{sha256(canonical).hexdigest()}"
