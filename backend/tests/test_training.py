from datetime import datetime, timedelta, timezone
from pathlib import Path
import ast
import sqlite3

from fastapi.testclient import TestClient
import pytest
from fsrs import Card, Rating, Scheduler

from app.main import app
from app.api.training import get_store
from app.models.training import CreateTrainingItem, ReviewRequest, TrainingItem
from app.training.scheduler import TrainingScheduler
from app.training.store import TrainingStore

NOW = datetime(2026, 1, 1, tzinfo=timezone.utc)
CREATE = dict(source_game_id="e417343c4d3491e7.html", decision_id="0:12", category="TILE_EFFICIENCY", severity="MISTAKE")


@pytest.fixture
def store(tmp_path):
    return TrainingStore(tmp_path / "training.sqlite3")


def request(rating=3, correct=True, duration=None):
    return ReviewRequest(rating=rating, user_action="5p", model_action="5p", was_correct=correct, response_time_ms=duration)


def create(store, **changes):
    return store.create(CreateTrainingItem(**{**CREATE, **changes}), NOW)


def test_creation_and_duplicate(store):
    item = create(store)
    assert item.state == "new" and item.due_at == NOW
    assert item.stability is item.difficulty is item.last_rating is None
    assert item.reps == item.lapses == item.interval_days == 0
    assert create(store).id == item.id
    assert create(store, source_game_id="other.html").id != item.id


@pytest.mark.parametrize("rating", [1, 2, 3, 4])
def test_first_review_matches_library_and_persists(store, rating, monkeypatch):
    scheduler = TrainingScheduler(enable_fuzzing=False)
    monkeypatch.setattr("app.training.store.schedule_review", scheduler.schedule_review)
    before = create(store)
    expected, _ = Scheduler(enable_fuzzing=False).review_card(Card(card_id=before.id, due=NOW), Rating(rating), NOW)
    after = store.review(before.id, request(rating), NOW)
    assert after.stability == expected.stability
    assert after.difficulty == expected.difficulty
    assert after.due_at == expected.due
    assert after.interval_days == (expected.due - NOW).total_seconds() / 86400
    assert after.state == expected.state.name.lower()
    assert after.learning_step == expected.step
    assert after.reps == 1 and after.lapses == 0
    reopened = TrainingStore(store.path)
    assert reopened.due(after.due_at)[0] == after
    log, = reopened.reviews(after.id)
    assert log.stability_before is log.difficulty_before is None
    assert log.due_at_before == NOW
    assert log.stability_after == after.stability and log.difficulty_after == after.difficulty
    assert log.due_at_after == after.due_at and log.scheduled_days == after.interval_days
    assert log.rating == rating and log.elapsed_days == 0
    assert after.last_reviewed_at == after.updated_at == NOW
    assert after.last_rating == rating


def test_lapses_and_learning_steps(store):
    item = create(store)
    item = store.review(item.id, request(3), NOW)
    assert item.state == "learning" and item.learning_step == 1
    item = store.review(item.id, request(3), item.due_at)
    assert item.state == "review" and item.learning_step is None
    before = item
    item = store.review(item.id, request(1), before.due_at)
    assert item.state == "relearning" and item.lapses == 1 and item.reps == 3
    log = store.reviews(item.id)[-1]
    assert log.stability_before == before.stability
    assert log.difficulty_before == before.difficulty
    assert log.due_at_before == before.due_at
    assert log.elapsed_days == before.interval_days
    item = store.review(item.id, request(1), item.due_at)
    assert item.lapses == 1 and item.reps == 4
    item = store.review(item.id, request(2), item.due_at)
    assert item.lapses == 1
    item = store.review(item.id, request(3), item.due_at)
    assert item.state == "review" and item.reps == 6
    assert len(store.reviews(item.id)) == 6


def test_due_order_and_boundary(store):
    first = create(store)
    second = create(store, decision_id="0:13")
    after = store.review(first.id, request(4), NOW)
    assert [item.id for item in store.due(NOW)] == [second.id]
    assert [item.id for item in store.due(after.due_at)] == [second.id, first.id]


