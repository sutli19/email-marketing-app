import { NextFunction, Request, Response } from "express";
import { verifyAuthToken } from "../lib/jwt";

/**
 * The account id used for every downstream query comes from here —
 * a verified, server-issued JWT — never from a request body, query
 * string, or header the client controls. This is what makes the
 * "someone logged into account A can't see account B's data" rule
 * actually hold: there is no code path where the account id is
 * client-supplied.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = req.cookies?.auth_token;
  if (!token) {
    return res.status(401).json({ error: "Not authenticated" });
  }
  try {
    req.auth = verifyAuthToken(token);
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired session" });
  }
}
