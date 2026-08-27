export function calculateKalshiSettlementPnl(input: {
  direction: "yes" | "no";
  entryYesPrice: number;
  contractCount: number;
  won: boolean;
}): number {
  const { direction, entryYesPrice, contractCount, won } = input;
  if (!Number.isFinite(entryYesPrice) || entryYesPrice < 0 || entryYesPrice > 1) {
    throw new RangeError("entryYesPrice must be between 0 and 1");
  }
  if (!Number.isFinite(contractCount) || contractCount < 0) {
    throw new RangeError("contractCount must be non-negative");
  }

  const winningContractCost = direction === "yes"
    ? entryYesPrice
    : 1 - entryYesPrice;
  return won
    ? (1 - winningContractCost) * contractCount
    : -winningContractCost * contractCount;
}