export type ScalperLayerSide = "yes" | "no";

export interface RegularPositionForScalperLayering {
  id: string;
  symbol: string;
  windowKey: string;
  ticker: string;
  direction: ScalperLayerSide;
  entryMode: "paper" | "live";
}

export type RegularPositionCompatibility =
  | { status: "none"; position: null }
  | { status: "same_side"; position: RegularPositionForScalperLayering }
  | { status: "opposite_side"; position: RegularPositionForScalperLayering };

export function evaluateRegularPositionCompatibility(
  position: RegularPositionForScalperLayering | null | undefined,
  request: {
    mode: "paper" | "live";
    symbol: string;
    windowKey: string;
    ticker: string;
    side: ScalperLayerSide;
  },
): RegularPositionCompatibility {
  if (
    !position
    || position.entryMode !== request.mode
    || position.symbol.toUpperCase() !== request.symbol.toUpperCase()
    || position.windowKey !== request.windowKey
    || position.ticker !== request.ticker
  ) {
    return { status: "none", position: null };
  }

  return position.direction === request.side
    ? { status: "same_side", position }
    : { status: "opposite_side", position };
}