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
from app.training.store import TrainingStore, timestamp

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
    assert create(store).category == "TILE_EFFICIENCY"
    assert create(store, source_game_id="other.html").id != item.id


@pytest.mark.parametrize("rating", [1, 2, 3, 4])
def test_first_review_fsrs_memory_matches_library_and_persists(store, rating, monkeypatch):
    scheduler = TrainingScheduler(enable_fuzzing=False)
    monkeypatch.setattr("app.training.store.schedule_review", scheduler.schedule_review)
    before = create(store)
    expected, _ = Scheduler(enable_fuzzing=False).review_card(Card(card_id=before.id, due=NOW), Rating(rating), NOW)
    after = store.review(before.id, request(rating), NOW)
    # py-fsrs is the oracle for the FSRS memory model only. The wrapper owns
    # Anki-compatible state, learning-step, and due-date behavior.
    assert after.stability == expected.stability
    assert after.difficulty == expected.difficulty
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


def test_anki_default_scheduler_configuration():
    scheduler = TrainingScheduler(enable_fuzzing=False)
    assert scheduler._scheduler.desired_retention == 0.90
    assert scheduler._scheduler.parameters == Scheduler(enable_fuzzing=False).parameters
    assert scheduler._scheduler.learning_steps == (timedelta(minutes=1), timedelta(minutes=10))
    assert scheduler._scheduler.relearning_steps == (timedelta(minutes=10),)
    assert scheduler._scheduler.maximum_interval == 36_500


@pytest.mark.parametrize("rating, expected_state, expected_step, expected_seconds", [
    (1, "learning", 0, 60),
    (2, "learning", 0, 330),
    (3, "learning", 1, 600),
    (4, "review", None, 8 * 86_400),
])
def test_new_card_default_button_transitions(store, rating, expected_state, expected_step, expected_seconds):
    item = create(store)
    result = TrainingScheduler(enable_fuzzing=False).schedule_review(item, rating, NOW)
    assert result.state == expected_state
    assert result.learning_step == expected_step
    assert result.due_at == NOW + timedelta(seconds=expected_seconds)


def test_new_card_good_then_good_graduates(store):
    scheduler = TrainingScheduler(enable_fuzzing=False)
    item = create(store)
    first = scheduler.schedule_review(item, 3, NOW)
    assert first.state == "learning" and first.learning_step == 1
    learning = item.model_copy(update={
        "state": first.state, "learning_step": first.learning_step,
        "due_at": first.due_at, "stability": first.stability,
        "difficulty": first.difficulty, "last_reviewed_at": NOW,
        "interval_days": first.interval_days,
    })
    second = scheduler.schedule_review(learning, 3, first.due_at)
    assert second.state == "review" and second.learning_step is None
    assert second.due_at == first.due_at + timedelta(days=2)


def test_review_again_enters_relearning_then_good_graduates(store):
    scheduler = TrainingScheduler(enable_fuzzing=False)
    item = create(store)
    good = scheduler.schedule_review(item, 3, NOW)
    learning = item.model_copy(update={"state": good.state, "learning_step": good.learning_step,
        "due_at": good.due_at, "stability": good.stability, "difficulty": good.difficulty,
        "last_reviewed_at": NOW, "interval_days": good.interval_days})
    graduated = scheduler.schedule_review(learning, 3, good.due_at)
    review = learning.model_copy(update={"state": graduated.state, "learning_step": None,
        "due_at": graduated.due_at, "stability": graduated.stability,
        "difficulty": graduated.difficulty, "last_reviewed_at": good.due_at,
        "interval_days": graduated.interval_days})
    lapse = scheduler.schedule_review(review, 1, graduated.due_at)
    assert lapse.state == "relearning" and lapse.learning_step == 0
    assert lapse.due_at == graduated.due_at + timedelta(minutes=10)
    assert lapse.lapse_increment == 1
    relearning = review.model_copy(update={"state": lapse.state, "learning_step": lapse.learning_step,
        "due_at": lapse.due_at, "stability": lapse.stability, "difficulty": lapse.difficulty,
        "last_reviewed_at": graduated.due_at, "interval_days": lapse.interval_days})
    recovered = scheduler.schedule_review(relearning, 3, lapse.due_at)
    assert recovered.state == "review" and recovered.learning_step is None


@pytest.mark.parametrize("rating, expected_state", [(1, "relearning"), (2, "relearning"),
                                                       (3, "review"), (4, "review")])
def test_relearning_default_button_transitions(store, rating, expected_state):
    scheduler = TrainingScheduler(enable_fuzzing=False)
    item = create(store).model_copy(update={"state": "relearning", "learning_step": 0,
        "stability": 2.0, "difficulty": 5.0, "interval_days": 2.0,
        "last_reviewed_at": NOW - timedelta(days=2)})
    result = scheduler.schedule_review(item, rating, NOW)
    assert result.state == expected_state
    if expected_state == "relearning":
        assert result.learning_step == 0
        expected_minutes = 10 if rating == 1 else 15
        assert result.due_at == NOW + timedelta(minutes=expected_minutes)
    else:
        assert result.learning_step is None


