import { Router, type IRouter } from "express";
import healthRouter from "./health";
import marketsRouter from "./markets";
import combosRouter from "./combos";
import alertsRouter from "./alerts";
import cryptoRouter from "./crypto";

const router: IRouter = Router();

router.use(healthRouter);
router.use(marketsRouter);
router.use(combosRouter);
router.use(alertsRouter);
router.use(cryptoRouter);

export default router;
