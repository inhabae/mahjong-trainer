export type MemoryRating = 1 | 2 | 3 | 4;

export interface TrainingItem {
  id: number;
  source_game_id: string;
  decision_id: string;
  category: string;
  severity: string;
  state: "new" | "learning" | "review" | "relearning";
  due_at: string;
  interval_days: number;
  stability: number | null;
  difficulty: number | null;
  learning_step: number | null;
  reps: number;
  lapses: number;
  last_reviewed_at: string | null;
  last_rating: MemoryRating | null;
  created_at: string;
  updated_at: string;
}

export type TrainingItemInput = Pick<TrainingItem, "source_game_id" | "decision_id" | "category" | "severity">;
export interface TrainingReviewInput {
  rating: MemoryRating;
  user_action: string;
  model_action: string | null;
  was_correct: boolean;
  response_time_ms?: number;
}
export interface ReviewLog extends TrainingReviewInput {
  id: number;
  training_item_id: number;
  reviewed_at: string;
  elapsed_days: number;
  scheduled_days: number;
  stability_before: number | null;
  difficulty_before: number | null;
  due_at_before: string;
  stability_after: number;
  difficulty_after: number;
  due_at_after: string;
}
