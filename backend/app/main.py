from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pathlib import Path
from functools import lru_cache
import json
import gzip
from threading import Lock

from pydantic import BaseModel
from app.api.training import get_store, router as training_router

from app.parsers.mjai_reviewer import MalformedReportError, UnsupportedReportError, parse_mjai_reviewer_html
from app.analysis.reconstruction import reconstruct_report
from app.analysis.ukeire import analyze_discard, calculate_effective_tiles, calculate_shanten, normalize_tile
from app.training.source_identity import decision_id, source_game_id

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
TRAINING_SEVERITIES = {"MINOR", "INACCURACY", "MISTAKE"}


class TrainingAnnotation(BaseModel):
    category: str
    confirmed: bool = True


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
        records = [item for item in records if not (item.get("decision_id") == record.decision_id and item.get("source_file") == record.source_file)]
        records.append(record.model_dump())
        MISTAKES_FILE.write_text(json.dumps(records, indent=2, sort_keys=True) + "\n")
    return {"record": record.model_dump()}


@app.delete("/api/training/progress")
def reset_training_progress() -> dict:
    """Clear mistake history and restart all spaced-repetition schedules."""
    with _annotation_lock:
        MISTAKES_FILE.write_text("[]\n")
    from app.api.training import get_store
    get_store().reset_progress()
    return {"ok": True}


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/reports/default")
async def default_report() -> dict:
    """Serve the precomputed default report; rebuild it with the parse script."""
    try:
        with gzip.open(DEFAULT_REPORT_CACHE, "rt", encoding="utf-8") as cache:
            report = json.load(cache)
        game_id = _default_source_game_id()
        get_store().register_source(game_id, DEFAULT_REPORT.name, report["decisions"])
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
async def review_uploaded_report(file: UploadFile = File(...)) -> dict:
    if not file.filename or not file.filename.lower().endswith(".html"):
        raise HTTPException(status_code=415, detail="Upload an .html mjai-reviewer report")
    try:
        parsed = parse_mjai_reviewer_html(await file.read())
        reconstructed = reconstruct_report(parsed)
        game_id = source_game_id(parsed)
        decisions = [{**item.model_dump(), "id": decision_id(item.round_id, item.decision_index)}
                     for item in reconstructed.decisions]
        get_store().register_source(game_id, file.filename, decisions)
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
def training_source_decisions(source_id: str) -> dict:
    decisions = get_store().source_decisions(source_id)
    if decisions is None:
        raise HTTPException(
            status_code=404,
            detail=f"Source game '{source_id}' is unavailable. Re-upload the original game report to restore its review positions.",
        )
    return {"source_game_id": source_id, "decisions": decisions}
