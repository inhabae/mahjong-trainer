"""Anki-compatible default FSRS scheduling, isolated from Mahjong behavior.

The FSRS memory model is provided by py-fsrs. This module applies Anki's
default learning/relearning transitions and review interval constraints around
that model. ``learning_step`` in the app model is a zero-based step index.
"""
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import random
import math
from typing import Sequence

from fsrs import Card, Rating, Scheduler, State

from app.models.training import CardState, TrainingItem

SECONDS_PER_DAY = 86_400
DEFAULT_DESIRED_RETENTION = 0.90
DEFAULT_MAXIMUM_INTERVAL_DAYS = 36_500
DEFAULT_LEARNING_STEPS = (timedelta(minutes=1), timedelta(minutes=10))
DEFAULT_RELEARNING_STEPS = (timedelta(minutes=10),)
DEFAULT_FSRS_PARAMETERS = (
    0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001,
    1.8722, 0.1666, 0.796, 1.4835, 0.0614, 0.2629, 1.6483, 0.6014,
    1.8729, 0.5425, 0.0912, 0.0658, 0.1542,
)


def _anki_round(value: float) -> int:
    """Rust f32::round semantics used by Anki for non-negative intervals."""
    return math.floor(value + 0.5)


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
    def __init__(self, desired_retention: float = DEFAULT_DESIRED_RETENTION,
                 parameters: Sequence[float] | None = None,
                 enable_fuzzing: bool = True,
                 maximum_interval: int = DEFAULT_MAXIMUM_INTERVAL_DAYS):
        if desired_retention != DEFAULT_DESIRED_RETENTION:
            raise ValueError("Only Anki's default desired retention (0.90) is supported")
        if maximum_interval != DEFAULT_MAXIMUM_INTERVAL_DAYS:
            raise ValueError("Only Anki's default maximum interval (36500 days) is supported")
        if parameters is not None and tuple(parameters) != DEFAULT_FSRS_PARAMETERS:
            raise ValueError("Only Anki's default FSRS parameters are supported")
        self._scheduler = Scheduler(
            parameters=DEFAULT_FSRS_PARAMETERS,
            desired_retention=DEFAULT_DESIRED_RETENTION,
            learning_steps=DEFAULT_LEARNING_STEPS,
            relearning_steps=DEFAULT_RELEARNING_STEPS,
            maximum_interval=DEFAULT_MAXIMUM_INTERVAL_DAYS,
            enable_fuzzing=False,
        )
        self._enable_fuzzing = enable_fuzzing

    @staticmethod
    def _step(item: TrainingItem) -> int:
        return 0 if item.learning_step is None else item.learning_step

    @staticmethod
    def _card(item: TrainingItem) -> Card:
        states = {"new": State.Learning, "learning": State.Learning,
                  "review": State.Review, "relearning": State.Relearning}
        step = TrainingScheduler._step(item)
        if item.state == "new":
            step = 0
        elif item.state == "relearning":
            # The app's one-step relearning counter is step 0 (10 minutes).
            step = 0
        return Card(card_id=item.id, state=states[item.state], step=step,
                    stability=item.stability, difficulty=item.difficulty,
                    due=item.due_at, last_review=item.last_reviewed_at)

    def retrievability(self, item: TrainingItem, at: datetime) -> float:
        return self._scheduler.get_card_retrievability(self._card(item), self._utc(at))

    @staticmethod
    def _utc(at: datetime) -> datetime:
        if at.tzinfo is None or at.utcoffset() is None:
            raise ValueError("Review time must be timezone-aware")
        return at.astimezone(timezone.utc)

    def _fsrs_result(self, item: TrainingItem, rating: int,
                     reviewed_at: datetime) -> Card:
        card, _ = self._scheduler.review_card(self._card(item), Rating(rating), reviewed_at)
        return card

    @staticmethod
    def _state_result(item: TrainingItem, rating: int, card: Card,
                      reviewed_at: datetime) -> tuple[CardState, int | None, datetime]:
        """Apply Anki's default 1m/10m learning and 10m relearning behavior."""
        step = TrainingScheduler._step(item)
        if item.state in ("new", "learning"):
            if rating == 1:  # Again resets to first step.
                return "learning", 0, reviewed_at + DEFAULT_LEARNING_STEPS[0]
            if rating == 2:  # Hard repeats step; with two steps first is avg(1m, 10m).
                if step <= 0:
                    delay = (DEFAULT_LEARNING_STEPS[0] + DEFAULT_LEARNING_STEPS[1]) / 2
                else:
                    delay = DEFAULT_LEARNING_STEPS[1]
                return "learning", step, reviewed_at + delay
            if rating == 3 and step == 0:
                return "learning", 1, reviewed_at + DEFAULT_LEARNING_STEPS[1]
            if rating == 4:
                # Anki Easy graduates immediately and uses its FSRS Easy interval.
                return "review", None, card.due
            # Good on final learning step graduates to review using FSRS interval.
            return "review", None, card.due

        if item.state == "relearning":
            if rating == 1:
                return "relearning", 0, reviewed_at + DEFAULT_RELEARNING_STEPS[0]
            if rating == 2:
                return "relearning", 0, reviewed_at + DEFAULT_RELEARNING_STEPS[0]
            # Good graduates after the only 10-minute relearning step. Easy
            # always graduates immediately.
            return "review", None, card.due

        if item.state == "review" and rating == 1:
            # Review Again enters the default one-step relearning phase.
            return "relearning", 0, reviewed_at + DEFAULT_RELEARNING_STEPS[0]
        return "review", None, card.due

    def _fuzz_bounds(self, interval: float, minimum: int) -> tuple[int, int]:
        interval = min(float(DEFAULT_MAXIMUM_INTERVAL_DAYS), max(float(minimum), interval))
        if interval < 2.5:
            delta = 0.0
        else:
            delta = 1.0
            for start, end, factor in ((2.5, 7.0, 0.15), (7.0, 20.0, 0.10), (20.0, float("inf"), 0.05)):
                delta += factor * max(0.0, min(interval, end) - start)
        lower = min(DEFAULT_MAXIMUM_INTERVAL_DAYS, max(minimum, _anki_round(interval - delta)))
        upper = min(DEFAULT_MAXIMUM_INTERVAL_DAYS, max(minimum, _anki_round(interval + delta)))
        if lower == upper and upper > 2 and upper < DEFAULT_MAXIMUM_INTERVAL_DAYS:
            upper += 1
        return lower, upper

    def _rounded_review_interval(self, interval: float, minimum: int, card_id: int) -> int:
        minimum = min(minimum, DEFAULT_MAXIMUM_INTERVAL_DAYS)
        if not self._enable_fuzzing:
            return min(DEFAULT_MAXIMUM_INTERVAL_DAYS, max(minimum, _anki_round(interval)))
        lower, upper = self._fuzz_bounds(interval, minimum)
        # Anki selects from the bounded fuzz range via a per-card factor. The
        # persistence model has no such factor, so use a stable per-card value.
        factor = random.Random(card_id).random()
        return min(DEFAULT_MAXIMUM_INTERVAL_DAYS,
                   int(lower + factor * (1 + upper - lower)))

    def _constrain_interval(self, item: TrainingItem, rating: int, state: CardState,
                            card: Card, due_at: datetime, reviewed_at: datetime) -> datetime:
        if state in ("learning", "relearning"):
            return due_at
        raw_days = (card.due - reviewed_at).total_seconds() / SECONDS_PER_DAY
        if item.state in ("new", "learning") and rating == 4:
            # Anki rounds the FSRS Easy interval before applying day fuzz.
            raw_days = float(max(1, _anki_round(raw_days)))
        minimum = 1
        if item.state == "review":
            previous = max(1, round(item.interval_days))
            lower, upper = self._fuzz_bounds(raw_days, 1)
            minimum = (previous + 1 if round(raw_days) > previous
                       else previous if previous <= upper else 0)
            # Anki computes all passing intervals together so each button is
            # guaranteed to be later than the preceding one when possible.
            if rating in (2, 3, 4):
                bases = {}
                for candidate in (2, 3, 4):
                    candidate_card = card if candidate == rating else self._fsrs_result(item, candidate, reviewed_at)
                    bases[candidate] = (candidate_card.due - reviewed_at).total_seconds() / SECONDS_PER_DAY
                hard = self._rounded_review_interval(bases[2], max(1, self._minimum_fuzz_interval(bases[2], previous)), item.id)
                good_min = max(1, self._minimum_fuzz_interval(bases[3], previous), hard + 1)
                good = self._rounded_review_interval(bases[3], good_min, item.id)
                easy_min = max(1, self._minimum_fuzz_interval(bases[4], previous), good + 1)
                chosen = {2: hard, 3: good, 4: self._rounded_review_interval(bases[4], easy_min, item.id)}[rating]
                return reviewed_at + timedelta(days=chosen)
        days = self._rounded_review_interval(raw_days, minimum, item.id)
        return reviewed_at + timedelta(days=days)

    def _minimum_fuzz_interval(self, interval: float, previous: int) -> int:
        rounded = _anki_round(interval)
        _, upper = self._fuzz_bounds(interval, 1)
        if rounded > previous:
            return previous + 1
        if previous <= upper:
            return previous
        return 0

    def schedule_review(self, item: TrainingItem, rating: int,
                        reviewed_at: datetime) -> SchedulingResult:
        if type(rating) is not int or rating not in (1, 2, 3, 4):
            raise ValueError("Rating must be an integer from 1 to 4")
        reviewed_at = self._utc(reviewed_at)
        if item.last_reviewed_at and reviewed_at < item.last_reviewed_at:
            raise ValueError("Review time precedes the previous review")

        card = self._fsrs_result(item, rating, reviewed_at)
        state, learning_step, due_at = self._state_result(item, rating, card, reviewed_at)
        # py-fsrs applies its own fuzzing. Anki uses a different bounded fuzz
        # range, so derive the raw FSRS interval without library fuzz first.
        due_at = self._constrain_interval(item, rating, state, card, due_at, reviewed_at)

        # Anki retains FSRS memory values even while a card is in learning or
        # relearning. For initial states where the library has no memory value,
        # deterministic FSRS state from the library is already attached above.
        assert card.stability is not None and card.difficulty is not None
        return SchedulingResult(
            stability=card.stability, difficulty=card.difficulty,
            interval_days=(due_at - reviewed_at).total_seconds() / SECONDS_PER_DAY,
            due_at=due_at, state=state, learning_step=learning_step,
            lapse_increment=int(item.state == "review" and rating == 1),
        )

    def preview(self, item: TrainingItem, reviewed_at: datetime) -> dict[int, SchedulingResult]:
        """Return each rating's schedule from the same card state and timestamp."""
        return {rating: self.schedule_review(item, rating, reviewed_at) for rating in (1, 2, 3, 4)}


_default_scheduler = TrainingScheduler()


def schedule_review(training_item: TrainingItem, rating: int,
                    reviewed_at: datetime) -> SchedulingResult:
    return _default_scheduler.schedule_review(training_item, rating, reviewed_at)
