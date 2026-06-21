---
name: sideLabel prop NO side
description: How NO-side labels are generated for prop market subtitles in optimizer.ts
---
# sideLabel prop NO side

## The rule
In `sideLabel()`, the NO-side branch (after computing yesText) first checks for Over/Under to flip them naturally, then falls back to "Not <sub>":

```
if (/^over\s+/i.test(sub)) return sub.replace(/^over\s+/i, "Under ");
if (/^under\s+/i.test(sub)) return sub.replace(/^under\s+/i, "Over ");
if (isMatch && !isTie && !isProp) return `Not ${sub} to win`;
return `Not ${sub}`;
```

**Why:** "Not Over 2.5 goals" reads awkwardly; "Under 2.5 goals" is the natural label for the NO side of a totals market. Winner NO sides get "to win" appended for clarity.
