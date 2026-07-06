import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";

const router: IRouter = Router();

const startedAt = Date.now();

router.get("/healthz", async (_req, res) => {
  let db: "ok" | "error" = "ok";
  try {
    const client = await pool.connect();
    try {
      await client.query("SELECT 1");
    } finally {
      client.release();
    }
  } catch {
    db = "error";
  }

  res.json({
    status: "ok",
    db,
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    ts: new Date().toISOString(),
  });
});

export default router;
