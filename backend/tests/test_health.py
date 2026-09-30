from fastapi.testclient import TestClient
from pathlib import Path

from app.main import app

FIXTURES = Path(__file__).parent / "fixtures"


def test_health() -> None:
    response = TestClient(app).get("/api/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_parse_mjai_reviewer_report() -> None:
    report = (FIXTURES / "mjai-reviewer-demo.html").read_bytes()
    response = TestClient(app).post(
        "/api/reports/parse",
        files={"file": ("report.html", report, "text/html")},
    )

    assert response.status_code == 200
    data = response.json()
    assert data["format"] == "mjai-reviewer"
    assert data["metadata"]["engine"] == "Mortal"
    assert data["metadata"]["mortal_model_version"] == "mortal3-b24c512-t22122709"
    assert data["metadata"]["softmax_temperature"] == 0.1
    assert data["metadata"]["analyzed_player"] == 1
    assert len(data["rounds"]) == 13
    decisions = [decision for round_ in data["rounds"] for decision in round_["decisions"]]
    assert len(decisions) > 0
    assert decisions[0]["actual_action"]
    assert decisions[0]["mortal_action"]
    assert decisions[0]["shanten"] == 3
    assert decisions[0]["legal_actions"][0]["q_value"] == -0.018312275409698486
    assert decisions[0]["legal_actions"][0]["policy_probability_percent"] == 84.97877717018127
    assert data["embedded_game_log"]["log"]


def test_parse_rejects_non_report() -> None:
    response = TestClient(app).post(
        "/api/reports/parse",
        files={"file": ("report.html", b"<html><body>not a report</body></html>", "text/html")},
    )

    assert response.status_code == 415


def test_reconstruct_returns_visible_state_only() -> None:
    report = (FIXTURES / "e417343c4d3491e7.html").read_bytes()
    response = TestClient(app).post(
        "/api/reports/reconstruct",
        files={"file": ("report.html", report, "text/html")},
    )

    assert response.status_code == 200
    data = response.json()
    assert data["analyzed_player"] == 2
    assert len(data["decisions"]) == 255
    first = data["decisions"][0]
    assert first["state"]["round_id"] == "kyoku-0-0"
    assert first["state"]["dealer"] == 0
    assert first["state"]["honba"] == 0
    assert first["state"]["kyotaku"] == 0
    assert first["state"]["concealed_hand"]
    assert first["state"]["drawn_tile"]
    assert len(first["state"]["players"]) == 4
    # No opponent concealed hand is part of the public state model.
    assert all("concealed_hand" not in player for player in first["state"]["players"])


def test_review_returns_only_highlighted_decisions() -> None:
    report = (FIXTURES / "mjai-reviewer-demo.html").read_bytes()
    response = TestClient(app).post(
        "/api/reports/review",
        files={"file": ("report.html", report, "text/html")},
    )

    assert response.status_code == 200
    data = response.json()
    assert data["summary"]["highlighted"] == 14
    assert len(data["decisions"]) == 14
    assert {item["severity"] for item in data["decisions"]} <= {"MISTAKE", "INACCURACY"}
    assert data["debug"]
