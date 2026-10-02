import type { ReviewLog, TrainingItem, TrainingItemInput, TrainingReviewInput } from "../types/training";
import type { HealthResponse } from "../types/health";
import type { GameState, ReplayResponse, ReviewResponse, ReconstructedDecision } from "../types/review";

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8000/api";

export async function fetchHealth(): Promise<HealthResponse> {
  const response = await fetch(`${API_BASE}/health`);
  if (!response.ok) throw new Error(`Health check failed (${response.status})`);
  return response.json() as Promise<HealthResponse>;
}

export async function fetchDefaultReview(): Promise<ReviewResponse> {
  const response = await fetch(`${API_BASE}/reports/default`);
  if (!response.ok) throw new Error(`Default report failed (${response.status})`);
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    throw new Error("The frontend server returned HTML for /api/reports/default. Start the FastAPI backend on port 8000 and use the Vite dev server on port 5173 (which proxies /api).");
  }
  return response.json() as Promise<ReviewResponse>;
}

export async function fetchDefaultReplay(): Promise<ReplayResponse> {
  const response = await fetch(`${API_BASE}/reports/default/replay`);
  if (!response.ok) throw new Error(`Default replay failed (${response.status})`);
  return response.json() as Promise<ReplayResponse>;
}

export type TrainingAnnotation = { category: string; confirmed: boolean };

export async function fetchTrainingAnnotations(): Promise<Record<string, TrainingAnnotation>> {
  const response = await fetch(`${API_BASE}/training/annotations`);
  if (!response.ok) throw new Error(`Training annotations failed (${response.status})`);
  const value = await response.json() as { annotations?: Record<string, TrainingAnnotation> };
  return value.annotations ?? {};
}

export async function saveTrainingAnnotation(id: string, category: string): Promise<void> {
  const response = await fetch(`${API_BASE}/training/annotations/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ category, confirmed: true }),
  });
  if (!response.ok) throw new Error(`Saving category failed (${response.status})`);
}

export type MistakeRecord = {
  decision_id: string; source_file: string; severity: string; category: string;
  user_action: string; user_policy: number | null; mortal_action: string | null;
  mortal_policy: number | null; reviewed_at: string;
};
export type MistakeHistory = {
  records: MistakeRecord[];
  stats: { total: number; by_severity: Record<string, number>; by_category: Record<string, number> };
};

export async function fetchTrainingMistakes(): Promise<MistakeHistory> {
  const response = await fetch(`${API_BASE}/training/mistakes`);
  if (!response.ok) throw new Error(`Mistake history failed (${response.status})`);
  return response.json() as Promise<MistakeHistory>;
}

export async function resetTrainingData(): Promise<void> {
  const response = await fetch(`${API_BASE}/training/data`, { method: "DELETE" });
  if (!response.ok) throw new Error(`Reset training data failed (${response.status})`);
}

export async function saveTrainingMistake(record: MistakeRecord): Promise<{ previous_record: MistakeRecord | null }> {
  const response = await fetch(`${API_BASE}/training/mistakes`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(record),
  });
  if (!response.ok) throw new Error(`Saving mistake failed (${response.status})`);
  return response.json() as Promise<{ previous_record: MistakeRecord | null }>;
}

export async function undoTrainingMistake(input: Pick<MistakeRecord, "decision_id" | "source_file" | "reviewed_at"> & { previous_record: MistakeRecord | null }): Promise<void> {
  const response = await fetch(`${API_BASE}/training/mistakes/undo`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error(`Undoing saved answer failed (${response.status})`);
}

export async function undoTrainingAnnotation(decisionId: string, expectedCategory: string, previousCategory: string | null): Promise<void> {
  const response = await fetch(`${API_BASE}/training/annotations/${encodeURIComponent(decisionId)}/undo`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expected_category: expectedCategory, previous_annotation: previousCategory ? { category: previousCategory, confirmed: true } : null }),
  });
  if (!response.ok) throw new Error(`Undoing saved category failed (${response.status})`);
}

export async function createTrainingItem(input: TrainingItemInput): Promise<TrainingItem> {
  const response = await fetch(`${API_BASE}/training-items`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error(`Creating training item failed (${response.status})`);
  return response.json() as Promise<TrainingItem>;
}

export async function reviewTrainingItem(id: number, input: TrainingReviewInput, at?: string): Promise<TrainingItem> {
  const query = at ? `?at=${encodeURIComponent(at)}` : "";
  const response = await fetch(`${API_BASE}/training-items/${id}/review${query}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error(`Saving memory rating failed (${response.status})`);
  return response.json() as Promise<TrainingItem>;
}

export async function undoTrainingReview(id: number, reviewedAt: string): Promise<TrainingItem> {
  const query = `?reviewed_at=${encodeURIComponent(reviewedAt)}`;
  const response = await fetch(`${API_BASE}/training-items/${id}/review${query}`, { method: "DELETE" });
  if (!response.ok) throw new Error(`Undoing training rating failed (${response.status})`);
  return response.json() as Promise<TrainingItem>;
}

export async function deleteUnreviewedTrainingItem(id: number): Promise<void> {
  const response = await fetch(`${API_BASE}/training-items/${id}`, { method: "DELETE" });
  if (!response.ok) throw new Error(`Removing unfinished training card failed (${response.status})`);
}

export type RiichiCheck = { tenpai: boolean; can_riichi: boolean; waits: { tile: string; remaining: number }[]; ukeire: number };
export async function checkRiichiDiscard(state: GameState, discard: string): Promise<RiichiCheck> {
  const response = await fetch(`${API_BASE}/analysis/riichi-check`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ state, discard }),
  });
  if (!response.ok) throw new Error(`Riichi check failed (${response.status})`);
  return response.json() as Promise<RiichiCheck>;
}

