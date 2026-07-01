// The scannable stock universe, grouped by sector. These are liquid, large-cap
// names with reliable data and news coverage — ideal for an automated bot.
// The scanner ranks across this set; the user's watchlist is merged on top.

export interface UniverseEntry {
  ticker: string;
  name: string;
  sector: string;
}

export const SECTORS = [
  "Technology",
  "Energy",
  "Healthcare",
  "Finance",
  "Consumer",
] as const;

export type Sector = (typeof SECTORS)[number];

export const STOCK_UNIVERSE: UniverseEntry[] = [
  // Technology
  { ticker: "AAPL", name: "Apple", sector: "Technology" },
  { ticker: "MSFT", name: "Microsoft", sector: "Technology" },
  { ticker: "NVDA", name: "NVIDIA", sector: "Technology" },
  { ticker: "GOOGL", name: "Alphabet", sector: "Technology" },
  { ticker: "META", name: "Meta Platforms", sector: "Technology" },
  { ticker: "AMZN", name: "Amazon", sector: "Technology" },
  { ticker: "TSLA", name: "Tesla", sector: "Technology" },
  { ticker: "AMD", name: "Advanced Micro Devices", sector: "Technology" },
  { ticker: "AVGO", name: "Broadcom", sector: "Technology" },
  { ticker: "CRM", name: "Salesforce", sector: "Technology" },
  { ticker: "ADBE", name: "Adobe", sector: "Technology" },
  { ticker: "ORCL", name: "Oracle", sector: "Technology" },
  { ticker: "QCOM", name: "Qualcomm", sector: "Technology" },
  { ticker: "CSCO", name: "Cisco", sector: "Technology" },

  // Energy
  { ticker: "XOM", name: "Exxon Mobil", sector: "Energy" },
  { ticker: "CVX", name: "Chevron", sector: "Energy" },
  { ticker: "COP", name: "ConocoPhillips", sector: "Energy" },
  { ticker: "SLB", name: "Schlumberger", sector: "Energy" },
  { ticker: "EOG", name: "EOG Resources", sector: "Energy" },
  { ticker: "MPC", name: "Marathon Petroleum", sector: "Energy" },
  { ticker: "PSX", name: "Phillips 66", sector: "Energy" },
  { ticker: "OXY", name: "Occidental Petroleum", sector: "Energy" },
  { ticker: "VLO", name: "Valero Energy", sector: "Energy" },
  { ticker: "WMB", name: "Williams Companies", sector: "Energy" },

  // Healthcare
  { ticker: "UNH", name: "UnitedHealth", sector: "Healthcare" },
  { ticker: "JNJ", name: "Johnson & Johnson", sector: "Healthcare" },
  { ticker: "LLY", name: "Eli Lilly", sector: "Healthcare" },
  { ticker: "PFE", name: "Pfizer", sector: "Healthcare" },
  { ticker: "MRK", name: "Merck", sector: "Healthcare" },
  { ticker: "ABBV", name: "AbbVie", sector: "Healthcare" },
  { ticker: "TMO", name: "Thermo Fisher", sector: "Healthcare" },
  { ticker: "ABT", name: "Abbott", sector: "Healthcare" },
  { ticker: "DHR", name: "Danaher", sector: "Healthcare" },
  { ticker: "BMY", name: "Bristol Myers Squibb", sector: "Healthcare" },
  { ticker: "AMGN", name: "Amgen", sector: "Healthcare" },
  { ticker: "GILD", name: "Gilead Sciences", sector: "Healthcare" },

  // Finance
  { ticker: "JPM", name: "JPMorgan Chase", sector: "Finance" },
  { ticker: "BAC", name: "Bank of America", sector: "Finance" },
  { ticker: "WFC", name: "Wells Fargo", sector: "Finance" },
  { ticker: "GS", name: "Goldman Sachs", sector: "Finance" },
  { ticker: "MS", name: "Morgan Stanley", sector: "Finance" },
  { ticker: "C", name: "Citigroup", sector: "Finance" },
  { ticker: "BLK", name: "BlackRock", sector: "Finance" },
  { ticker: "SCHW", name: "Charles Schwab", sector: "Finance" },
  { ticker: "AXP", name: "American Express", sector: "Finance" },
  { ticker: "SPGI", name: "S&P Global", sector: "Finance" },

  // Consumer
  { ticker: "WMT", name: "Walmart", sector: "Consumer" },
  { ticker: "COST", name: "Costco", sector: "Consumer" },
  { ticker: "HD", name: "Home Depot", sector: "Consumer" },
  { ticker: "MCD", name: "McDonald's", sector: "Consumer" },
  { ticker: "NKE", name: "Nike", sector: "Consumer" },
  { ticker: "SBUX", name: "Starbucks", sector: "Consumer" },
  { ticker: "TGT", name: "Target", sector: "Consumer" },
  { ticker: "LOW", name: "Lowe's", sector: "Consumer" },
  { ticker: "PG", name: "Procter & Gamble", sector: "Consumer" },
  { ticker: "KO", name: "Coca-Cola", sector: "Consumer" },
  { ticker: "PEP", name: "PepsiCo", sector: "Consumer" },
  { ticker: "DIS", name: "Walt Disney", sector: "Consumer" },
];

const BY_TICKER = new Map(STOCK_UNIVERSE.map((e) => [e.ticker, e]));

export function lookupUniverse(ticker: string): UniverseEntry | undefined {
  return BY_TICKER.get(ticker.toUpperCase());
}

export function universeTickers(): string[] {
  return STOCK_UNIVERSE.map((e) => e.ticker);
}
