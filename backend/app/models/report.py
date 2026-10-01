from typing import Any

from pydantic import BaseModel, Field


class ActionEvaluation(BaseModel):
    action: str
    q_value: float | None = None
    policy_probability_percent: float | None = None
    raw_action: str | None = None
    raw_q_value: str | None = None
    raw_policy_probability: str | None = None


class Decision(BaseModel):
    turn: int | None = None
    turn_label: str | None = None
    shanten: int | None = None
    actual_action: str | None = None
    mortal_action: str | None = None
    legal_actions: list[ActionEvaluation] = Field(default_factory=list)
    raw_summary: str | None = None
    concealed_hand: list[str] = Field(default_factory=list)
    drawn_tile: str | None = None
    call_tile: str | None = None
    call_from: str | None = None


class Round(BaseModel):
    id: str
    label: str | None = None
    result: str | None = None
    decisions: list[Decision] = Field(default_factory=list)
    original_game_log: dict[str, Any] | None = None


class ReportMetadata(BaseModel):
    engine: str | None = None
    mortal_model_version: str | None = None
    softmax_temperature: float | None = None
    analyzed_player: int | None = None
    reviewer_version: str | None = None
    raw: dict[str, str] = Field(default_factory=dict)


class ParsedReport(BaseModel):
    format: str = "mjai-reviewer"
    metadata: ReportMetadata
    rounds: list[Round] = Field(default_factory=list)
    embedded_game_log: dict[str, Any] | None = None
