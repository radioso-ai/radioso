import type { Database } from "../../shared/infra/database.js";
import type { AccountTokenRecord, AccountTokenRepositoryPort } from "../../modules/auth/services/authService.js";

interface AccountTokenRow {
  account_id: string;
  token_prefix: string;
  token_hash: string;
  encrypted_token: string;
  created_at: Date;
  last_used_at: Date | null;
}

const mapToken = (row: AccountTokenRow): AccountTokenRecord => ({
  accountId: row.account_id,
  tokenPrefix: row.token_prefix,
  tokenHash: row.token_hash,
  encryptedToken: row.encrypted_token,
  createdAt: new Date(row.created_at),
  lastUsedAt: row.last_used_at ? new Date(row.last_used_at) : null,
});

export class AccountTokenRepository implements AccountTokenRepositoryPort {
  constructor(private readonly database: Database) {}

  async findByAccountId(accountId: string): Promise<AccountTokenRecord | null> {
    const [row] = await this.database.query<AccountTokenRow>(
      `SELECT account_id, token_prefix, token_hash, encrypted_token, created_at, last_used_at
       FROM account_tokens
       WHERE account_id = $1`,
      [accountId],
    );

    return row ? mapToken(row) : null;
  }

  async findByTokenHash(tokenHash: string): Promise<AccountTokenRecord | null> {
    const [row] = await this.database.query<AccountTokenRow>(
      `SELECT account_id, token_prefix, token_hash, encrypted_token, created_at, last_used_at
       FROM account_tokens
       WHERE token_hash = $1`,
      [tokenHash],
    );

    return row ? mapToken(row) : null;
  }

  async save(params: {
    accountId: string;
    tokenPrefix: string;
    tokenHash: string;
    encryptedToken: string;
  }): Promise<AccountTokenRecord> {
    const [row] = await this.database.query<AccountTokenRow>(
      `INSERT INTO account_tokens (account_id, token_prefix, token_hash, encrypted_token)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (account_id)
       DO UPDATE SET token_prefix = EXCLUDED.token_prefix,
                     token_hash = EXCLUDED.token_hash,
                     encrypted_token = EXCLUDED.encrypted_token
       RETURNING account_id, token_prefix, token_hash, encrypted_token, created_at, last_used_at`,
      [params.accountId, params.tokenPrefix, params.tokenHash, params.encryptedToken],
    );

    return mapToken(row);
  }

  async touch(accountId: string, lastUsedAt: Date): Promise<void> {
    await this.database.query(
      `UPDATE account_tokens
       SET last_used_at = $2
       WHERE account_id = $1`,
      [accountId, lastUsedAt],
    );
  }
}