def test_correctness_and_response_time_do_not_schedule(store, monkeypatch):
    monkeypatch.setattr("app.training.store.schedule_review", TrainingScheduler(enable_fuzzing=False).schedule_review)
    left = create(store)
    right = create(store, decision_id="0:13")
    left = store.review(left.id, request(2, True, 1), NOW)
    right = store.review(right.id, request(2, False, 100000), NOW)
    for field in ("stability", "difficulty", "interval_days", "due_at", "state", "lapses", "last_rating"):
        assert getattr(left, field) == getattr(right, field)
    assert store.reviews(left.id)[0].was_correct is True
    assert store.reviews(right.id)[0].was_correct is False
    assert store.reviews(right.id)[0].response_time_ms == 100000


def test_atomic_rollback_and_immutable_logs(store):
    item = create(store)
    with store.connection() as connection:
        connection.execute("CREATE TRIGGER reject_log BEFORE INSERT ON review_logs BEGIN SELECT RAISE(ABORT, 'test'); END")
    with pytest.raises(sqlite3.IntegrityError):
        store.review(item.id, request(), NOW)
    assert store.due(NOW)[0].reps == 0 and store.reviews(item.id) == []
    with store.connection() as connection:
        connection.execute("DROP TRIGGER reject_log")
    store.review(item.id, request(), NOW)
    for sql in ("DELETE FROM review_logs", "UPDATE review_logs SET rating=1"):
        with pytest.raises(sqlite3.IntegrityError), store.connection() as connection:
            connection.execute(sql)


def test_api(store):
    app.dependency_overrides[get_store] = lambda: store
    try:
        with TestClient(app) as client:
            item = client.post("/api/training-items", json=CREATE).json()
            assert client.post("/api/training-items", json=CREATE).json()["id"] == item["id"]
            assert len(client.get("/api/training-items/due").json()) == 1
            path = f'/api/training-items/{item["id"]}'
            for rating in (0, 5, True, "3", 2.5):
                assert client.post(path + "/review", json={**request().model_dump(), "rating": rating}).status_code == 422
            response = client.post(path + "/review", json=request(2, True).model_dump())
            assert response.status_code == 200
            assert response.json()["last_rating"] == 2 and response.json()["lapses"] == 0
            assert len(client.get(path + "/reviews").json()) == 1
            assert client.get("/api/training-items/due").json() == []
            assert client.get("/api/training-items/999/reviews").status_code == 404
            assert client.post("/api/training-items/999/review", json=request().model_dump()).status_code == 404
    finally:
        app.dependency_overrides.clear()


def test_retrievability_is_computed_and_time_validation(store):
    item = store.review(create(store).id, request(4), NOW)
    scheduler = TrainingScheduler()
    assert scheduler.retrievability(item, NOW) == 1
    assert 0 < scheduler.retrievability(item, NOW + timedelta(days=30)) < 1
    assert "retrievability" not in TrainingItem.model_fields
    for at in (NOW - timedelta(seconds=1), NOW.replace(tzinfo=None)):
        with pytest.raises(ValueError):
            scheduler.schedule_review(item, 3, at)


def test_scheduler_isolation():
    root = Path(__file__).resolve().parents[2]
    for path in (root / "backend/app").rglob("*.py"):
        if path.name == "scheduler.py":
            continue
        tree = ast.parse(path.read_text())
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom):
                assert not (node.module or "").startswith("fsrs"), path
            elif isinstance(node, ast.Import):
                assert all(not alias.name.startswith("fsrs") for alias in node.names), path
    component = (root / "frontend/src/components/MemoryRatingControls.tsx").read_text()
    assert "{ ...review, rating }" in component
    assert "was_correct" not in component
    for path in (root / "frontend/src").rglob("*.ts*"):
        assert "from fsrs" not in path.read_text()


def test_concurrent_creation_and_reviews(store):
    from concurrent.futures import ThreadPoolExecutor

    with ThreadPoolExecutor(max_workers=4) as pool:
        items = list(pool.map(lambda _: create(store), range(8)))
    assert len({item.id for item in items}) == 1
    with ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(lambda _: store.review(items[0].id, request(2), NOW), range(8)))
    assert store.due(NOW + timedelta(days=1))[0].reps == 8
    assert len(store.reviews(items[0].id)) == 8
