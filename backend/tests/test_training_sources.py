from datetime import datetime, timezone
from pathlib import Path
import sqlite3

from fastapi.testclient import TestClient

from app.api.training import get_store
from app.main import app
from app.models.training import CreateTrainingItem
from app.parsers.mjai_reviewer import parse_mjai_reviewer_html
from app.analysis.reconstruction import reconstruct_report
from app.training.source_identity import decision_id, source_game_id
from app.training.store import TrainingStore, timestamp


FIXTURES = Path(__file__).parent / "fixtures"


def test_source_game_identity_ignores_filename_but_distinguishes_game_content():
    first = parse_mjai_reviewer_html((FIXTURES / "e417343c4d3491e7.html").read_bytes())
    same_game = parse_mjai_reviewer_html((FIXTURES / "e417343c4d3491e7.html").read_bytes())
    other_game = parse_mjai_reviewer_html((FIXTURES / "mjai-reviewer-demo.html").read_bytes())

    # The upload name is deliberately not an input to the content identity.
    assert source_game_id(first) == source_game_id(same_game)
    assert source_game_id(first) != source_game_id(other_game)


def test_decision_ids_are_stable_for_same_normalized_game():
    payload = (FIXTURES / "e417343c4d3491e7.html").read_bytes()
    first = reconstruct_report(parse_mjai_reviewer_html(payload))
    second = reconstruct_report(parse_mjai_reviewer_html(payload))

    assert [decision_id(item.round_id, item.decision_index) for item in first.decisions] == [
        decision_id(item.round_id, item.decision_index) for item in second.decisions
    ]


def test_renamed_uploads_share_identity_and_do_not_duplicate_training_items(tmp_path):
    store = TrainingStore(tmp_path / "training.sqlite3")
    app.dependency_overrides[get_store] = lambda: store
    payload = (FIXTURES / "e417343c4d3491e7.html").read_bytes()
    try:
        with TestClient(app) as client:
            first = client.post("/api/reports/review", files={"file": ("first.html", payload, "text/html")})
            second = client.post("/api/reports/review", files={"file": ("renamed.html", payload, "text/html")})
            assert first.status_code == second.status_code == 200
            assert first.json()["source_game_id"] == second.json()["source_game_id"]
            decision = first.json()["decisions"][0]
            body = CreateTrainingItem(
                source_game_id=first.json()["source_game_id"],
                decision_id=decision["id"],
                category="PUSH_FOLD",
                severity=decision["severity"],
            ).model_dump()
            created = client.post("/api/training-items", json=body).json()
            duplicate = client.post("/api/training-items", json=body).json()
            assert duplicate["id"] == created["id"]
            assert len(store.for_source(body["source_game_id"])) == 1
            sources = client.get("/api/training-sources").json()
            assert len(sources) == 1
            assert sources[0]["source_filename"] == "renamed.html"
            assert sources[0]["imported_at"] is not None
            assert sources[0]["decision_count"] > 0
    finally:
        app.dependency_overrides.clear()


def test_same_upload_filename_with_different_games_gets_different_identity(tmp_path):
    store = TrainingStore(tmp_path / "training.sqlite3")
    app.dependency_overrides[get_store] = lambda: store
    try:
        with TestClient(app) as client:
            first = client.post("/api/reports/review", files={
                "file": ("game.html", (FIXTURES / "e417343c4d3491e7.html").read_bytes(), "text/html")
            })
            second = client.post("/api/reports/review", files={
                "file": ("game.html", (FIXTURES / "mjai-reviewer-demo.html").read_bytes(), "text/html")
            })
            assert first.status_code == second.status_code == 200
            assert first.json()["source_game_id"] != second.json()["source_game_id"]
    finally:
        app.dependency_overrides.clear()


def test_due_source_decisions_survive_store_restart(tmp_path):
    payload = (FIXTURES / "e417343c4d3491e7.html").read_bytes()
    parsed = parse_mjai_reviewer_html(payload)
    reconstructed = reconstruct_report(parsed)
    game_id = source_game_id(parsed)
    decisions = [item.model_dump() | {"id": decision_id(item.round_id, item.decision_index)}
                 for item in reconstructed.decisions]
    store = TrainingStore(tmp_path / "training.sqlite3")
    store.register_source(game_id, "original.html", decisions)
    decision = reconstructed.decisions[0]
    item = store.create(CreateTrainingItem(
        source_game_id=game_id,
        decision_id=decision_id(decision.round_id, decision.decision_index),
        category="TILE_EFFICIENCY",
        severity=decision.severity,
    ), datetime.now(timezone.utc))

    reopened = TrainingStore(tmp_path / "training.sqlite3")
    due_item = next(row for row in reopened.due(datetime.now(timezone.utc)) if row.id == item.id)
    persisted = reopened.source_decisions(due_item.source_game_id)
    assert persisted is not None
    resolved = next(row for row in persisted if row["id"] == due_item.decision_id)
    assert resolved["state"] == decision.state.model_dump()


def test_missing_source_returns_recoverable_error(tmp_path):
    store = TrainingStore(tmp_path / "training.sqlite3")
    app.dependency_overrides[get_store] = lambda: store
    try:
        response = TestClient(app).get("/api/training-sources/game-sha256%3Amissing/decisions")
        assert response.status_code == 404
        assert "Re-upload the original game report" in response.json()["detail"]
    finally:
        app.dependency_overrides.clear()


def test_existing_source_database_is_upgraded_with_import_date(tmp_path):
    path = tmp_path / "legacy.sqlite3"
    with sqlite3.connect(path) as connection:
        connection.execute(
            "CREATE TABLE training_sources (source_game_id TEXT PRIMARY KEY, "
            "source_filename TEXT NOT NULL, decisions_json TEXT NOT NULL)"
        )

    store = TrainingStore(path)
    imported_at = datetime(2026, 10, 1, tzinfo=timezone.utc)
    store.register_source("game-id", "match.html", [], imported_at)
    source, = store.sources()
    assert source["imported_at"] == timestamp(imported_at)
    assert source["decision_count"] == 0
