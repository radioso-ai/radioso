import {
  generateStaffSessionToken,
  hashStaffSessionToken,
  verifyStaffPassword,
} from "./staffCrypto.js";
import type { StaffSessionRepository } from "./staffSessionRepository.js";
import type { StaffUserRepository } from "./staffRepository.js";
import type { StaffUser } from "./staffTypes.js";
import { HttpError } from "../shared/httpError.js";

const DEFAULT_STAFF_SESSION_TTL_HOURS = 8;

export interface StaffAuthResult {
  staff: StaffUser;
  sessionToken: string;
  expiresAt: Date;
}

export class StaffAuthService {
  constructor(
    private readonly users: StaffUserRepository,
    private readonly sessions: StaffSessionRepository,
    private readonly config: { ttlHours?: number } = {},
  ) {}

  async login(input: { email: string; password: string }): Promise<StaffAuthResult> {
    const staff = await this.users.findByEmail(input.email);
    if (!staff || !(await verifyStaffPassword(input.password, staff.passwordHash))) {
      throw new HttpError(401, "unauthorized", "Unauthorized");
    }
    if (staff.status !== "active") {
      throw new HttpError(403, "forbidden", "Staff user is disabled.");
    }

    const sessionToken = generateStaffSessionToken();
    const expiresAt = new Date(Date.now() + this.resolveTtlHours() * 60 * 60 * 1000);
    await this.sessions.create({
      staffId: staff.id,
      sessionTokenHash: hashStaffSessionToken(sessionToken),
      expiresAt,
    });
    await this.users.touchLastLogin(staff.id);

    return { staff, sessionToken, expiresAt };
  }

  async authenticateStaffSession(sessionToken: string): Promise<{ staff: StaffUser }> {
    const tokenHash = hashStaffSessionToken(sessionToken);
    const session = await this.sessions.findActiveByTokenHash(tokenHash);
    if (!session) {
      throw new HttpError(401, "unauthorized", "Unauthorized");
    }

    const staff = await this.users.findById(session.staffId);
    if (!staff || staff.status !== "active") {
      throw new HttpError(401, "unauthorized", "Unauthorized");
    }

    await this.sessions.touch(tokenHash);
    return { staff };
  }

  async revoke(sessionToken: string): Promise<void> {
    await this.sessions.revoke(hashStaffSessionToken(sessionToken));
  }

  private resolveTtlHours(): number {
    const ttl = this.config.ttlHours ?? DEFAULT_STAFF_SESSION_TTL_HOURS;
    return Number.isFinite(ttl) && ttl > 0 ? ttl : DEFAULT_STAFF_SESSION_TTL_HOURS;
  }
}

export const defaultStaffSessionTtlHours = DEFAULT_STAFF_SESSION_TTL_HOURS;
