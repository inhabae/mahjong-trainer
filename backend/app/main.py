from fastapi import Depends, FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pathlib import Path
from functools import lru_cache
from datetime import datetime, timezone
import json
import gzip
from threading import Lock

from pydantic import BaseModel
from app.api.training import get_store, router as training_router
from app.models.game_state import GameState

from app.parsers.mjai_reviewer import MalformedReportError, UnsupportedReportError, parse_mjai_reviewer_html
from app.analysis.reconstruction import reconstruct_report
from app.analysis.ukeire import analyze_discard, calculate_effective_tiles, calculate_shanten, normalize_tile
from app.training.source_identity import decision_id, source_game_id
from app.training.store import TrainingStore

app = FastAPI(title="Riichi Mahjong Trainer API", version="0.1.0")
app.include_router(training_router)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

DEFAULT_REPORT = Path(__file__).resolve().parents[1] / "tests" / "fixtures" / "e417343c4d3491e7.html"
DEFAULT_REPORT_CACHE = Path(__file__).resolve().parents[1] / "data" / "default_report.json.gz"
DEFAULT_REPLAY_CACHE = Path(__file__).resolve().parents[1] / "data" / "default_replay.json.gz"
ANNOTATIONS_FILE = Path(__file__).resolve().parents[1] / "training_annotations.json"
MISTAKES_FILE = Path(__file__).resolve().parents[1] / "training_mistakes.json"
_annotation_lock = Lock()
TRAINING_CATEGORIES = {"CALL_DECISION", "RIICHI_DECISION", "PUSH_FOLD", "BETAORI", "TILE_EFFICIENCY", "ENDGAME_PLACEMENT"}
TRAINING_SEVERITIES = {"REASONABLE", "MINOR", "INACCURACY", "MISTAKE"}


class TrainingAnnotation(BaseModel):
    category: str
    confirmed: bool = True


class UndoAnnotation(BaseModel):
    expected_category: str
    previous_annotation: TrainingAnnotation | None = None


class MistakeRecord(BaseModel):
    decision_id: str
    source_file: str
    severity: str
    category: str
    user_action: str
    user_policy: float | None = None
    mortal_action: str | None = None
    mortal_policy: float | None = None
    reviewed_at: str


class UndoMistakeRecord(BaseModel):
    decision_id: str
    source_file: str
    reviewed_at: str
    previous_record: MistakeRecord | None = None


class RiichiCheckRequest(BaseModel):
    state: GameState
    discard: str


@app.post("/api/analysis/riichi-check")
def riichi_check(body: RiichiCheckRequest) -> dict:
    state = body.state
    if not 0 <= state.analyzed_player < len(state.players):
        raise HTTPException(status_code=422, detail="Invalid analyzed player")
    player = state.players[state.analyzed_player]
    hand = list(state.concealed_hand) + ([state.drawn_tile] if state.drawn_tile else [])
    wanted = normalize_tile(body.discard)
    tile_index = next((index for index, tile in enumerate(hand) if normalize_tile(tile) == wanted), None)
    if tile_index is None:
        raise HTTPException(status_code=422, detail="Selected discard is not in the hand")
    discard = hand.pop(tile_index)
    melds = player.melds
    shanten = calculate_shanten(hand, melds)
    analyzed_players = [item.model_copy(deep=True) for item in state.players]
    analyzed_players[state.analyzed_player].discards.append(discard)
    post_discard_state = state.model_copy(update={
        "concealed_hand": hand, "drawn_tile": None, "players": analyzed_players,
    })
    effective = calculate_effective_tiles(post_discard_state, hand, melds) if shanten == 0 else {}
    tenpai = shanten == 0
    score = state.scores[state.analyzed_player] if state.analyzed_player < len(state.scores) else None
    closed_hand = all(meld.kind == "ankan" for meld in melds)
    can_riichi = bool(tenpai and closed_hand and score is not None and score >= 1000
                      and (state.tiles_remaining is None or state.tiles_remaining > 0)
                      and not player.riichi)
    return {
        "tenpai": tenpai,
        "can_riichi": can_riichi,
        "waits": [{"tile": tile, "remaining": remaining} for tile, remaining in effective.items()],
        "ukeire": sum(effective.values()),
    }


