import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { pool, queryUnscoped } from "@email-app/db";
import { signAuthToken } from "../lib/jwt";
import { requireAuth } from "../middleware/auth";

export const authRouter = Router();

const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: "none" as const,
  secure: true,
  maxAge: 7 * 24 * 60 * 60 * 1000,
};const signupSchema = z.object({
  accountName: z.string().min(1).max(200),
  email: z.string().email(),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

authRouter.post("/signup", async (req, res, next) => {
  try {
    const parsed = signupSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0].message });
    }
    const { accountName, email, password } = parsed.data;

    const existing = await queryUnscoped("SELECT id FROM users WHERE email = $1", [email]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: "An account with that email already exists" });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const accountResult = await client.query(
        "INSERT INTO accounts (name) VALUES ($1) RETURNING id, name",
        [accountName]
      );
      const account = accountResult.rows[0];
      const userResult = await client.query(
        "INSERT INTO users (account_id, email, password_hash) VALUES ($1, $2, $3) RETURNING id, email",
        [account.id, email, passwordHash]
      );
      const user = userResult.rows[0];
      await client.query("COMMIT");

      const token = signAuthToken({ userId: user.id, accountId: account.id });
      res.cookie("auth_token", token, COOKIE_OPTS);
      res.status(201).json({ user: { id: user.id, email: user.email }, account });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    next(err);
  }
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

authRouter.post("/login", async (req, res, next) => {
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Email and password are required" });
    }
    const { email, password } = parsed.data;

    const result = await queryUnscoped<{
      id: string;
      account_id: string;
      email: string;
      password_hash: string;
    }>("SELECT id, account_id, email, password_hash FROM users WHERE email = $1", [email]);

    const user = result.rows[0];
    // Same generic error whether the email doesn't exist or the password
    // is wrong, so we don't leak which accounts have signed up.
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const token = signAuthToken({ userId: user.id, accountId: user.account_id });
    res.cookie("auth_token", token, COOKIE_OPTS);
    res.json({ user: { id: user.id, email: user.email } });
  } catch (err) {
    next(err);
  }
});

authRouter.post("/logout", (_req, res) => {
  res.clearCookie("auth_token");
  res.status(204).send();
});

authRouter.get("/me", requireAuth, async (req, res, next) => {
  try {
    const result = await queryUnscoped<{ id: string; email: string; account_id: string }>(
      "SELECT id, email, account_id FROM users WHERE id = $1",
      [req.auth!.userId]
    );
    if (result.rows.length === 0) return res.status(401).json({ error: "Not authenticated" });
    const user = result.rows[0];
    res.json({ id: user.id, email: user.email, accountId: user.account_id });
  } catch (err) {
    next(err);
  }
});
