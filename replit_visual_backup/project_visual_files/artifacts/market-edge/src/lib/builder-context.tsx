import { createContext, useContext, useState, ReactNode } from "react";
import { Market } from "@workspace/api-client-react";

export type BuilderLeg = {
  market: Market;
  position: "yes" | "no";
};

type BuilderContextType = {
  selectedLegs: BuilderLeg[];
  addLeg: (market: Market, position: "yes" | "no") => void;
  removeLeg: (marketId: string) => void;
  updateLegPosition: (marketId: string, position: "yes" | "no") => void;
  clearLegs: () => void;
};

const BuilderContext = createContext<BuilderContextType | undefined>(undefined);

export function BuilderProvider({ children }: { children: ReactNode }) {
  const [selectedLegs, setSelectedLegs] = useState<BuilderLeg[]>([]);

  const addLeg = (market: Market, position: "yes" | "no") => {
    setSelectedLegs((prev) => {
      if (prev.some((leg) => leg.market.id === market.id)) return prev;
      return [...prev, { market, position }];
    });
  };

  const removeLeg = (marketId: string) => {
    setSelectedLegs((prev) => prev.filter((leg) => leg.market.id !== marketId));
  };

  const updateLegPosition = (marketId: string, position: "yes" | "no") => {
    setSelectedLegs((prev) =>
      prev.map((leg) =>
        leg.market.id === marketId ? { ...leg, position } : leg
      )
    );
  };

  const clearLegs = () => setSelectedLegs([]);

  return (
    <BuilderContext.Provider value={{ selectedLegs, addLeg, removeLeg, updateLegPosition, clearLegs }}>
      {children}
    </BuilderContext.Provider>
  );
}

export function useBuilder() {
  const context = useContext(BuilderContext);
  if (context === undefined) {
    throw new Error("useBuilder must be used within a BuilderProvider");
  }
  return context;
}
