import jwt from "jsonwebtoken";

export interface AuthTokenPayload {
  userId: string;
  accountId: string;
}

const SECRET = process.env.JWT_SECRET;
if (!SECRET) {
  throw new Error("JWT_SECRET is not set");
}

export function signAuthToken(payload: AuthTokenPayload): string {
  return jwt.sign(payload, SECRET, { expiresIn: "7d" });
}

export function verifyAuthToken(token: string): AuthTokenPayload {
  return jwt.verify(token, SECRET) as AuthTokenPayload;
}
