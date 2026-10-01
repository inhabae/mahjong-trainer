"""Persistent card and immutable review snapshots, independent of FSRS types."""
from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, Field, StrictBool

Rating = Annotated[int, Field(strict=True, ge=1, le=4)]
CardState = Literal["new", "learning", "review", "relearning"]


class CreateTrainingItem(BaseModel):
    source_game_id: str = Field(min_length=1)
    decision_id: str = Field(min_length=1)
    category: Literal["CALL_DECISION", "RIICHI_DECISION", "PUSH_FOLD", "BETAORI", "TILE_EFFICIENCY", "ENDGAME_PLACEMENT", "UNCLASSIFIED"]
    severity: Literal["MATCH", "MINOR", "INACCURACY", "MISTAKE"]


class TrainingItem(CreateTrainingItem):
    id: int
    state: CardState = "new"
    due_at: datetime
    interval_days: float = 0
    stability: float | None = None
    difficulty: float | None = None
    # Required to resume the library's learning/relearning steps after restart.
    learning_step: int | None = None
    reps: int = 0
    lapses: int = 0
    last_reviewed_at: datetime | None = None
    last_rating: Rating | None = None
    created_at: datetime
    updated_at: datetime


class ReviewRequest(BaseModel):
    rating: Rating
    user_action: str
    model_action: str | None
    was_correct: StrictBool
    response_time_ms: Annotated[int, Field(strict=True, ge=0)] | None = None


class ReviewLog(ReviewRequest):
    id: int
    training_item_id: int
    reviewed_at: datetime
    elapsed_days: float
    scheduled_days: float
    stability_before: float | None
    difficulty_before: float | None
    due_at_before: datetime
    stability_after: float
    difficulty_after: float
    due_at_after: datetime