def test_relearning_easy_interval_is_after_good(store):
    scheduler = TrainingScheduler(enable_fuzzing=False)
    item = create(store).model_copy(update={"state": "relearning", "learning_step": 0,
        "stability": 2.0, "difficulty": 5.0, "interval_days": 2.0,
        "last_reviewed_at": NOW - timedelta(days=2)})
    results = scheduler.preview(item, NOW)
    assert results[3].state == results[4].state == "review"
    assert results[4].interval_days >= results[3].interval_days + 1


def test_multiple_consecutive_review_schedules(store):
    scheduler = TrainingScheduler(enable_fuzzing=False)
    item = create(store).model_copy(update={"state": "review", "stability": 10.0,
        "difficulty": 5.0, "interval_days": 10.0,
        "last_reviewed_at": NOW - timedelta(days=10)})
    for rating in (2, 3, 4, 3, 2):
        result = scheduler.schedule_review(item, rating, item.due_at)
        assert result.state == "review"
        item = item.model_copy(update={"due_at": result.due_at,
            "interval_days": result.interval_days, "stability": result.stability,
            "difficulty": result.difficulty, "last_reviewed_at": item.due_at})


@pytest.mark.parametrize("rating", [2, 3, 4])
def test_review_card_hard_good_easy_use_fsrs_and_order(store, rating):
    scheduler = TrainingScheduler(enable_fuzzing=False)
    item = create(store)
    first = scheduler.schedule_review(item, 3, NOW)
    learn = item.model_copy(update={"state": first.state, "learning_step": first.learning_step,
        "due_at": first.due_at, "stability": first.stability, "difficulty": first.difficulty,
        "last_reviewed_at": NOW, "interval_days": first.interval_days})
    second = scheduler.schedule_review(learn, 3, first.due_at)
    review = learn.model_copy(update={"state": second.state, "learning_step": None,
        "due_at": second.due_at, "stability": second.stability, "difficulty": second.difficulty,
        "last_reviewed_at": first.due_at, "interval_days": second.interval_days})
    results = scheduler.preview(review, second.due_at)
    assert results[2].state == results[3].state == results[4].state == "review"
    assert results[2].interval_days < results[3].interval_days < results[4].interval_days
    assert scheduler.schedule_review(review, rating, second.due_at) == results[rating]


def test_maximum_interval_and_fuzz_disabled_are_deterministic(store):
    scheduler = TrainingScheduler(enable_fuzzing=False)
    item = create(store).model_copy(update={"state": "review", "stability": 1_000_000.0,
        "difficulty": 5.0, "interval_days": 36_500, "learning_step": None,
        "last_reviewed_at": NOW - timedelta(days=36_500)})
    first = scheduler.schedule_review(item, 4, NOW)
    second = scheduler.schedule_review(item, 4, NOW)
    assert first.interval_days == second.interval_days == 36_500
    assert first.due_at == second.due_at


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


def test_future_training_item_is_excluded_from_due_queue(store):
    item = create(store)
    with store.connection() as connection:
        connection.execute("UPDATE training_items SET due_at = ? WHERE id = ?",
                           (timestamp(NOW + timedelta(days=1)), item.id))
    assert store.due(NOW) == []


def test_saved_mistake_resolves_to_same_reconstructed_position_after_restart(store):
    from app.analysis.reconstruction import reconstruct_report
    from app.parsers.mjai_reviewer import parse_mjai_reviewer_html

    fixture = Path(__file__).parent / "fixtures" / "e417343c4d3491e7.html"
    reconstructed = reconstruct_report(parse_mjai_reviewer_html(fixture.read_bytes()))
    decision = next(item for item in reconstructed.decisions
                    if item.severity in {"MISTAKE", "INACCURACY"})
    source_game_id = fixture.name
    saved = store.create(CreateTrainingItem(source_game_id=source_game_id,
        decision_id=f"{decision.round_id}:{decision.decision_index}",
        category="PUSH_FOLD", severity=decision.severity), NOW)
    assert saved.category == "PUSH_FOLD"
    rated = store.review(saved.id, request(2, correct=False), NOW)

    reopened = TrainingStore(store.path)
    due_item = next(item for item in reopened.due(rated.due_at) if item.id == rated.id)
    resolved = next(item for item in reconstructed.decisions
                    if f"{item.round_id}:{item.decision_index}" == due_item.decision_id)
    assert due_item.source_game_id == source_game_id
    assert due_item.category == "PUSH_FOLD"
    assert resolved.state.concealed_hand == decision.state.concealed_hand
    assert resolved.state.round_id == decision.state.round_id
    assert reopened.reviews(saved.id)[0].rating == 2


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
