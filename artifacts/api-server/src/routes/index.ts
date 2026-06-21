import { Router, type IRouter } from "express";
import healthRouter from "./health";
import marketsRouter from "./markets";
import combosRouter from "./combos";

const router: IRouter = Router();

router.use(healthRouter);
router.use(marketsRouter);
router.use(combosRouter);

export default router;
