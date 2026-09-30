"""Mortal-policy-only decision severity classification."""

from enum import Enum
import re

from app.models.report import Decision


MISTAKE_THRESHOLD = 0.05
INACCURACY_THRESHOLD = 0.10
EXPECTED_TEMPERATURE = 0.10


class Severity(str, Enum):
    MATCH = "MATCH"
    MISTAKE = "MISTAKE"
    INACCURACY = "INACCURACY"
    MINOR = "MINOR"


def _action_key(action: str | None) -> str:
    if not action:
        return ""
    return re.sub(r"\s+", " ", action.lower().replace("player:", "").replace("mortal:", "")).strip()


def _same_action(left: str | None, right: str | None) -> bool:
    if _action_key(left) == _action_key(right):
        return True
    # Saved HTML variants may differ only in the localized action verb. The
    # tile suffix remains the stable action identity for discard decisions.
    left_tile = re.findall(r"(?:[0-9][mps]r?|[neswpfch])\b", (left or "").lower())
    right_tile = re.findall(r"(?:[0-9][mps]r?|[neswpfch])\b", (right or "").lower())
    return bool(left_tile and right_tile and left_tile[-1] == right_tile[-1])


def severity_for_decision(decision: Decision) -> dict:
    actions = [item.model_dump() for item in decision.legal_actions]
    top = max(decision.legal_actions, key=lambda item: item.policy_probability_percent or float("-inf"), default=None)
    player_eval = next((item for item in decision.legal_actions if _same_action(item.action, decision.actual_action)), None)
    player_policy = (player_eval.policy_probability_percent / 100.0) if player_eval and player_eval.policy_probability_percent is not None else None
    best_policy = (top.policy_probability_percent / 100.0) if top and top.policy_probability_percent is not None else None
    is_match = bool(top and _same_action(decision.actual_action, top.action))
    if is_match:
        severity = Severity.MATCH
    elif player_policy is None:
        # Missing policy is not evidence of a strong disagreement.
        severity = Severity.MINOR
    elif player_policy >= INACCURACY_THRESHOLD:
        severity = Severity.MINOR
    elif player_policy >= MISTAKE_THRESHOLD:
        severity = Severity.INACCURACY
    else:
        severity = Severity.MISTAKE
    return {
        "severity": severity.value,
        "player_action": decision.actual_action,
        "mortal_action": top.action if top else decision.mortal_action,
        "mortal": {"player_policy": player_policy, "best_policy": best_policy},
        "actions": actions,
    }


def temperature_warning(temperature: float | None) -> str | None:
    if temperature is not None and abs(temperature - EXPECTED_TEMPERATURE) > 0.001:
        return f"This report uses Mortal softmax temperature {temperature:.2f}. Severity thresholds were designed for temperature 0.10."
    return None
