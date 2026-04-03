import { randomUUID } from "node:crypto";

import type { Database } from "../../shared/infra/database.js";
import type {
  EvalCaseCreateInput,
  EvalCaseRecord,
  EvalDatasetRecord,
  EvalDatasetSummary,
  EvalRunRecord,
  EvalRunSummary,
} from "../../modules/evals/domain/evalTypes.js";
import type { EvalRepositoryPort } from "../../modules/evals/services/evalLabService.js";

interface EvalDatasetRow {
  id: string;
  workspace_id: string;
  name: string;
  description: string;
  status: "active" | "archived";
  created_by_account_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  case_count?: number;
  run_count?: number | string;
  last_run_at?: Date | string | null;
}

interface EvalCaseRow {
  id: string;
  dataset_id: string;
  workspace_id: string;
  title: string;
  source_type: "manual" | "conversation_import";
  query: string;
  conversation_context: unknown;
  expectations: unknown;
  provenance: unknown;
  created_at: Date | string;
  updated_at: Date | string;
}

interface EvalRunRow {
  id: string;
  dataset_id: string;
  workspace_id: string;
  label: string | null;
  baseline_run_id: string | null;
  created_by_account_id: string | null;
  run_metadata: unknown;
  summary: unknown;
  results: unknown;
  started_at: Date | string;
  completed_at: Date | string;
}

const toIsoString = (value: Date | string | null | undefined): string | null => (value ? new Date(value).toISOString() : null);

const mapDataset = (row: EvalDatasetRow): EvalDatasetRecord => ({
  id: row.id,
  workspaceId: row.workspace_id,
  name: row.name,
  description: row.description,
  status: row.status,
  createdByAccountId: row.created_by_account_id,
  createdAt: toIsoString(row.created_at) ?? new Date(0).toISOString(),
  updatedAt: toIsoString(row.updated_at) ?? new Date(0).toISOString(),
});

const mapDatasetSummary = (row: EvalDatasetRow): EvalDatasetSummary => ({
  ...mapDataset(row),
  caseCount: Number(row.case_count ?? 0),
  runCount: Number(row.run_count ?? 0),
  lastRunAt: toIsoString(row.last_run_at),
});

const mapCase = (row: EvalCaseRow): EvalCaseRecord => ({
  id: row.id,
  datasetId: row.dataset_id,
  workspaceId: row.workspace_id,
  title: row.title,
  sourceType: row.source_type,
  query: row.query,
  conversationContext: Array.isArray(row.conversation_context) ? (row.conversation_context as EvalCaseRecord["conversationContext"]) : [],
  expectations: row.expectations && typeof row.expectations === "object" ? (row.expectations as EvalCaseRecord["expectations"]) : {},
  provenance: row.provenance && typeof row.provenance === "object" ? (row.provenance as Record<string, unknown>) : {},
  createdAt: toIsoString(row.created_at) ?? new Date(0).toISOString(),
  updatedAt: toIsoString(row.updated_at) ?? new Date(0).toISOString(),
});

const defaultRunSummary: EvalRunSummary = {
  totalCases: 0,
  passCount: 0,
  failCount: 0,
  skippedCount: 0,
  invalidCount: 0,
  improvementCount: 0,
  regressionCount: 0,
  unchangedCount: 0,
};

const mapRun = (row: EvalRunRow): EvalRunRecord => ({
  id: row.id,
  datasetId: row.dataset_id,
  workspaceId: row.workspace_id,
  label: row.label,
  baselineRunId: row.baseline_run_id,
  createdByAccountId: row.created_by_account_id,
  runMetadata: row.run_metadata && typeof row.run_metadata === "object" ? (row.run_metadata as Record<string, unknown>) : {},
  summary: row.summary && typeof row.summary === "object" ? (row.summary as EvalRunSummary) : defaultRunSummary,
  results: Array.isArray(row.results) ? (row.results as EvalRunRecord["results"]) : [],
  startedAt: toIsoString(row.started_at) ?? new Date(0).toISOString(),
  completedAt: toIsoString(row.completed_at) ?? new Date(0).toISOString(),
});

export class EvalRepository implements EvalRepositoryPort {
  constructor(private readonly database: Database) {}

  async listDatasets(workspaceId: string): Promise<EvalDatasetSummary[]> {
    const rows = await this.database.query<EvalDatasetRow>(
      `SELECT d.id,
              d.workspace_id,
              d.name,
              d.description,
              d.status,
              d.created_by_account_id,
              d.created_at,
              d.updated_at,
              COUNT(DISTINCT c.id) AS case_count,
              COUNT(DISTINCT r.id) AS run_count,
              MAX(r.completed_at) AS last_run_at
         FROM eval_datasets d
         LEFT JOIN eval_cases c ON c.dataset_id = d.id
         LEFT JOIN eval_runs r ON r.dataset_id = d.id
        WHERE d.workspace_id = $1
        GROUP BY d.id
        ORDER BY d.updated_at DESC`,
      [workspaceId],
    );
    return rows.map(mapDatasetSummary);
  }

