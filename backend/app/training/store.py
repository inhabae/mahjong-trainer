"""SQLite persistence: each review and its card update commit atomically."""
from contextlib import contextmanager
from dataclasses import asdict
from datetime import datetime, timezone
import json
from pathlib import Path
import sqlite3

from app.models.training import CreateTrainingItem, ReviewLog, ReviewRequest, TrainingItem
from app.training.scheduler import _default_scheduler, schedule_review

SCHEMA = """
CREATE TABLE IF NOT EXISTS training_items (
 id INTEGER PRIMARY KEY, source_game_id TEXT NOT NULL, decision_id TEXT NOT NULL,
 category TEXT NOT NULL, severity TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'new',
 due_at TEXT NOT NULL, interval_days REAL NOT NULL DEFAULT 0,
 stability REAL, difficulty REAL, learning_step INTEGER,
 reps INTEGER NOT NULL DEFAULT 0, lapses INTEGER NOT NULL DEFAULT 0,
 last_reviewed_at TEXT, last_rating INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 UNIQUE(source_game_id, decision_id)
);
CREATE INDEX IF NOT EXISTS training_items_due ON training_items(due_at, id);
CREATE TABLE IF NOT EXISTS training_sources (
 source_game_id TEXT PRIMARY KEY, source_filename TEXT NOT NULL, decisions_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS review_logs (
 id INTEGER PRIMARY KEY, training_item_id INTEGER NOT NULL REFERENCES training_items(id),
 reviewed_at TEXT NOT NULL, rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 4),
 elapsed_days REAL NOT NULL, scheduled_days REAL NOT NULL,
 stability_before REAL, difficulty_before REAL, due_at_before TEXT NOT NULL,
 stability_after REAL NOT NULL, difficulty_after REAL NOT NULL, due_at_after TEXT NOT NULL,
 user_action TEXT NOT NULL, model_action TEXT, was_correct INTEGER NOT NULL,
 response_time_ms INTEGER
);
CREATE INDEX IF NOT EXISTS review_logs_item ON review_logs(training_item_id, reviewed_at, id);
CREATE TRIGGER IF NOT EXISTS review_logs_no_update BEFORE UPDATE ON review_logs
 BEGIN SELECT RAISE(ABORT, 'Review history is immutable'); END;
CREATE TRIGGER IF NOT EXISTS review_logs_no_delete BEFORE DELETE ON review_logs
 BEGIN SELECT RAISE(ABORT, 'Review history is immutable'); END;
"""


def timestamp(at: datetime) -> str:
    if at.tzinfo is None or at.utcoffset() is None:
        raise ValueError("Timestamp must be timezone-aware")
    return at.astimezone(timezone.utc).isoformat(timespec="microseconds")


def values(model):
    return {key: timestamp(value) if isinstance(value, datetime) else value
            for key, value in model.model_dump().items()}


