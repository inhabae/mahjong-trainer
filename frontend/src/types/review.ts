export type Severity = "MATCH" | "MINOR" | "INACCURACY" | "MISTAKE";

export interface Meld {
  kind: string;
  tiles: string[];
  called_from: number | null;
  called_tile: string | null;
  called_index: number | null;
  raw: string | null;
}

export interface PlayerState {
  seat: number;
  score: number | null;
  discards: string[];
  tsumogiri_discard_indices: number[];
  riichi_discard_indices: number[];
  melds: Meld[];
  riichi: boolean;
  concealed_count: number | null;
  has_drawn_tile: boolean;
  revealed_hand: string[] | null;
  is_tenpai: boolean;
}

export interface GameState {
  round_id: string;
  round_label: string | null;
  dealer: number | null;
  honba: number | null;
  kyotaku: number | null;
  scores: (number | null)[];
  analyzed_player: number;
  turn: number | null;
  tiles_remaining: number | null;
  concealed_hand: string[];
  drawn_tile: string | null;
  winning_tile: string | null;
  winner: number | null;
  win_type: string | null;
  players: PlayerState[];
  dora_indicators: string[];
  legal_actions: string[];
  raw_event_index: number | null;
}

export interface EffectiveTile {
  tile: string;
  visible_copies: number;
  remaining: number;
}

export interface DiscardAnalysis {
  shanten: number;
  effective_tile_types: number;
  effective_tiles: EffectiveTile[];
  ukeire: number;
}

export interface ActionAnalysis extends DiscardAnalysis {
  discard?: string;
  discard_options?: ActionAnalysis[];
  analysis_basis?: "best_discard_option";
}

export interface DecisionAnalysis {
  mortal_mismatch: boolean;
  player_action: string | null;
  mortal_action: string | null;
  player_analysis?: DiscardAnalysis | null;
  mortal_analysis?: DiscardAnalysis | null;
  difference?: {
    shanten_delta: number;
    ukeire_delta: number;
    ukeire_ratio: number | null;
    effective_tile_type_delta: number;
  };
}

export interface Decision {
  id: string;
  round_id: string;
  decision_index: number;
  actual_action: string | null;
  mortal_action: string | null;
  state: GameState;
  analysis: DecisionAnalysis | null;
  severity: Severity | null;
  mortal: {
    player_policy?: number | null;
    best_policy?: number | null;
    [key: string]: unknown;
  } | null;
  actions: Record<string, unknown>[];
}

export interface ReviewResponse {
  source_file: string;
  analyzed_player: number;
  summary: Record<string, number>;
  warnings: string[];
  decisions: Decision[];
}

export interface ReplayEvent {
  round_id: string;
  step_index: number;
  actor: number;
  action: string;
  tile: string | null;
  raw: unknown;
  state: GameState;
  player_perspective_analysis?: ActionAnalysis;
}

export interface ReplayResponse {
  source_file: string;
  analyzed_player: number;
  events: ReplayEvent[];
  event_count: number;
}
