import type { Pool } from "pg";
import type { StepType } from "../domain/schemas.js";
import type {
  CreateInstanceRecord,
  ExecutionRepository,
  InstanceFilters,
  InstanceStatus,
  StepRun,
  StepRunStatus,
  WorkflowInstance,
} from "../execution/types.js";

interface InstanceRow {
  instance_id: string;
  template_id: string;
  template_name: string;
  template_version: number;
  steps: WorkflowInstance["steps"];
  status: InstanceStatus;
  current_step: string | null;
  cursor_index: number;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

interface StepRunRow {
  run_id: string;
  instance_id: string;
  step_id: string;
  step_type: StepType;
  status: StepRunStatus;
  performed_by: string | null;
  result: Record<string, unknown>;
  started_at: Date;
  finished_at: Date;
}

const INSTANCE_COLUMNS = `instance_id, template_id, template_name, template_version, steps,
  status, current_step, cursor_index, created_by, created_at, updated_at`;

function toInstance(row: InstanceRow): WorkflowInstance {
  return {
    instanceId: row.instance_id,
    templateId: row.template_id,
    templateName: row.template_name,
    templateVersion: row.template_version,
    steps: row.steps,
    status: row.status,
    currentStep: row.current_step,
    cursorIndex: row.cursor_index,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function toStepRun(row: StepRunRow): StepRun {
  return {
    runId: row.run_id,
    instanceId: row.instance_id,
    stepId: row.step_id,
    stepType: row.step_type,
    status: row.status,
    performedBy: row.performed_by,
    result: row.result,
    startedAt: row.started_at.toISOString(),
    finishedAt: row.finished_at.toISOString(),
  };
}

/** Parameterised SQL only; steps snapshot and run results travel as JSONB. */
export class PostgresExecutionRepository implements ExecutionRepository {
  constructor(private readonly pool: Pool) {}

  async create(record: CreateInstanceRecord): Promise<WorkflowInstance> {
    const result = await this.pool.query<InstanceRow>(
      `INSERT INTO workflow_instances
         (template_id, template_name, template_version, steps, status, current_step, cursor_index, created_by)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8)
       RETURNING ${INSTANCE_COLUMNS}`,
      [
        record.templateId,
        record.templateName,
        record.templateVersion,
        JSON.stringify(record.steps),
        record.status,
        record.currentStep,
        record.cursorIndex,
        record.createdBy,
      ],
    );
    return toInstance(result.rows[0]!);
  }

  async list(filters: InstanceFilters): Promise<WorkflowInstance[]> {
    const result = await this.pool.query<InstanceRow>(
      `SELECT ${INSTANCE_COLUMNS}
       FROM workflow_instances
       WHERE ($1::text IS NULL OR status = $1)
         AND ($2::uuid IS NULL OR template_id = $2)
       ORDER BY created_at DESC`,
      [filters.status ?? null, filters.templateId ?? null],
    );
    return result.rows.map(toInstance);
  }

  async getById(id: string): Promise<WorkflowInstance | null> {
    const result = await this.pool.query<InstanceRow>(
      `SELECT ${INSTANCE_COLUMNS} FROM workflow_instances WHERE instance_id = $1`,
      [id],
    );
    return result.rows[0] ? toInstance(result.rows[0]) : null;
  }

  async getStepRuns(instanceId: string): Promise<StepRun[]> {
    const result = await this.pool.query<StepRunRow>(
      `SELECT run_id, instance_id, step_id, step_type, status, performed_by, result, started_at, finished_at
       FROM step_runs
       WHERE instance_id = $1
       ORDER BY started_at ASC, run_id ASC`,
      [instanceId],
    );
    return result.rows.map(toStepRun);
  }

  async update(
    id: string,
    patch: { status: InstanceStatus; currentStep: string | null; cursorIndex: number },
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE workflow_instances
       SET status = $1, current_step = $2, cursor_index = $3, updated_at = now()
       WHERE instance_id = $4`,
      [patch.status, patch.currentStep, patch.cursorIndex, id],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async recordStepRun(event: {
    instanceId: string;
    stepId: string;
    stepType: StepType;
    status: StepRunStatus;
    performedBy: string | null;
    result: Record<string, unknown>;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO step_runs (instance_id, step_id, step_type, status, performed_by, result)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       ON CONFLICT (instance_id, step_id)
       DO UPDATE SET status = EXCLUDED.status,
                     performed_by = EXCLUDED.performed_by,
                     result = EXCLUDED.result,
                     finished_at = now()`,
      [
        event.instanceId,
        event.stepId,
        event.stepType,
        event.status,
        event.performedBy,
        JSON.stringify(event.result),
      ],
    );
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
