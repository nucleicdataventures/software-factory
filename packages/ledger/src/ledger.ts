import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  ApprovalRecord,
  EvidenceRecord,
  Gate,
  NewWorkItem,
  Role,
  RunRecord,
  WorkItem,
  WorkStatus,
  WorkflowStage,
} from "./types.js";

type Row = Record<string, string | number | bigint | Uint8Array | null>;

function asNumber(value: Row[string] | undefined): number {
  return Number(value ?? 0);
}

function mapWorkItem(row: Row | undefined): WorkItem | null {
  if (!row) return null;
  return {
    id: String(row.id),
    title: String(row.title),
    specRef: String(row.spec_ref),
    status: String(row.status) as WorkStatus,
    currentStage: String(row.current_stage) as WorkflowStage,
    assigneeRole: row.assignee_role === null ? null : (String(row.assignee_role) as Role),
    deps: JSON.parse(String(row.deps_json)) as string[],
    budgetTokens: asNumber(row.budget_tokens),
    budgetUsd: asNumber(row.budget_usd),
    retries: asNumber(row.retries),
    retryCount: asNumber(row.retry_count),
    tokensUsed: asNumber(row.tokens_used),
    usdUsed: asNumber(row.usd_used),
    harness: String(row.harness),
    model: String(row.model),
    sandboxId: row.sandbox_id === null ? null : String(row.sandbox_id),
    evidenceUri: row.evidence_uri === null ? null : String(row.evidence_uri),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapRun(row: Row): RunRecord {
  return {
    id: String(row.id),
    workId: String(row.work_id),
    role: row.role === null ? null : (String(row.role) as Role),
    stage: String(row.stage) as WorkflowStage,
    status: String(row.status) as RunRecord["status"],
    sandboxId: row.sandbox_id === null ? null : String(row.sandbox_id),
    worktreePath: row.worktree_path === null ? null : String(row.worktree_path),
    promptHash: String(row.prompt_hash),
    input: JSON.parse(String(row.input_json)) as Record<string, unknown>,
    result: JSON.parse(String(row.result_json)) as Record<string, unknown>,
    tokensUsed: asNumber(row.tokens_used),
    usdUsed: asNumber(row.usd_used),
    startedAt: String(row.started_at),
    completedAt: row.completed_at === null ? null : String(row.completed_at),
  };
}

export class Ledger {
  readonly database: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.database = new DatabaseSync(path);
    this.database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    if (path !== ":memory:") this.database.exec("PRAGMA journal_mode = WAL;");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS work_items (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        spec_ref TEXT NOT NULL,
        status TEXT NOT NULL,
        current_stage TEXT NOT NULL,
        assignee_role TEXT,
        deps_json TEXT NOT NULL,
        budget_tokens INTEGER NOT NULL,
        budget_usd REAL NOT NULL,
        retries INTEGER NOT NULL,
        retry_count INTEGER NOT NULL DEFAULT 0,
        tokens_used INTEGER NOT NULL DEFAULT 0,
        usd_used REAL NOT NULL DEFAULT 0,
        harness TEXT NOT NULL,
        model TEXT NOT NULL,
        sandbox_id TEXT,
        evidence_uri TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        work_id TEXT NOT NULL REFERENCES work_items(id),
        role TEXT,
        stage TEXT NOT NULL,
        status TEXT NOT NULL,
        sandbox_id TEXT,
        worktree_path TEXT,
        prompt_hash TEXT NOT NULL,
        input_json TEXT NOT NULL,
        result_json TEXT NOT NULL,
        tokens_used INTEGER NOT NULL DEFAULT 0,
        usd_used REAL NOT NULL DEFAULT 0,
        started_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS runs_by_work ON runs(work_id, started_at);
      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        work_id TEXT NOT NULL REFERENCES work_items(id),
        gate TEXT NOT NULL,
        decision TEXT NOT NULL,
        reason TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS approvals_latest ON approvals(work_id, gate, created_at);
      CREATE TABLE IF NOT EXISTS evidence (
        id TEXT PRIMARY KEY,
        work_id TEXT NOT NULL REFERENCES work_items(id),
        kind TEXT NOT NULL,
        uri TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS leases (
        work_id TEXT PRIMARY KEY REFERENCES work_items(id),
        owner TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
    `);
  }

  close(): void {
    this.database.close();
  }

  createWorkItem(input: NewWorkItem): WorkItem {
    const now = new Date().toISOString();
    this.database.prepare(`
      INSERT INTO work_items (
        id,title,spec_ref,status,current_stage,assignee_role,deps_json,
        budget_tokens,budget_usd,retries,harness,model,created_at,updated_at
      ) VALUES (?,?,?,'queued','intake','Intake',?,?,?,?,?,?,?,?)
    `).run(
      input.id,
      input.title,
      input.specRef,
      JSON.stringify(input.deps ?? []),
      input.budgetTokens,
      input.budgetUsd,
      input.retries,
      input.harness,
      input.model,
      now,
      now,
    );
    const item = this.getWorkItem(input.id);
    if (!item) throw new Error(`Work item ${input.id} was not persisted`);
    return item;
  }

  getWorkItem(id: string): WorkItem | null {
    return mapWorkItem(this.database.prepare("SELECT * FROM work_items WHERE id=?").get(id) as Row | undefined);
  }

  listWorkItems(): WorkItem[] {
    return (this.database.prepare("SELECT * FROM work_items ORDER BY created_at DESC").all() as Row[]).map((row) => mapWorkItem(row)!);
  }

  updateWorkItem(id: string, fields: Partial<Pick<WorkItem, "status" | "currentStage" | "assigneeRole" | "sandboxId" | "evidenceUri">>): WorkItem {
    const current = this.getWorkItem(id);
    if (!current) throw new Error(`Unknown work item: ${id}`);
    const next = { ...current, ...fields, updatedAt: new Date().toISOString() };
    this.database.prepare(`
      UPDATE work_items SET status=?,current_stage=?,assignee_role=?,sandbox_id=?,evidence_uri=?,updated_at=? WHERE id=?
    `).run(next.status, next.currentStage, next.assigneeRole, next.sandboxId, next.evidenceUri, next.updatedAt, id);
    return this.getWorkItem(id)!;
  }

  recordRun(run: RunRecord): void {
    this.database.prepare(`
      INSERT INTO runs (
        id,work_id,role,stage,status,sandbox_id,worktree_path,prompt_hash,
        input_json,result_json,tokens_used,usd_used,started_at,completed_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      run.id, run.workId, run.role, run.stage, run.status, run.sandboxId, run.worktreePath,
      run.promptHash, JSON.stringify(run.input), JSON.stringify(run.result), run.tokensUsed,
      run.usdUsed, run.startedAt, run.completedAt,
    );
  }

  listRuns(workId: string): RunRecord[] {
    return (this.database.prepare("SELECT * FROM runs WHERE work_id=? ORDER BY started_at").all(workId) as Row[]).map(mapRun);
  }

  recordApproval(record: ApprovalRecord): void {
    this.database.prepare(
      "INSERT INTO approvals (id,work_id,gate,decision,reason,created_at) VALUES (?,?,?,?,?,?)",
    ).run(record.id, record.workId, record.gate, record.decision, record.reason, record.createdAt);
  }

  transitionGate(
    record: ApprovalRecord,
    expectedStage: WorkflowStage,
    fields: Partial<Pick<WorkItem, "status" | "currentStage" | "assigneeRole">>,
  ): boolean {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const item = this.getWorkItem(record.workId);
      if (!item || item.status !== "waiting-approval" || item.currentStage !== expectedStage) {
        this.database.exec("ROLLBACK");
        return false;
      }
      this.recordApproval(record);
      this.updateWorkItem(record.workId, fields);
      this.database.exec("COMMIT");
      return true;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  latestApproval(workId: string, gate: Gate): ApprovalRecord | null {
    const row = this.database.prepare(
      "SELECT * FROM approvals WHERE work_id=? AND gate=? ORDER BY created_at DESC LIMIT 1",
    ).get(workId, gate) as Row | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      workId: String(row.work_id),
      gate: String(row.gate) as Gate,
      decision: String(row.decision) as ApprovalRecord["decision"],
      reason: row.reason === null ? null : String(row.reason),
      createdAt: String(row.created_at),
    };
  }

  recordEvidence(record: EvidenceRecord): void {
    this.database.prepare(
      "INSERT INTO evidence (id,work_id,kind,uri,sha256,created_at) VALUES (?,?,?,?,?,?)",
    ).run(record.id, record.workId, record.kind, record.uri, record.sha256, record.createdAt);
  }

  listEvidence(workId: string): EvidenceRecord[] {
    return (this.database.prepare("SELECT * FROM evidence WHERE work_id=? ORDER BY created_at").all(workId) as Row[]).map((row) => ({
      id: String(row.id),
      workId: String(row.work_id),
      kind: String(row.kind),
      uri: String(row.uri),
      sha256: String(row.sha256),
      createdAt: String(row.created_at),
    }));
  }

  claimLease(workId: string, owner: string, ttlMs: number, now = Date.now()): boolean {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.database.prepare(`
        INSERT INTO leases (work_id,owner,expires_at) VALUES (?,?,?)
        ON CONFLICT(work_id) DO UPDATE SET owner=excluded.owner, expires_at=excluded.expires_at
        WHERE leases.expires_at <= ?
      `).run(workId, owner, now + ttlMs, now);
      this.database.exec("COMMIT");
      return Number(result.changes) === 1;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  renewLease(workId: string, owner: string, ttlMs: number, now = Date.now()): boolean {
    const result = this.database.prepare(`
      UPDATE leases SET expires_at=?
      WHERE work_id=? AND owner=? AND expires_at>?
    `).run(now + ttlMs, workId, owner, now);
    return Number(result.changes) === 1;
  }

  releaseLease(workId: string, owner: string): boolean {
    return Number(this.database.prepare("DELETE FROM leases WHERE work_id=? AND owner=?").run(workId, owner).changes) === 1;
  }

  recordUsage(workId: string, tokens: number, usd: number): boolean {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const item = this.getWorkItem(workId);
      if (!item) throw new Error(`Unknown work item: ${workId}`);
      const valid = Number.isSafeInteger(tokens) && tokens >= 0 && Number.isFinite(usd) && usd >= 0;
      if (!valid) {
        this.database.prepare("UPDATE work_items SET status='dead-letter',updated_at=? WHERE id=?")
          .run(new Date().toISOString(), workId);
        this.database.exec("COMMIT");
        return false;
      }
      const tokenTotal = item.tokensUsed + tokens;
      const usdTotal = item.usdUsed + usd;
      if (!Number.isSafeInteger(tokenTotal) || !Number.isFinite(usdTotal)) {
        this.database.prepare("UPDATE work_items SET status='dead-letter',updated_at=? WHERE id=?")
          .run(new Date().toISOString(), workId);
        this.database.exec("COMMIT");
        return false;
      }
      const exceeded = tokenTotal > item.budgetTokens || usdTotal > item.budgetUsd;
      this.database.prepare(`
        UPDATE work_items SET tokens_used=?,usd_used=?,status=?,updated_at=? WHERE id=?
      `).run(tokenTotal, usdTotal, exceeded ? "dead-letter" : item.status, new Date().toISOString(), workId);
      this.database.exec("COMMIT");
      return !exceeded;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  recordFailure(workId: string): { retryCount: number; deadLetter: boolean } {
    const item = this.getWorkItem(workId);
    if (!item) throw new Error(`Unknown work item: ${workId}`);
    const retryCount = item.retryCount + 1;
    const deadLetter = retryCount > item.retries;
    this.database.prepare(
      "UPDATE work_items SET retry_count=?,status=?,updated_at=? WHERE id=?",
    ).run(retryCount, deadLetter ? "dead-letter" : item.status, new Date().toISOString(), workId);
    return { retryCount, deadLetter };
  }
}