def read_annotations() -> dict[str, dict]:
    try:
        value = json.loads(ANNOTATIONS_FILE.read_text())
        return value if isinstance(value, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


@app.get("/api/training/annotations")
def get_training_annotations() -> dict:
    with _annotation_lock:
        return {"annotations": read_annotations()}


@app.put("/api/training/annotations/{decision_id:path}")
def save_training_annotation(decision_id: str, annotation: TrainingAnnotation) -> dict:
    if annotation.category not in TRAINING_CATEGORIES:
        raise HTTPException(status_code=422, detail="Choose one of the six training categories")
    with _annotation_lock:
        annotations = read_annotations()
        annotations[decision_id] = annotation.model_dump()
        ANNOTATIONS_FILE.write_text(json.dumps(annotations, indent=2, sort_keys=True) + "\n")
    return {"decision_id": decision_id, **annotation.model_dump()}


@app.post("/api/training/annotations/{decision_id:path}/undo")
def undo_training_annotation(decision_id: str, body: UndoAnnotation) -> dict:
    with _annotation_lock:
        annotations = read_annotations()
        current = annotations.get(decision_id)
        if current is None or current.get("category") != body.expected_category:
            raise HTTPException(status_code=409, detail="The saved category has changed since this answer")
        if body.previous_annotation is None:
            annotations.pop(decision_id, None)
        else:
            annotations[decision_id] = body.previous_annotation.model_dump()
        ANNOTATIONS_FILE.write_text(json.dumps(annotations, indent=2, sort_keys=True) + "\n")
    return {"ok": True}


def read_mistakes() -> list[dict]:
    try:
        value = json.loads(MISTAKES_FILE.read_text())
        return value if isinstance(value, list) else []
    except (OSError, json.JSONDecodeError):
        return []


@app.get("/api/training/mistakes")
def get_training_mistakes() -> dict:
    with _annotation_lock:
        records = read_mistakes()
    by_severity = {key: sum(record.get("severity") == key for record in records) for key in sorted(TRAINING_SEVERITIES)}
    by_category = {key: sum(record.get("category") == key for record in records) for key in sorted(TRAINING_CATEGORIES)}
    return {"records": records, "stats": {"total": len(records), "by_severity": by_severity, "by_category": by_category}}


@app.post("/api/training/mistakes")
def save_training_mistake(record: MistakeRecord) -> dict:
    if record.severity not in TRAINING_SEVERITIES:
        raise HTTPException(status_code=422, detail="Invalid training severity")
    if record.category not in TRAINING_CATEGORIES:
        raise HTTPException(status_code=422, detail="Choose one of the six training categories")
    with _annotation_lock:
        records = read_mistakes()
        # One canonical saved result per source decision; retaking updates it.
        previous_record = next((item for item in records if item.get("decision_id") == record.decision_id and item.get("source_file") == record.source_file), None)
        records = [item for item in records if not (item.get("decision_id") == record.decision_id and item.get("source_file") == record.source_file)]
        records.append(record.model_dump())
        MISTAKES_FILE.write_text(json.dumps(records, indent=2, sort_keys=True) + "\n")
    return {"record": record.model_dump(), "previous_record": previous_record}


@app.post("/api/training/mistakes/undo")
def undo_training_mistake(body: UndoMistakeRecord) -> dict:
    with _annotation_lock:
        records = read_mistakes()
        current = next((item for item in records if item.get("decision_id") == body.decision_id and item.get("source_file") == body.source_file), None)
        if current is not None and current.get("reviewed_at") != body.reviewed_at:
            raise HTTPException(status_code=409, detail="The saved answer has changed since this question")
        records = [item for item in records if not (item.get("decision_id") == body.decision_id and item.get("source_file") == body.source_file)]
        if body.previous_record is not None:
            records.append(body.previous_record.model_dump())
        MISTAKES_FILE.write_text(json.dumps(records, indent=2, sort_keys=True) + "\n")
    return {"ok": True}


@app.delete("/api/training/progress")
def reset_training_progress() -> dict:
    """Clear mistake history and restart all spaced-repetition schedules."""
    with _annotation_lock:
        MISTAKES_FILE.write_text("[]\n")
        get_store().reset_progress()
    return {"ok": True}


@app.delete("/api/training/data")
def reset_all_training_data() -> dict:
    """Delete imported games, training history, saved mistakes, and categories."""
    with _annotation_lock:
        MISTAKES_FILE.write_text("[]\n")
        ANNOTATIONS_FILE.write_text("{}\n")
        get_store().reset_all()
    return {"ok": True}


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/reports/default")
async def default_report(store: TrainingStore = Depends(get_store)) -> dict:
    """Serve the precomputed default report; rebuild it with the parse script."""
    try:
        with gzip.open(DEFAULT_REPORT_CACHE, "rt", encoding="utf-8") as cache:
            report = json.load(cache)
        game_id = _default_source_game_id()
        store.register_source(game_id, DEFAULT_REPORT.name, report["decisions"])
        report["source_game_id"] = game_id
        return report
    except (OSError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=503, detail="Default report cache is missing or invalid; run `python -m scripts.rebuild_default_report` from backend/") from exc


@lru_cache(maxsize=1)
def _default_source_game_id() -> str:
    parsed = parse_mjai_reviewer_html(DEFAULT_REPORT.read_bytes())
    return source_game_id(parsed)


@app.get("/api/reports/default/replay")
async def default_full_replay() -> dict:
    """Serve the precomputed chronological replay."""
    try:
        with gzip.open(DEFAULT_REPLAY_CACHE, "rt", encoding="utf-8") as cache:
            return json.load(cache)
    except (OSError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=503, detail="Default replay cache is missing or invalid; run `python -m scripts.rebuild_default_report` from backend/") from exc


def build_default_cache() -> tuple[dict, dict]:
    """Parse the default HTML report and build the JSON served by normal requests."""
    parsed = parse_mjai_reviewer_html(DEFAULT_REPORT.read_bytes())
    reconstructed = reconstruct_report(parsed)
    game_id = source_game_id(parsed)
    report = {"source_file": DEFAULT_REPORT.name,
              "source_game_id": game_id,
              "analyzed_player": reconstructed.analyzed_player, "summary": reconstructed.summary,
              "warnings": reconstructed.warnings,
              "decisions": [{**item.model_dump(), "id": decision_id(item.round_id, item.decision_index)}
                            for item in reconstructed.decisions]}
    events = []
    last_player_analysis = None
    last_analysis_round = None
    for item in reconstructed.replay_steps:
        payload = item.model_dump()
        state = item.state
        if state.round_id != last_analysis_round:
            last_player_analysis = None
            last_analysis_round = state.round_id
        if item.actor == state.analyzed_player and state.concealed_hand:
            hand = list(state.concealed_hand)
            if state.drawn_tile and hand.count(state.drawn_tile) == 0:
                hand.append(state.drawn_tile)
            if len(hand) > 14:
                events.append(payload)
                continue
            melds = state.players[state.analyzed_player].melds if state.players else []
            expected_hand_size = 14 - 3 * len(melds)
            if len(hand) == expected_hand_size:
                discard_options = {}
                for tile in hand:
                    remaining_hand = list(hand)
                    remaining_hand.remove(tile)
                    tile_state = state.model_copy(update={"concealed_hand": remaining_hand, "drawn_tile": None})
                    try:
                        effective = calculate_effective_tiles(tile_state, remaining_hand, melds)
                        discard_options.setdefault(normalize_tile(tile), []).append({
                            "discard": tile,
                            "shanten": calculate_shanten(remaining_hand, melds),
                            "ukeire": sum(effective.values()),
                            "effective_tile_types": len(effective),
                            "effective_tiles": [
                                {"tile": effective_tile, "remaining": remaining, "visible_copies": 4 - remaining}
                                for effective_tile, remaining in effective.items()
                            ],
                        })
                    except (AssertionError, ValueError):
                        continue
                flattened_options = [option for options in discard_options.values() for option in options]
                if flattened_options:
                    chosen_discard = normalize_tile(item.tile) if item.action in {"discard", "dahai"} and item.tile else None
                    chosen_options = discard_options.get(chosen_discard, [])
                    if chosen_options:
                        last_player_analysis = {**chosen_options[0], "discard_options": flattened_options}
                    else:
                        best_option = min(flattened_options, key=lambda value: (value["shanten"], -value["ukeire"]))
                        last_player_analysis = {**best_option, "discard_options": flattened_options, "analysis_basis": "best_discard_option"}
        if last_player_analysis is not None:
            payload["player_perspective_analysis"] = last_player_analysis
        events.append(payload)
    replay = {
            "source_file": DEFAULT_REPORT.name,
            "analyzed_player": reconstructed.analyzed_player,
            "events": events,
            "event_count": len(events),
        }
    return report, replay


@app.post("/api/reports/parse")
async def parse_report(file: UploadFile = File(...)) -> dict:
    if not file.filename or not file.filename.lower().endswith(".html"):
        raise HTTPException(status_code=415, detail="Upload an .html mjai-reviewer report")
    try:
        return parse_mjai_reviewer_html(await file.read()).model_dump()
    except UnsupportedReportError as exc:
        raise HTTPException(status_code=415, detail=str(exc)) from exc
    except MalformedReportError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@app.post("/api/reports/reconstruct")
async def reconstruct_uploaded_report(file: UploadFile = File(...)) -> dict:
    if not file.filename or not file.filename.lower().endswith(".html"):
        raise HTTPException(status_code=415, detail="Upload an .html mjai-reviewer report")
    try:
        return reconstruct_report(parse_mjai_reviewer_html(await file.read())).model_dump()
    except UnsupportedReportError as exc:
        raise HTTPException(status_code=415, detail=str(exc)) from exc
    except (MalformedReportError, ValueError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@app.post("/api/reports/review")
async def review_uploaded_report(file: UploadFile = File(...), store: TrainingStore = Depends(get_store)) -> dict:
    if not file.filename or not file.filename.lower().endswith(".html"):
        raise HTTPException(status_code=415, detail="Upload an .html mjai-reviewer report")
    try:
        parsed = parse_mjai_reviewer_html(await file.read())
        reconstructed = reconstruct_report(parsed)
        game_id = source_game_id(parsed)
        decisions = [{**item.model_dump(), "id": decision_id(item.round_id, item.decision_index)}
                     for item in reconstructed.decisions]
        store.register_source(game_id, file.filename, decisions, datetime.now(timezone.utc))
        highlighted = [item for item in reconstructed.decisions if item.severity in {"MISTAKE", "INACCURACY"}]
        debug = [
            f"{item.state.round_label or item.round_id} Turn {item.state.turn}\n"
            f"Player: {item.actual_action} — {((item.mortal or {}).get('player_policy') or 0) * 100:.1f}%\n"
            f"Mortal: {item.mortal_action} — {((item.mortal or {}).get('best_policy') or 0) * 100:.1f}%\n"
            f"Severity: {item.severity}"
            for item in reconstructed.decisions if item.severity != "MATCH"
        ]
        return {"source_file": file.filename, "source_game_id": game_id,
                "analyzed_player": reconstructed.analyzed_player, "summary": reconstructed.summary,
                "warnings": reconstructed.warnings,
                "decisions": [{**item.model_dump(), "id": decision_id(item.round_id, item.decision_index)}
                              for item in highlighted],
                "debug": debug}
    except UnsupportedReportError as exc:
        raise HTTPException(status_code=415, detail=str(exc)) from exc
    except (MalformedReportError, ValueError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@app.get("/api/training-sources/{source_id}/decisions")
def training_source_decisions(source_id: str, store: TrainingStore = Depends(get_store)) -> dict:
    decisions = store.source_decisions(source_id)
    if decisions is None:
        raise HTTPException(
            status_code=404,
            detail=f"Source game '{source_id}' is unavailable. Re-upload the original game report to restore its review positions.",
        )
    return {"source_game_id": source_id, "decisions": decisions}


@app.get("/api/training-sources")
def training_sources(store: TrainingStore = Depends(get_store)) -> list[dict]:
    return store.sources()