class TrainingStore:
    def __init__(self, path: str | Path):
        self.path = path
        with self.connection() as connection:
            connection.executescript(SCHEMA)

    @contextmanager
    def connection(self):
        connection = sqlite3.connect(self.path, timeout=30)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    @staticmethod
    def _load(connection, item_id: int) -> TrainingItem:
        row = connection.execute("SELECT * FROM training_items WHERE id = ?", (item_id,)).fetchone()
        if row is None:
            raise KeyError(item_id)
        return TrainingItem.model_validate(dict(row))

    def create(self, request: CreateTrainingItem, now: datetime) -> TrainingItem:
        with self.connection() as connection:
            connection.execute(
                "INSERT INTO training_items (source_game_id, decision_id, category, severity, due_at, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(source_game_id, decision_id) DO NOTHING",
                (request.source_game_id, request.decision_id, request.category, request.severity,
                 timestamp(now), timestamp(now), timestamp(now)))
            row = connection.execute("SELECT * FROM training_items WHERE source_game_id = ? AND decision_id = ?",
                                     (request.source_game_id, request.decision_id)).fetchone()
            return TrainingItem.model_validate(dict(row))

    def due(self, now: datetime) -> list[TrainingItem]:
        with self.connection() as connection:
            return [TrainingItem.model_validate(dict(row)) for row in connection.execute(
                "SELECT * FROM training_items WHERE due_at <= ? ORDER BY due_at, id", (timestamp(now),))]

    def for_source(self, source_game_id: str) -> list[TrainingItem]:
        with self.connection() as connection:
            return [TrainingItem.model_validate(dict(row)) for row in connection.execute(
                "SELECT * FROM training_items WHERE source_game_id = ? ORDER BY id", (source_game_id,))]

    def register_source(self, source_game_id: str, source_filename: str,
                        decisions: list[dict]) -> None:
        """Persist reconstructed positions and migrate filename-keyed items."""
        with self.connection() as connection:
            connection.execute(
                "INSERT INTO training_sources (source_game_id, source_filename, decisions_json) "
                "VALUES (?, ?, ?) ON CONFLICT(source_game_id) DO UPDATE SET "
                "source_filename = excluded.source_filename, decisions_json = excluded.decisions_json",
                (source_game_id, source_filename, json.dumps(decisions, separators=(",", ":"))),
            )
            # Older app versions keyed items by filename. Move those rows to
            # the durable ID when there is no canonical row for that decision.
            connection.execute(
                "UPDATE OR IGNORE training_items SET source_game_id = ? WHERE source_game_id = ?",
                (source_game_id, source_filename),
            )

    def source_decisions(self, source_game_id: str) -> list[dict] | None:
        with self.connection() as connection:
            row = connection.execute(
                "SELECT decisions_json FROM training_sources WHERE source_game_id = ?",
                (source_game_id,),
            ).fetchone()
            return json.loads(row["decisions_json"]) if row else None

    def reset_progress(self) -> None:
        """Reset scheduling state for every card, preserving immutable review logs."""
        with self.connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            now = timestamp(datetime.now(timezone.utc))
            connection.execute(
                "UPDATE training_items SET state = 'new', due_at = created_at, interval_days = 0, "
                "stability = NULL, difficulty = NULL, learning_step = NULL, reps = 0, lapses = 0, "
                "last_reviewed_at = NULL, last_rating = NULL, updated_at = ?", (now,))

    def review(self, item_id: int, request: ReviewRequest, now: datetime) -> TrainingItem:
        with self.connection() as connection:
            # Serialize read-modify-write across processes, not just threads.
            connection.execute("BEGIN IMMEDIATE")
            before = self._load(connection, item_id)
            result = schedule_review(before, request.rating, now)
            changes = asdict(result)
            lapse_increment = changes.pop("lapse_increment")
            after = before.model_copy(update={**changes, "reps": before.reps + 1,
                "lapses": before.lapses + lapse_increment, "last_reviewed_at": now,
                "last_rating": request.rating, "updated_at": now})
            data = values(after)
            connection.execute("UPDATE training_items SET " + ", ".join(f"{key} = :{key}" for key in data if key != "id") + " WHERE id = :id", data)
            log = ReviewLog(id=0, training_item_id=item_id, reviewed_at=now,
                elapsed_days=(now - before.last_reviewed_at).total_seconds() / 86400 if before.last_reviewed_at else 0,
                scheduled_days=after.interval_days, stability_before=before.stability,
                difficulty_before=before.difficulty, due_at_before=before.due_at,
                stability_after=after.stability, difficulty_after=after.difficulty,
                due_at_after=after.due_at, **request.model_dump())
            data = values(log)
            del data["id"]
            connection.execute("INSERT INTO review_logs (" + ", ".join(data) + ") VALUES (" + ", ".join(f":{key}" for key in data) + ")", data)
            return after

    def preview(self, request: CreateTrainingItem, now: datetime) -> dict[int, datetime]:
        item = self.create(request, now)
        return {rating: result.due_at for rating, result in _default_scheduler.preview(item, now).items()}

    def reviews(self, item_id: int) -> list[ReviewLog]:
        with self.connection() as connection:
            self._load(connection, item_id)
            logs = []
            for row in connection.execute("SELECT * FROM review_logs WHERE training_item_id = ? ORDER BY reviewed_at, id", (item_id,)):
                data = dict(row)
                data["was_correct"] = bool(data["was_correct"])
                logs.append(ReviewLog.model_validate(data))
            return logs
