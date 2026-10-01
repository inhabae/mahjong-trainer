# Riichi Mahjong Trainer

Initial monorepo for a personalized Riichi Mahjong training web app.

## Prerequisites

- Python 3.12+
- Node.js 18+

## Run the backend

```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -e '.[dev]'
uvicorn app.main:app --reload
```

The API is available at `http://localhost:8000`; health check: `GET /api/health`.

The default training report and replay are served from precomputed JSON in
`backend/data/`; starting or restarting the API does not parse the source HTML.
After changing the HTML or fixing parser/reconstruction bugs, refresh both files
explicitly:

```bash
cd backend
python -m scripts.rebuild_default_report
```

The script reads the checked-in `tests/fixtures/e417343c4d3491e7.html` once and
writes `data/default_report.json.gz` and `data/default_replay.json.gz`. Uploaded-report
endpoints continue to parse the uploaded HTML on demand.

### Parse a saved mjai-reviewer report

```bash
curl -F 'file=@report.html' http://localhost:8000/api/reports/parse
```

The endpoint accepts saved `.html` reports, returns typed normalized JSON for
Mortal metadata, rounds, decisions, action evaluations, shanten, and embedded
game-log data, and rejects unsupported or malformed reports with a clear
`4xx` response.

### Reconstruct visible decision states

```bash
curl -F 'file=@report.html' http://localhost:8000/api/reports/reconstruct
```

This returns one deterministic `GameState` per analyzed decision. It includes
the analyzed player's visible hand and draw, round header state, scores,
turn, legal actions, and public player state. Opponent concealed hands are not
included.

## Run the frontend

In another terminal:

```bash
cd frontend
npm install
npm run dev
```

Open `http://localhost:5173`. Run the backend and frontend dev servers separately; Vite proxies `/api` to FastAPI on port 8000. Do not use `vite preview` or a static server by itself, because those servers return `index.html` for `/api/*` instead of API JSON.

## Test

```bash
cd backend
pytest
```

Mahjong logic is intentionally reserved for `backend/app/mahjong/`, independent from the API, UI, and future analysis/training features.

## Spaced repetition

Training uses [`fsrs==6.3.2` (py-fsrs)](https://github.com/open-spaced-repetition/py-fsrs),
with the library's default FSRS parameters, 0.90 desired retention, default learning
steps (1 and 10 minutes), relearning step (10 minutes), and interval fuzzing.
Only `backend/app/training/scheduler.py` imports FSRS. Its `TrainingScheduler`
accepts optional parameters for future personalization; optimization is not implemented.
Retrievability is computed on demand by the library, never persisted.

After choosing a Mahjong action, explicitly select Again (failed recall), Hard
(successful but difficult), Good, or Easy. Correctness and response duration never
choose or modify the rating. The frontend creates/retrieves the card on rating,
then submits the review. A successful save shows the next due time; buttons are
disabled while saving and after success for that displayed attempt.

SQLite stores cards and immutable review logs in `backend/training.sqlite3`.
Override the path with `TRAINING_DB_PATH` (the parent directory must exist).
Tables initialize automatically on first use. Existing JSON annotation/mistake
files remain unchanged and are not automatically imported, since they contain no
explicit memory ratings. Back up the SQLite file to retain scheduling history.
Updates and log inserts share a transaction; a unique source/decision pair prevents
duplicate cards. No user/deck system is added to this single-user app.

The current app identifies games by `source_file`, so the frontend sends that
existing value as `source_game_id`, together with the existing `round_id:decision_index`
decision ID. Filenames must therefore identify games uniquely; a future game
registry can supply its canonical ID through the same field.

- `POST /api/training-items`: `{source_game_id, decision_id, category, severity}`;
  creates or retrieves the existing card without resetting it or changing metadata.
- `GET /api/training-items/due`: cards with `due_at <= now`, ordered by due time and ID.
- `POST /api/training-items/{id}/review`: `{rating, user_action, model_action, was_correct,
  response_time_ms?}`; updates the card and appends history using server UTC time.
- `GET /api/training-items/{id}/reviews`: chronological before/after review snapshots.

New cards have null stability/difficulty. The library initializes both at first
review. `learning_step` is persisted to resume learning/relearning across restarts.
`interval_days` and log `scheduled_days` represent the newly scheduled duration in
fractional days, preserving minute-long steps; `elapsed_days` records actual elapsed
time, while FSRS applies its own elapsed-time semantics internally. Every review
increments reps; only Again from review state increments lapses (initial learning
failures and repeated relearning failures do not). The due API supports a future
review session; the current report-based session remains unchanged.