export async function previewTrainingItem(input: TrainingItemInput, at?: string): Promise<Record<number, string>> {
  const query = at ? `?at=${encodeURIComponent(at)}` : "";
  const response = await fetch(`${API_BASE}/training-items/preview${query}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error(`Rating intervals failed (${response.status})`);
  const value = await response.json() as { due_at: Record<string, string> };
  return Object.fromEntries(Object.entries(value.due_at).map(([rating, due]) => [Number(rating), due]));
}

export async function fetchDueTrainingItems(at?: string): Promise<TrainingItem[]> {
  const query = at ? `?at=${encodeURIComponent(at)}` : "";
  const response = await fetch(`${API_BASE}/training-items/due${query}`);
  if (!response.ok) throw new Error(`Due items failed (${response.status})`);
  return response.json() as Promise<TrainingItem[]>;
}

export async function fetchTrainingSourceDecisions(sourceGameId: string): Promise<ReconstructedDecision[]> {
  const response = await fetch(`${API_BASE}/training-sources/${encodeURIComponent(sourceGameId)}/decisions`);
  if (!response.ok) {
    let detail = `Source game lookup failed (${response.status})`;
    try {
      const body = await response.json() as { detail?: string };
      if (body.detail) detail = body.detail;
    } catch { /* Keep the status-based message when the response is not JSON. */ }
    throw new Error(detail);
  }
  const value = await response.json() as { decisions: ReconstructedDecision[] };
  return value.decisions;
}

export type TrainingSource = {
  source_game_id: string;
  source_filename: string;
  imported_at: string | null;
  decision_count: number;
};

export async function fetchTrainingSources(): Promise<TrainingSource[]> {
  const response = await fetch(`${API_BASE}/training-sources`);
  if (!response.ok) throw new Error(`Saved matches failed (${response.status})`);
  return response.json() as Promise<TrainingSource[]>;
}

export async function importTrainingReport(file: File): Promise<ReviewResponse> {
  const body = new FormData();
  body.append("file", file);
  const response = await fetch(`${API_BASE}/reports/review`, { method: "POST", body });
  if (!response.ok) {
    let message = `Import failed (${response.status})`;
    try {
      const value = await response.json() as { detail?: string };
      if (value.detail) message = value.detail;
    } catch { /* Keep the status-based message for non-JSON responses. */ }
    throw new Error(message);
  }
  return response.json() as Promise<ReviewResponse>;
}

export async function fetchTrainingItems(sourceGameId: string): Promise<TrainingItem[]> {
  const response = await fetch(`${API_BASE}/training-items?source_game_id=${encodeURIComponent(sourceGameId)}`);
  if (!response.ok) throw new Error(`Training progress failed (${response.status})`);
  return response.json() as Promise<TrainingItem[]>;
}

export async function fetchTrainingItemReviews(id: number): Promise<ReviewLog[]> {
  const response = await fetch(`${API_BASE}/training-items/${id}/reviews`);
  if (!response.ok) throw new Error(`Review history failed (${response.status})`);
  return response.json() as Promise<ReviewLog[]>;
}
