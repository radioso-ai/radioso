import { currentTimestamp, toJsonb } from "../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../shared/infra/kysely/types.js";
import type {
  ApiConnectionRecord,
  ApiConnectionRepositoryPort,
  ApiConnectionWrite,
} from "../../modules/apiRequestSkills/public.js";

interface ApiConnectionRow {
  id: string;
  workspace_id: string;
  name: string;
  base_url: string;
  auth_scheme: string;
  auth_header_name: string | null;
  credential_ciphertext: string | null;
  default_headers: unknown;
  created_at: Date | string;
  updated_at: Date | string;
}

const connectionColumns = [
  "id",
  "workspace_id",
  "name",
  "base_url",
  "auth_scheme",
  "auth_header_name",
  "credential_ciphertext",
  "default_headers",
  "created_at",
  "updated_at",
] as const;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

const isUuid = (value: string): boolean => uuidPattern.test(value);

const headersOf = (value: unknown): Record<string, string> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
    : {};

const mapRow = (row: ApiConnectionRow): ApiConnectionRecord => ({
  id: row.id,
  workspaceId: row.workspace_id,
  name: row.name,
  baseUrl: row.base_url,
  // The column's CHECK holds it to the four schemes.
  authScheme: row.auth_scheme as ApiConnectionRecord["authScheme"],
  authHeaderName: row.auth_header_name,
  credentialCiphertext: row.credential_ciphertext,
  defaultHeaders: headersOf(row.default_headers),
  createdAt: new Date(row.created_at),
  updatedAt: new Date(row.updated_at),
});

const columnsFor = (input: ApiConnectionWrite) => ({
  name: input.name,
  base_url: input.baseUrl,
  auth_scheme: input.authScheme,
  auth_header_name: input.authHeaderName,
  credential_ciphertext: input.credentialCiphertext,
  default_headers: toJsonb(input.defaultHeaders),
});

export class ApiConnectionRepository implements ApiConnectionRepositoryPort {
  constructor(private readonly db: Db) {}

  async create(input: ApiConnectionWrite & { workspaceId: string }): Promise<ApiConnectionRecord> {
    const row = await this.db
      .insertInto("api_connections")
      .values({ workspace_id: input.workspaceId, ...columnsFor(input) })
      .returning(connectionColumns)
      .executeTakeFirstOrThrow();
    return mapRow(row);
  }

  async listByWorkspace(workspaceId: string): Promise<ApiConnectionRecord[]> {
    const rows = await this.db
      .selectFrom("api_connections")
      .select(connectionColumns)
      .where("workspace_id", "=", workspaceId)
      .orderBy((eb) => eb.fn<string>("lower", ["name"]), "asc")
      .orderBy("created_at", "asc")
      .orderBy("id", "asc")
      .execute();
    return rows.map((row) => mapRow(row));
  }

  async findByIdAndWorkspace(id: string, workspaceId: string): Promise<ApiConnectionRecord | null> {
    if (!isUuid(id)) return null;
    const row = await this.db
      .selectFrom("api_connections")
      .select(connectionColumns)
      .where("id", "=", id)
      .where("workspace_id", "=", workspaceId)
      .executeTakeFirst();
    return row ? mapRow(row) : null;
  }

  async update(id: string, workspaceId: string, input: ApiConnectionWrite): Promise<ApiConnectionRecord | null> {
    if (!isUuid(id)) return null;
    const row = await this.db
      .updateTable("api_connections")
      .set({ ...columnsFor(input), updated_at: currentTimestamp() })
      .where("id", "=", id)
      .where("workspace_id", "=", workspaceId)
      .returning(connectionColumns)
      .executeTakeFirst();
    return row ? mapRow(row) : null;
  }

  async delete(id: string, workspaceId: string): Promise<boolean> {
    if (!isUuid(id)) return false;
    const result = await this.db
      .deleteFrom("api_connections")
      .where("id", "=", id)
      .where("workspace_id", "=", workspaceId)
      .executeTakeFirst();
    return Number(result.numDeletedRows) > 0;
  }

  async listSkillNamesReferencingConnection(workspaceId: string, connectionId: string): Promise<string[]> {
    if (!isUuid(connectionId)) return [];
    const rows = await this.db
      .selectFrom("agent_skills")
      .select("skill_name")
      .where("workspace_id", "=", workspaceId)
      .where("kind", "=", "api_request")
      .where("target_type", "=", "api_connection")
      .where("target_id", "=", connectionId)
      .orderBy("skill_name", "asc")
      .execute();
    return [...new Set(rows.map((row) => row.skill_name))];
  }
}
