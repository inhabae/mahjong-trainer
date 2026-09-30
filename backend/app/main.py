from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pathlib import Path

from app.parsers.mjai_reviewer import MalformedReportError, UnsupportedReportError, parse_mjai_reviewer_html
from app.analysis.reconstruction import reconstruct_report

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
                              for item in highlighted]}
    except (UnsupportedReportError, MalformedReportError, ValueError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@app.get("/api/reports/default/replay")
async def default_full_replay() -> dict:
    """Complete chronological replay, intentionally independent of review highlights."""
    if not DEFAULT_REPORT.exists():
        raise HTTPException(status_code=404, detail="Default report fixture is unavailable")
    try:
        reconstructed = reconstruct_report(parse_mjai_reviewer_html(DEFAULT_REPORT.read_bytes()))
        return {
            "source_file": DEFAULT_REPORT.name,
            "analyzed_player": reconstructed.analyzed_player,
            "events": [item.model_dump() for item in reconstructed.replay_steps],
            "event_count": len(reconstructed.replay_steps),
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
