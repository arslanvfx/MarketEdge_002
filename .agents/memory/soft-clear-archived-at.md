---
name: Soft-clear archivedAt pattern
description: Why soft-clear must UPDATE archivedAt instead of DELETE, and which functions filter it
---

## The rule
`predictionRecordsTable` is the single source of truth for BOTH the display log (getPredictionHeadlines) AND analytics (getTradingWindows, getPredictionAnalytics). Deleting rows for soft-clear breaks both analytics surfaces.

**Why:** A code-review rejection caught this: the original soft-clear issued `DELETE WHERE snappedAt < cutoff`, which wiped the rows that Best Windows and auto-pilot accuracy stats read from.

**How to apply:**
- Soft-clear: `UPDATE prediction_records SET archived_at = NOW() WHERE snapped_at < cutoff`
- Filter archived records ONLY in `getPredictionHeadlines()` (display layer). Do NOT filter in `getTradingWindows()` or `getPredictionAnalytics()` — archived rows still count for analytics.
- `initHistoryFromDB()` loads ALL records (including archived) into `historyStore` so analytics remain complete after a restart.
- Schema: `archivedAt` is `TIMESTAMPTZ` nullable; Drizzle column name `archivedAt`; DB column `archived_at`. Added via `ALTER TABLE prediction_records ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ`.
- Full reset (`clearPredictionHistory`) correctly deletes everything — that's intentional.
