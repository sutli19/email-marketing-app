import { AuthTokenPayload } from "../lib/jwt";

declare global {
  namespace Express {
    interface Request {
      auth?: AuthTokenPayload;
    }
  }
}

export {};
