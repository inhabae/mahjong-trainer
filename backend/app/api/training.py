from datetime import datetime, timezone
from functools import lru_cache
import os
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException

from app.models.training import CreateTrainingItem, ReviewLog, ReviewRequest, TrainingItem
from app.training.store import TrainingStore

router = APIRouter(prefix="/api/training-items", tags=["training"])


@lru_cache
def get_store() -> TrainingStore:
    return TrainingStore(os.environ.get("TRAINING_DB_PATH", str(Path(__file__).resolve().parents[2] / "training.sqlite3")))


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


@router.post("", response_model=TrainingItem)
def create_item(body: CreateTrainingItem, store: TrainingStore = Depends(get_store)):
    return store.create(body, utc_now())


@router.post("/preview")
def preview_item(body: CreateTrainingItem, at: datetime | None = None, store: TrainingStore = Depends(get_store)):
    due_times = store.preview(body, at or utc_now())
    return {"due_at": {str(rating): due.isoformat() for rating, due in due_times.items()}}


@router.get("", response_model=list[TrainingItem])
def source_items(source_game_id: str, store: TrainingStore = Depends(get_store)):
    return store.for_source(source_game_id)


@router.get("/due", response_model=list[TrainingItem])
def due_items(at: datetime | None = None, store: TrainingStore = Depends(get_store)):
    return store.due(at or utc_now())


@router.post("/{item_id}/review", response_model=TrainingItem)
def review_item(item_id: int, body: ReviewRequest, at: datetime | None = None, store: TrainingStore = Depends(get_store)):
    try:
        return store.review(item_id, body, at or utc_now())
    except KeyError:
        raise HTTPException(status_code=404, detail="Training item not found") from None
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.delete("/{item_id}/review", response_model=TrainingItem)
def undo_review_item(item_id: int, reviewed_at: datetime, store: TrainingStore = Depends(get_store)):
    try:
        return store.undo_review(item_id, reviewed_at, utc_now())
    except KeyError:
        raise HTTPException(status_code=404, detail="Training review not found") from None
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.delete("/{item_id}")
def delete_unreviewed_item(item_id: int, store: TrainingStore = Depends(get_store)):
    try:
        store.delete_unreviewed(item_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="Training item not found") from None
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {"ok": True}


@router.get("/{item_id}/reviews", response_model=list[ReviewLog])
def item_reviews(item_id: int, store: TrainingStore = Depends(get_store)):
    try:
        return store.reviews(item_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="Training item not found") from None
