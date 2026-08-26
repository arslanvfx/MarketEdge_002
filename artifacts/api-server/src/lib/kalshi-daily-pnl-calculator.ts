export interface PnlSimulationInputRow {
  strategy: "regular" | "scalper";
  actualCost: number | null;
  contractCount: number | null;
  pnl: number | null;
  resolved: boolean;
}

export interface PnlSimulationBreakdown {
  hypotheticalStakePerBet: number;
  includedCount: number;
  excludedCount: number;
  unresolvedCount: number;
  actualStake: number;
  actualPnl: number;
  actualRoiPct: number | null;
  hypotheticalStake: number;
  hypotheticalPnl: number;
  hypotheticalRoiPct: number | null;
  deltaPnl: number;
  deltaPct: number | null;
}

export interface PnlSimulationResult {
  regular: PnlSimulationBreakdown;
  scalper: PnlSimulationBreakdown;
  totals: Omit<PnlSimulationBreakdown, "hypotheticalStakePerBet">;
}

export function finitePnlNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function percentChange(actual: number, hypothetical: number): number | null {
  if (actual === 0) return null;
  return ((hypothetical - actual) / Math.abs(actual)) * 100;
}

const CONTRACT_MONEY_SCALE = 100_000_000;

export function wholeContractsForStake(stake: number, costPerContract: number): number {
  const stakeUnits = Math.round(stake * CONTRACT_MONEY_SCALE);
  const costUnits = Math.round(costPerContract * CONTRACT_MONEY_SCALE);
  if (stakeUnits <= 0 || costUnits <= 0) return 0;
  return Math.floor(stakeUnits / costUnits);
}

export function calculatePnlSimulation(
  rows: PnlSimulationInputRow[],
  regularStake: number,
  scalperStake: number,
): PnlSimulationResult {
  const calculateStrategy = (
    strategy: PnlSimulationInputRow["strategy"],
    hypotheticalStakePerBet: number,
  ): PnlSimulationBreakdown => {
    let includedCount = 0;
    let excludedCount = 0;
    let unresolvedCount = 0;
    let actualStake = 0;
    let actualPnl = 0;
    let hypotheticalStake = 0;
    let hypotheticalPnl = 0;

    for (const row of rows) {
      if (row.strategy !== strategy) continue;
      if (!row.resolved) {
        unresolvedCount += 1;
        excludedCount += 1;
        continue;
      }
      const cost = finitePnlNumber(row.actualCost);
      const contractCount = finitePnlNumber(row.contractCount);
      const pnl = finitePnlNumber(row.pnl);
      if (cost == null || cost <= 0 || contractCount == null || contractCount <= 0 || pnl == null) {
        excludedCount += 1;
        continue;
      }
      const costPerContract = cost / contractCount;
      const hypotheticalContracts = wholeContractsForStake(hypotheticalStakePerBet, costPerContract);
      includedCount += 1;
      actualStake += cost;
      actualPnl += pnl;
      hypotheticalStake += hypotheticalContracts * costPerContract;
      hypotheticalPnl += (pnl / contractCount) * hypotheticalContracts;
    }

    return {
      hypotheticalStakePerBet,
      includedCount,
      excludedCount,
      unresolvedCount,
      actualStake,
      actualPnl,
      actualRoiPct: actualStake > 0 ? (actualPnl / actualStake) * 100 : null,
      hypotheticalStake,
      hypotheticalPnl,
      hypotheticalRoiPct: hypotheticalStake > 0 ? (hypotheticalPnl / hypotheticalStake) * 100 : null,
      deltaPnl: hypotheticalPnl - actualPnl,
      deltaPct: percentChange(actualPnl, hypotheticalPnl),
    };
  };

  const regular = calculateStrategy("regular", regularStake);
  const scalper = calculateStrategy("scalper", scalperStake);
  const actualStake = regular.actualStake + scalper.actualStake;
  const actualPnl = regular.actualPnl + scalper.actualPnl;
  const hypotheticalStake = regular.hypotheticalStake + scalper.hypotheticalStake;
  const hypotheticalPnl = regular.hypotheticalPnl + scalper.hypotheticalPnl;

  return {
    regular,
    scalper,
    totals: {
      includedCount: regular.includedCount + scalper.includedCount,
      excludedCount: regular.excludedCount + scalper.excludedCount,
      unresolvedCount: regular.unresolvedCount + scalper.unresolvedCount,
      actualStake,
      actualPnl,
      actualRoiPct: actualStake > 0 ? (actualPnl / actualStake) * 100 : null,
      hypotheticalStake,
      hypotheticalPnl,
      hypotheticalRoiPct: hypotheticalStake > 0 ? (hypotheticalPnl / hypotheticalStake) * 100 : null,
      deltaPnl: hypotheticalPnl - actualPnl,
      deltaPct: percentChange(actualPnl, hypotheticalPnl),
    },
  };
}