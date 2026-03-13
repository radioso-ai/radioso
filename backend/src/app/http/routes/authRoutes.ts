import { Router } from "express";
import { z } from "zod";

import type { AppDependencies } from "../../server/types.js";
import { validateBody } from "../middleware/validate.js";

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export const createAuthRoutes = (dependencies: AppDependencies): Router => {
  const router = Router();

  router.post("/register", validateBody(registerSchema), async (req, res, next) => {
    try {
      const result = await dependencies.authService.register(req.body);
      res.setHeader("Set-Cookie", result.sessionCookie);
      res.status(201).json({ userId: result.userId });
    } catch (error) {
      next(error);
    }
  });

  router.post("/login", validateBody(loginSchema), async (req, res, next) => {
    try {
      const result = await dependencies.authService.login(req.body);
      res.setHeader("Set-Cookie", result.sessionCookie);
      res.status(200).json({ userId: result.userId });
    } catch (error) {
      next(error);
    }
  });

  return router;
};
