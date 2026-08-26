import { Router, type IRouter } from "express";
import healthRouter from "./health";
import marketsRouter from "./markets";
import combosRouter from "./combos";
import alertsRouter from "./alerts";
import cryptoRouter from "./crypto";
import kalshiBotRouter from "./kalshi-bot";
import stocksRouter from "./stocks";
import kalshiScalperRouter from "./kalshi-scalper";
import kalshiSmartExitRouter from "./kalshi-smart-exit";
import kalshiScalperSmartExitRouter from "./kalshi-scalper-smart-exit";

const router: IRouter = Router();

router.use(healthRouter);
router.use(marketsRouter);
router.use(combosRouter);
router.use(alertsRouter);
router.use(cryptoRouter);
router.use(kalshiBotRouter);
router.use(stocksRouter);
router.use(kalshiScalperRouter);
router.use(kalshiSmartExitRouter);
router.use(kalshiScalperSmartExitRouter);

export default router;
