import { TrendingUp, TrendingDown, Minus } from "lucide-react";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Coins that have Kalshi 15-min markets (must match KALSHI_SERIES in the API).
export const KALSHI_COINS = ["BTC", "ETH", "SOL", "XRP", "HYPE", "BNB", "DOGE", "NEAR", "ZEC", "GOLD", "SILVER", "WTI"];

// Commodity symbols shown under the "Commodities" section of the market grid.
export const COMMODITY_SYMBOLS = ["GOLD", "SILVER", "WTI"];

export const COIN_STYLE: Record<string, { glyph: string; accent: string; ring: string; glow: string }> = {
  BTC:  { glyph: "₿", accent: "text-amber-400",   ring: "ring-amber-500/40 border-amber-500/40",   glow: "shadow-amber-500/20" },
  ETH:  { glyph: "Ξ", accent: "text-indigo-400",  ring: "ring-indigo-500/40 border-indigo-500/40",  glow: "shadow-indigo-500/20" },
  SOL:  { glyph: "◎", accent: "text-fuchsia-400", ring: "ring-fuchsia-500/40 border-fuchsia-500/40", glow: "shadow-fuchsia-500/20" },
  XRP:  { glyph: "✕", accent: "text-sky-400",     ring: "ring-sky-500/40 border-sky-500/40",        glow: "shadow-sky-500/20" },
  HYPE: { glyph: "H", accent: "text-emerald-400", ring: "ring-emerald-500/40 border-emerald-500/40", glow: "shadow-emerald-500/20" },
  BNB:  { glyph: "B", accent: "text-yellow-300",  ring: "ring-yellow-400/40 border-yellow-400/40",  glow: "shadow-yellow-400/20" },
  LINK: { glyph: "⬡", accent: "text-blue-400",    ring: "ring-blue-500/40 border-blue-500/40",      glow: "shadow-blue-500/20" },
  DOGE: { glyph: "Ð", accent: "text-yellow-400",  ring: "ring-yellow-500/40 border-yellow-500/40",  glow: "shadow-yellow-500/20" },
  NEAR: { glyph: "Ⓝ", accent: "text-green-400",   ring: "ring-green-500/40 border-green-500/40",    glow: "shadow-green-500/20" },
  ZEC:  { glyph: "ⓩ", accent: "text-orange-400",  ring: "ring-orange-500/40 border-orange-500/40",  glow: "shadow-orange-500/20" },
  GOLD:   { glyph: "◈", accent: "text-yellow-400",  ring: "ring-yellow-500/40 border-yellow-500/40",  glow: "shadow-yellow-500/20" },
  SILVER: { glyph: "◇", accent: "text-slate-300",   ring: "ring-slate-400/40 border-slate-400/40",    glow: "shadow-slate-400/20" },
  WTI:    { glyph: "◉", accent: "text-stone-400",   ring: "ring-stone-500/40 border-stone-500/40",    glow: "shadow-stone-500/20" },
};

export function formatPrice(p: number): string {
  if (!isFinite(p)) return "—";
  if (p >= 1000) return p.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (p >= 1) return p.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
  return p.toLocaleString("en-US", { minimumFractionDigits: 4, maximumFractionDigits: 6 });
}

export function formatPct(p: number): string {
  return `${p >= 0 ? "+" : ""}${p.toFixed(2)}%`;
}

export function estClock(d: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  }).format(d);
}

// True Eastern abbreviation for the given moment ("EST" in winter, "EDT" in summer).
export function etAbbrev(d: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    timeZoneName: "short",
  }).formatToParts(d);
  return parts.find((p) => p.type === "timeZoneName")?.value ?? "ET";
}

export function estCandleLabel(t: number): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(t * 1000));
}

export const API_BASE = `${import.meta.env.BASE_URL}api`.replace(/\/\/api$/, "/api");

export async function fetchJson<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) throw new Error(`Request failed: ${res.status}`);
  return res.json();
}

export const DIR = {
  up:   { icon: TrendingUp,   color: "text-emerald-400", bg: "bg-emerald-500/10", border: "border-emerald-500/30", stroke: "#34d399" },
  down: { icon: TrendingDown, color: "text-red-400",     bg: "bg-red-500/10",     border: "border-red-500/30",     stroke: "#f87171" },
  flat: { icon: Minus,        color: "text-slate-400",   bg: "bg-slate-500/10",   border: "border-slate-500/30",   stroke: "#94a3b8" },
};
