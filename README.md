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
