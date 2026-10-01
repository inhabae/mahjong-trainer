import { useEffect, useRef, useState } from "react";
import { createTrainingItem, previewTrainingItem, reviewTrainingItem } from "../api/client";
import type { MemoryRating, TrainingItem, TrainingItemInput, TrainingReviewInput } from "../types/training";

const ratings: { rating: MemoryRating; label: string; description: string }[] = [
  { rating: 1, label: "Again", description: "Failed to recall" },
  { rating: 2, label: "Hard", description: "Recalled, with difficulty" },
  { rating: 3, label: "Good", description: "Normal successful recall" },
  { rating: 4, label: "Easy", description: "Very easy recall" },
];

function formatInterval(dueAt: string): string {
  const minutes = Math.max(1, Math.round((new Date(dueAt).getTime() - Date.now()) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.ceil(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.max(1, Math.round(hours / 24))}d`;
}

export function MemoryRatingControls({ item, review, onRated, reviewedAt }: {
  item: TrainingItemInput;
  review: Omit<TrainingReviewInput, "rating">;
  onRated: (saved: TrainingItem) => void;
  reviewedAt?: string;
}) {
  const pending = useRef(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<TrainingItem | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<Record<number, string> | null>(null);
  const [previewError, setPreviewError] = useState(false);
  const rateRef = useRef(rate);
  rateRef.current = rate;

  useEffect(() => {
    let active = true;
    previewTrainingItem(item, reviewedAt).then((value) => { if (active) setPreview(value); })
      .catch(() => { if (active) setPreviewError(true); });
    return () => { active = false; };
  }, [item.source_game_id, item.decision_id, item.category, item.severity, reviewedAt]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return;
      const rating = ratings.find(({ rating }) => String(rating) === event.key)?.rating;
      if (!rating) return;
      event.preventDefault();
      void rateRef.current(rating);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  async function rate(rating: MemoryRating) {
    if (pending.current || saved) return;
    pending.current = true;
    setSaving(true);
    setError(null);
    try {
      const card = await createTrainingItem(item);
      const savedItem = await reviewTrainingItem(card.id, { ...review, rating }, reviewedAt);
      setSaved(savedItem);
      onRated(savedItem);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save memory rating");
    } finally {
      pending.current = false;
      setSaving(false);
    }
  }

  return <section className="memory-rating" aria-label="Memory rating">
    <div className="memory-rating-buttons">{ratings.map(({ rating, label, description }) =>
      <button key={rating} title={`${description} · shortcut ${rating}`} disabled={saving || saved !== null}
        aria-pressed={saved?.last_rating === rating} onClick={() => void rate(rating)}>
        <span className="memory-rating-interval">{saved?.last_rating === rating ? formatInterval(saved.due_at) : preview ? formatInterval(preview[rating]) : previewError ? "—" : "…"}</span>
        <span>{label}</span>
      </button>
    )}</div>
    {saving && <div role="status">Saving rating…</div>}
    {saved && <div role="status">Next review scheduled for {new Date(saved.due_at).toLocaleString()}</div>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
