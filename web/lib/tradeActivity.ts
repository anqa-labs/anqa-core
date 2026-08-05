export type TradeSubmission = {
  id: number;
  marketId: number;
  symbol: string;
  base: string;
  side: "long" | "short";
  size: number;
  notionalUsd: number;
  collateralUsd: number;
  submittedAt: number;
};