  async createDataset(
    workspaceId: string,
    input: { name: string; description?: string; createdByAccountId?: string | null },
  ): Promise<EvalDatasetRecord> {
    const [row] = await this.database.query<EvalDatasetRow>(
      `INSERT INTO eval_datasets (id, workspace_id, name, description, status, created_by_account_id)
       VALUES ($1, $2, $3, $4, 'active', $5)
       RETURNING id, workspace_id, name, description, status, created_by_account_id, created_at, updated_at`,
      [randomUUID(), workspaceId, input.name, input.description ?? "", input.createdByAccountId ?? null],
    );
    return mapDataset(row);
  }

  async findDatasetById(workspaceId: string, datasetId: string): Promise<EvalDatasetRecord | null> {
    const [row] = await this.database.query<EvalDatasetRow>(
      `SELECT id, workspace_id, name, description, status, created_by_account_id, created_at, updated_at
         FROM eval_datasets
        WHERE workspace_id = $1
          AND id = $2`,
      [workspaceId, datasetId],
    );
    return row ? mapDataset(row) : null;
  }

  async listCases(datasetId: string): Promise<EvalCaseRecord[]> {
    const rows = await this.database.query<EvalCaseRow>(
      `SELECT id, dataset_id, workspace_id, title, source_type, query, conversation_context, expectations, provenance, created_at, updated_at
         FROM eval_cases
        WHERE dataset_id = $1
        ORDER BY created_at ASC`,
      [datasetId],
    );
    return rows.map(mapCase);
  }

  async createCase(workspaceId: string, datasetId: string, input: EvalCaseCreateInput): Promise<EvalCaseRecord> {
    const [row] = await this.database.query<EvalCaseRow>(
      `INSERT INTO eval_cases (
         id, dataset_id, workspace_id, title, source_type, query, conversation_context, expectations, provenance
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb)
       RETURNING id, dataset_id, workspace_id, title, source_type, query, conversation_context, expectations, provenance, created_at, updated_at`,
      [
        randomUUID(),
        datasetId,
        workspaceId,
        input.title,
        input.sourceType ?? "manual",
        input.query,
        JSON.stringify(input.conversationContext ?? []),
        JSON.stringify(input.expectations ?? {}),
        JSON.stringify(input.provenance ?? {}),
      ],
    );
    await this.database.query(
      `UPDATE eval_datasets
          SET updated_at = NOW()
        WHERE id = $1`,
      [datasetId],
    );
    return mapCase(row);
  }

  async listRuns(datasetId: string): Promise<EvalRunRecord[]> {
    const rows = await this.database.query<EvalRunRow>(
      `SELECT id, dataset_id, workspace_id, label, baseline_run_id, created_by_account_id, run_metadata, summary, results, started_at, completed_at
         FROM eval_runs
        WHERE dataset_id = $1
        ORDER BY completed_at DESC`,
      [datasetId],
    );
    return rows.map(mapRun);
  }

  async createRun(
    workspaceId: string,
    datasetId: string,
    input: {
      label?: string | null;
      baselineRunId?: string | null;
      createdByAccountId?: string | null;
      runMetadata?: Record<string, unknown>;
      summary: EvalRunRecord["summary"];
      results: EvalRunRecord["results"];
    },
  ): Promise<EvalRunRecord> {
    const [row] = await this.database.query<EvalRunRow>(
      `INSERT INTO eval_runs (
         id, dataset_id, workspace_id, label, baseline_run_id, created_by_account_id, run_metadata, summary, results, started_at, completed_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, NOW(), NOW())
       RETURNING id, dataset_id, workspace_id, label, baseline_run_id, created_by_account_id, run_metadata, summary, results, started_at, completed_at`,
      [
        randomUUID(),
        datasetId,
        workspaceId,
        input.label ?? null,
        input.baselineRunId ?? null,
        input.createdByAccountId ?? null,
        JSON.stringify(input.runMetadata ?? {}),
        JSON.stringify(input.summary),
        JSON.stringify(input.results),
      ],
    );
    await this.database.query(
      `UPDATE eval_datasets
          SET updated_at = NOW()
        WHERE id = $1`,
      [datasetId],
    );
    return mapRun(row);
  }

  async findRunById(workspaceId: string, datasetId: string, runId: string): Promise<EvalRunRecord | null> {
    const [row] = await this.database.query<EvalRunRow>(
      `SELECT id, dataset_id, workspace_id, label, baseline_run_id, created_by_account_id, run_metadata, summary, results, started_at, completed_at
         FROM eval_runs
        WHERE workspace_id = $1
          AND dataset_id = $2
          AND id = $3`,
      [workspaceId, datasetId, runId],
    );
    return row ? mapRun(row) : null;
  }
}
