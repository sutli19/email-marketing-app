import jwt, { JwtPayload } from "jsonwebtoken";

export interface AuthTokenPayload {
  userId: string;
  accountId: string;
}

const SECRET: string = (() => {
  const secret = process.env.JWT_SECRET;

  if (!secret) {
    throw new Error("JWT_SECRET is not set");
  }

  return secret;
})();

export function signAuthToken(payload: AuthTokenPayload): string {
  return jwt.sign(payload, SECRET, { expiresIn: "7d" });
}

export function verifyAuthToken(token: string): AuthTokenPayload {
  const payload = jwt.verify(token, SECRET);

  if (typeof payload === "string") {
    throw new Error("Invalid token payload");
  }

  return payload as JwtPayload as AuthTokenPayload;
}