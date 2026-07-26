import "dotenv/config";
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import { authRouter } from "./routes/auth";
import { contactsRouter } from "./routes/contacts";
import { tagsRouter } from "./routes/tags";
import { audiencesRouter } from "./routes/audiences";
import { campaignsRouter } from "./routes/campaigns";
import { webhooksRouter } from "./routes/webhook";
import { errorHandler } from "./middleware/errorHandler";

export function createApp() {
  const app = express();

  app.use(
    cors({
      origin: process.env.FRONTEND_URL || "http://localhost:3000",
      credentials: true,
    })
  );
  app.use(cookieParser());
  app.use(express.json());

  app.get("/health", (_req, res) => res.json({ ok: true }));

  app.use("/api/auth", authRouter);
  app.use("/api/contacts", contactsRouter);
  app.use("/api/tags", tagsRouter);
  app.use("/api/audiences", audiencesRouter);
  app.use("/api/campaigns", campaignsRouter);
  // Unauthenticated on purpose — brevo can't carry a JWT/cookie.
  // webhooksRouter does not call requireAuth; trust comes from HMAC
  // signature verification inside the route instead.
  app.use("/api/webhooks", webhooksRouter);

  app.use(errorHandler);

  return app;
}