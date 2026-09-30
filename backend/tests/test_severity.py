from app.analysis.severity import severity_for_decision, temperature_warning
from app.models.report import ActionEvaluation, Decision


def decision(player_policy: float, top_policy: float = 0.80) -> Decision:
    return Decision(
        actual_action="Discard 7p",
        mortal_action="Discard 3s",
        legal_actions=[
            ActionEvaluation(action="Discard 3s", q_value=-0.1, policy_probability_percent=top_policy * 100),
            ActionEvaluation(action="Discard 7p", q_value=-0.2, policy_probability_percent=player_policy * 100),
        ],
    )


def test_severity_boundaries() -> None:
    assert severity_for_decision(decision(0.0499))["severity"] == "MISTAKE"
    assert severity_for_decision(decision(0.05))["severity"] == "INACCURACY"
    assert severity_for_decision(decision(0.0999))["severity"] == "INACCURACY"
    assert severity_for_decision(decision(0.10))["severity"] == "MINOR"
    assert severity_for_decision(decision(0.25))["severity"] == "MINOR"


def test_top_action_is_match_even_with_other_probability_data() -> None:
    item = decision(0.80, 0.80)
    item.actual_action = "Discard 3s"
    assert severity_for_decision(item)["severity"] == "MATCH"


def test_temperature_warning() -> None:
    assert temperature_warning(0.1) is None
    assert "0.20" in (temperature_warning(0.2) or "")
