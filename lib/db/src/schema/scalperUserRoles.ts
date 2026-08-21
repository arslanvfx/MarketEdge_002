import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * App-owned Scalper roles keyed to the authenticated Clerk user.
 *
 * `bootstrapAdmin` is true only for the first administrator. The partial unique
 * index makes the initial claim atomic: concurrent callers cannot both become
 * the bootstrap administrator.
 */
export const scalperUserRolesTable = pgTable(
  "scalper_user_roles",
  {
    clerkUserId: text("clerk_user_id").notNull(),
    role: text("role").notNull(),
    bootstrapAdmin: boolean("bootstrap_admin").notNull().default(false),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.clerkUserId, table.role] }),
    check("scalper_user_roles_role_check", sql`${table.role} = 'admin'`),
    uniqueIndex("scalper_user_roles_one_bootstrap_admin")
      .on(table.bootstrapAdmin)
      .where(sql`${table.bootstrapAdmin} = true`),
  ],
);

export const insertScalperUserRoleSchema = createInsertSchema(
  scalperUserRolesTable,
).omit({ createdAt: true });

export type InsertScalperUserRole = z.infer<typeof insertScalperUserRoleSchema>;
export type ScalperUserRole = typeof scalperUserRolesTable.$inferSelect;