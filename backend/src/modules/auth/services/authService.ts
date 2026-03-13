import type { Env } from "../../../app/config/env.js";
import { conflict, unauthorized } from "../../../shared/domain/errors.js";
import type { AuditService } from "../../audit/services/auditService.js";
import {
  decryptSecret,
  encryptSecret,
  generateApiToken,
  generateSessionToken,
  hashPassword,
  normalizeEmail,
  serializeSessionCookie,
  sha256,
  tokenPrefix,
  verifyPassword,
} from "../domain/authPrimitives.js";

export interface AccountRecord {
  id: string;
  email: string;
  passwordHash: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface SessionRecord {
  id: string;
  accountId: string;
  sessionTokenHash: string;
  createdAt: Date;
  expiresAt: Date;
  lastSeenAt: Date;
  revokedAt: Date | null;
}

export interface AccountTokenRecord {
  accountId: string;
  tokenPrefix: string;
  tokenHash: string;
  encryptedToken: string;
  createdAt: Date;
  lastUsedAt: Date | null;
}

export interface AccountRepositoryPort {
  create(params: { email: string; passwordHash: string }): Promise<AccountRecord>;
  findByEmail(email: string): Promise<AccountRecord | null>;
  findById(id: string): Promise<AccountRecord | null>;
}

export interface SessionRepositoryPort {
  create(params: { accountId: string; sessionTokenHash: string; expiresAt: Date }): Promise<SessionRecord>;
  findActiveByTokenHash(sessionTokenHash: string, now: Date): Promise<SessionRecord | null>;
  touch(sessionId: string, lastSeenAt: Date): Promise<void>;
}

export interface AccountTokenRepositoryPort {
  findByAccountId(accountId: string): Promise<AccountTokenRecord | null>;
  findByTokenHash(tokenHash: string): Promise<AccountTokenRecord | null>;
  save(params: {
    accountId: string;
    tokenPrefix: string;
    tokenHash: string;
    encryptedToken: string;
  }): Promise<AccountTokenRecord>;
  touch(accountId: string, lastUsedAt: Date): Promise<void>;
}

interface AuthServiceDependencies {
  env: Env;
  accountRepository: AccountRepositoryPort;
  sessionRepository: SessionRepositoryPort;
  accountTokenRepository: AccountTokenRepositoryPort;
  auditService: AuditService;
}

export class AuthService {
  constructor(private readonly dependencies: AuthServiceDependencies) {}

  async register(input: { email: string; password: string }): Promise<{ userId: string; sessionCookie: string }> {
    const email = normalizeEmail(input.email);
    const existing = await this.dependencies.accountRepository.findByEmail(email);

    if (existing) {
      await this.dependencies.auditService.record({
        eventType: "auth.register",
        eventStatus: "failure",
        metadata: { email },
      });
      throw conflict("Account already exists");
    }

    const passwordHash = await hashPassword(input.password);
    const account = await this.dependencies.accountRepository.create({ email, passwordHash });
    const sessionCookie = await this.createSessionCookie(account.id);

    await this.dependencies.auditService.record({
      accountId: account.id,
      eventType: "auth.register",
      eventStatus: "success",
      metadata: { email },
    });

    return { userId: account.id, sessionCookie };
  }

  async login(input: { email: string; password: string }): Promise<{ userId: string; sessionCookie: string }> {
    const email = normalizeEmail(input.email);
    const account = await this.dependencies.accountRepository.findByEmail(email);

    if (!account || !(await verifyPassword(input.password, account.passwordHash))) {
      await this.dependencies.auditService.record({
        eventType: "auth.login",
        eventStatus: "failure",
        metadata: { email },
      });
      throw unauthorized("Invalid email or password");
    }

    const sessionCookie = await this.createSessionCookie(account.id);
    await this.dependencies.auditService.record({
      accountId: account.id,
      eventType: "auth.login",
      eventStatus: "success",
      metadata: { email },
    });

    return { userId: account.id, sessionCookie };
  }

  async authenticateSession(sessionToken: string): Promise<{ accountId: string }> {
    const tokenHash = sha256(sessionToken);
    const session = await this.dependencies.sessionRepository.findActiveByTokenHash(tokenHash, new Date());

    if (!session) {
      throw unauthorized();
    }

    await this.dependencies.sessionRepository.touch(session.id, new Date());
    return { accountId: session.accountId };
  }

  async getAccountTokenForAccount(accountId: string): Promise<{ token: string }> {
    const existing = await this.dependencies.accountTokenRepository.findByAccountId(accountId);

    if (existing) {
      await this.dependencies.accountTokenRepository.touch(accountId, new Date());
      await this.dependencies.auditService.record({
        accountId,
        eventType: "auth.token.read",
        eventStatus: "success",
      });
      return { token: decryptSecret(existing.encryptedToken, this.dependencies.env.SESSION_COOKIE_SECRET) };
    }

    const token = generateApiToken();
    await this.dependencies.accountTokenRepository.save({
      accountId,
      tokenPrefix: tokenPrefix(),
      tokenHash: sha256(token),
      encryptedToken: encryptSecret(token, this.dependencies.env.SESSION_COOKIE_SECRET),
    });

    await this.dependencies.auditService.record({
      accountId,
      eventType: "auth.token.create",
      eventStatus: "success",
    });

    return { token };
  }

  async getAccountTokenForSession(sessionToken: string): Promise<{ token: string }> {
    const session = await this.authenticateSession(sessionToken);
    return this.getAccountTokenForAccount(session.accountId);
  }

  async authenticateApiToken(token: string): Promise<{ accountId: string }> {
    const tokenHash = sha256(token);
    const accountToken = await this.dependencies.accountTokenRepository.findByTokenHash(tokenHash);

    if (!accountToken) {
      throw unauthorized();
    }

    await this.dependencies.accountTokenRepository.touch(accountToken.accountId, new Date());
    return { accountId: accountToken.accountId };
  }

  private async createSessionCookie(accountId: string): Promise<string> {
    const sessionToken = generateSessionToken();
    const expiresAt = new Date(Date.now() + this.dependencies.env.SESSION_TTL_HOURS * 60 * 60 * 1000);

    await this.dependencies.sessionRepository.create({
      accountId,
      sessionTokenHash: sha256(sessionToken),
      expiresAt,
    });

    return serializeSessionCookie(sessionToken, this.dependencies.env);
  }
}
