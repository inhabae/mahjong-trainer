from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pathlib import Path

from app.parsers.mjai_reviewer import MalformedReportError, UnsupportedReportError, parse_mjai_reviewer_html
from app.analysis.reconstruction import reconstruct_report
from app.analysis.ukeire import analyze_discard, calculate_effective_tiles, calculate_shanten, normalize_tile

app = FastAPI(title="Riichi Mahjong Trainer API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

DEFAULT_REPORT = Path(__file__).resolve().parents[1] / "tests" / "fixtures" / "e417343c4d3491e7.html"


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/reports/default")
async def default_report() -> dict:
    """Development default: review the checked-in e417 fixture."""
    if not DEFAULT_REPORT.exists():
        raise HTTPException(status_code=404, detail="Default e417 report fixture is unavailable")
    try:
        reconstructed = reconstruct_report(parse_mjai_reviewer_html(DEFAULT_REPORT.read_bytes()))
        highlighted = [item for item in reconstructed.decisions if item.severity in {"MISTAKE", "INACCURACY"}]
        return {"source_file": DEFAULT_REPORT.name,
                "analyzed_player": reconstructed.analyzed_player, "summary": reconstructed.summary,
                "warnings": reconstructed.warnings,
                "decisions": [{**item.model_dump(),
                               "id": f"{item.round_id}:{item.decision_index}"}
                              for item in reconstructed.decisions]}
    except (UnsupportedReportError, MalformedReportError, ValueError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@app.get("/api/reports/default/replay")
async def default_full_replay() -> dict:
    """Complete chronological replay, intentionally independent of review highlights."""
    if not DEFAULT_REPORT.exists():
        raise HTTPException(status_code=404, detail="Default report fixture is unavailable")
    try:
        reconstructed = reconstruct_report(parse_mjai_reviewer_html(DEFAULT_REPORT.read_bytes()))
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
                # Some snapshots already include the draw in concealed_hand;
                # only add the separate draw slot when it is absent.
                if state.drawn_tile and hand.count(state.drawn_tile) == 0:
                    hand.append(state.drawn_tile)
                if len(hand) > 14:
                    events.append(payload)
                    continue
                melds = state.players[state.analyzed_player].melds if state.players else []
                analysis_state = state.model_copy(update={"concealed_hand": hand, "drawn_tile": None})
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
                # Keep the 14-tile discard comparison as one coherent
                # snapshot through the following discard and opponents'
                # turns. A post-discard 13-tile metric is not a new set of
                # discard choices.
            if last_player_analysis is not None:
                payload["player_perspective_analysis"] = last_player_analysis
            events.append(payload)
        return {
            "source_file": DEFAULT_REPORT.name,
            "analyzed_player": reconstructed.analyzed_player,
            "events": events,
            "event_count": len(events),
        }
    except (UnsupportedReportError, MalformedReportError, ValueError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


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
        reconstructed = reconstruct_report(parse_mjai_reviewer_html(await file.read()))
        highlighted = [item for item in reconstructed.decisions if item.severity in {"MISTAKE", "INACCURACY"}]
        debug = [
            f"{item.state.round_label or item.round_id} Turn {item.state.turn}\n"
            f"Player: {item.actual_action} — {((item.mortal or {}).get('player_policy') or 0) * 100:.1f}%\n"
            f"Mortal: {item.mortal_action} — {((item.mortal or {}).get('best_policy') or 0) * 100:.1f}%\n"
            f"Severity: {item.severity}"
            for item in reconstructed.decisions if item.severity != "MATCH"
        ]
        return {"analyzed_player": reconstructed.analyzed_player, "summary": reconstructed.summary,
                "warnings": reconstructed.warnings, "decisions": [item.model_dump() for item in highlighted],
                "debug": debug}
    except UnsupportedReportError as exc:
        raise HTTPException(status_code=415, detail=str(exc)) from exc
    except (MalformedReportError, ValueError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
