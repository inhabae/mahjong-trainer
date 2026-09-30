import type { HealthResponse } from "../types/health";

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8000/api";

export async function fetchHealth(): Promise<HealthResponse> {
  const response = await fetch(`${API_BASE}/health`);
  if (!response.ok) throw new Error(`Health check failed (${response.status})`);
  return response.json() as Promise<HealthResponse>;
}

export async function fetchDefaultReview(): Promise<any> {
  const response = await fetch(`${API_BASE}/reports/default`);
  if (!response.ok) throw new Error(`Default report failed (${response.status})`);
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    throw new Error("The frontend server returned HTML for /api/reports/default. Start the FastAPI backend on port 8000 and use the Vite dev server on port 5173 (which proxies /api).");
  }
  return response.json();
}

export async function fetchDefaultReplay(): Promise<any> {
  const response = await fetch(`${API_BASE}/reports/default/replay`);
  if (!response.ok) throw new Error(`Default replay failed (${response.status})`);
  return response.json();
}
