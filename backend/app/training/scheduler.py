"""The sole adapter to py-fsrs. No Mahjong rules or persistence belong here."""
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Sequence

from fsrs import Card, Rating, Scheduler, State

from app.models.training import CardState, TrainingItem


@dataclass(frozen=True)
class SchedulingResult:
    stability: float
    difficulty: float
    interval_days: float
    due_at: datetime
    state: CardState
    learning_step: int | None
    lapse_increment: int


class TrainingScheduler:
    def __init__(self, desired_retention: float = 0.90,
                 parameters: Sequence[float] | None = None,
                 enable_fuzzing: bool = True):
        # Parameter injection is reserved for future personalization.
        options = {} if parameters is None else {"parameters": parameters}
        self._scheduler = Scheduler(desired_retention=desired_retention,
                                    enable_fuzzing=enable_fuzzing, **options)

    @staticmethod
    def _card(item: TrainingItem) -> Card:
        states = {"new": State.Learning, "learning": State.Learning,
                  "review": State.Review, "relearning": State.Relearning}
        return Card(card_id=item.id, state=states[item.state], step=item.learning_step,
                    stability=item.stability, difficulty=item.difficulty,
                    due=item.due_at, last_review=item.last_reviewed_at)

    def retrievability(self, item: TrainingItem, at: datetime) -> float:
        return self._scheduler.get_card_retrievability(self._card(item), self._utc(at))

    @staticmethod
    def _utc(at: datetime) -> datetime:
        if at.tzinfo is None or at.utcoffset() is None:
            raise ValueError("Review time must be timezone-aware")
        return at.astimezone(timezone.utc)

    def schedule_review(self, item: TrainingItem, rating: int,
                        reviewed_at: datetime) -> SchedulingResult:
        if type(rating) is not int or rating not in (1, 2, 3, 4):
            raise ValueError("Rating must be an integer from 1 to 4")
        reviewed_at = self._utc(reviewed_at)
        if item.last_reviewed_at and reviewed_at < item.last_reviewed_at:
            raise ValueError("Review time precedes the previous review")
        card, _ = self._scheduler.review_card(self._card(item), Rating(rating), reviewed_at)
        assert card.stability is not None and card.difficulty is not None
        return SchedulingResult(
            stability=card.stability, difficulty=card.difficulty,
            interval_days=(card.due - reviewed_at).total_seconds() / 86400,
            due_at=card.due, state=card.state.name.lower(), learning_step=card.step,
            # Anki-style lapses count failures from Review, not repeated learning failures.
            lapse_increment=int(item.state == "review" and rating == 1),
        )

    def preview(self, item: TrainingItem, reviewed_at: datetime) -> dict[int, SchedulingResult]:
        """Return each rating's schedule from the same card state and timestamp."""
        return {rating: self.schedule_review(item, rating, reviewed_at) for rating in (1, 2, 3, 4)}


_default_scheduler = TrainingScheduler()


def schedule_review(training_item: TrainingItem, rating: int,
                    reviewed_at: datetime) -> SchedulingResult:
    return _default_scheduler.schedule_review(training_item, rating, reviewed_at)
