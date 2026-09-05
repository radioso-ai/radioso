import type { RequestHandler } from "express";

import { HttpError } from "../shared/httpError.js";
import { StaffAuthService } from "./staffAuthService.js";
import type { StaffRole } from "./staffTypes.js";

export interface StaffPrincipal {
  id: string;
  role: StaffRole;
  email: string;
  name: string;
}

const roleRank: Record<StaffRole, number> = {
  support_read: 1,
  billing_write: 2,
  owner: 3,
};

export const canSatisfyStaffRole = (actual: StaffRole, minimum: StaffRole): boolean =>
  roleRank[actual] >= roleRank[minimum];

export const requireStaffSession = (
  authService: StaffAuthService,
  cookieName: string,
): RequestHandler => async (req, res, next) => {
  try {
    const sessionToken = req.cookies?.[cookieName];
    if (typeof sessionToken !== "string" || sessionToken.length === 0) {
      throw new HttpError(401, "unauthorized", "Unauthorized");
    }
    const { staff } = await authService.authenticateStaffSession(sessionToken);
    res.locals.staff = {
      id: staff.id,
      role: staff.role,
      email: staff.email,
      name: staff.name,
    } satisfies StaffPrincipal;
    next();
  } catch (error) {
    next(error);
  }
};

export const requireStaffRole = (minimumRole: StaffRole): RequestHandler => (req, res, next) => {
  const staff = res.locals.staff as StaffPrincipal | undefined;
  if (!staff || !canSatisfyStaffRole(staff.role, minimumRole)) {
    res.status(403).json({
      error: {
        code: "forbidden",
        message: "Forbidden",
      },
    });
    return;
  }
  next();
};
