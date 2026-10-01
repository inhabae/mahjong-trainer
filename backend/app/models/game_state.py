from typing import Any

from pydantic import BaseModel, Field


class Meld(BaseModel):
    kind: str
    tiles: list[str] = Field(default_factory=list)
    called_from: int | None = None
    called_tile: str | None = None
    called_index: int | None = None
    raw: str | None = None


class PlayerState(BaseModel):
    seat: int
    score: int | None = None
    discards: list[str] = Field(default_factory=list)
    tsumogiri_discard_indices: list[int] = Field(default_factory=list)
    riichi_discard_indices: list[int] = Field(default_factory=list)
    melds: list[Meld] = Field(default_factory=list)
    riichi: bool = False
    concealed_count: int | None = None
    has_drawn_tile: bool = False
    revealed_hand: list[str] | None = None
    is_tenpai: bool = False


class GameState(BaseModel):
    """Only information visible to the analyzed player at decision time."""

    round_id: str
    round_label: str | None = None
    dealer: int | None = None
    honba: int | None = None
    kyotaku: int | None = None
    scores: list[int | None] = Field(default_factory=list)
    analyzed_player: int
    turn: int | None = None
    tiles_remaining: int | None = None
    concealed_hand: list[str] = Field(default_factory=list)
    drawn_tile: str | None = None
    call_tile: str | None = None
    call_tile_is_riichi: bool = False
    call_from: str | None = None
    winning_tile: str | None = None
    winner: int | None = None
    win_type: str | None = None
    players: list[PlayerState] = Field(default_factory=list)
    dora_indicators: list[str] = Field(default_factory=list)
    legal_actions: list[str] = Field(default_factory=list)
    raw_event_index: int | None = None


class ReconstructedDecision(BaseModel):
    round_id: str
    decision_index: int
    actual_action: str | None = None
    mortal_action: str | None = None
    state: GameState
    analysis: dict | None = None
    severity: str | None = None
    mortal: dict | None = None
    actions: list[dict] = Field(default_factory=list)
    category: str = "UNCLASSIFIED"
    threatening_seats: list[int] = Field(default_factory=list)
    discard_safety: list[dict] = Field(default_factory=list)

class ReplayStep(BaseModel):
    round_id: str
    step_index: int
    actor: int
    action: str
    tile: str | None = None
    raw: Any = None
    state: GameState


class ReconstructedReport(BaseModel):
    format: str = "mjai-reviewer"
    analyzed_player: int
    decisions: list[ReconstructedDecision] = Field(default_factory=list)
    replay_steps: list[ReplayStep] = Field(default_factory=list)
    summary: dict[str, int] = Field(default_factory=dict)
    warnings: list[str] = Field(default_factory=list)
