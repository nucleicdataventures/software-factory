export const ROLES = [
  "Intake",
  "Planner",
  "Test Author",
  "Implementer",
  "Independent Reviewer",
  "Integrator",
] as const;

export type Role = (typeof ROLES)[number];

export const WORKFLOW_STAGES = [
  "intake",
  "plan",
  "plan-gate",
  "author-tests",
  "implement",
  "independent-review",
  "verify-in-fresh-sandbox",
  "merge-gate",
  "package-draft-pr",
  "complete",
] as const;

export type WorkflowStage = (typeof WORKFLOW_STAGES)[number];
export type Gate = "plan" | "merge";
export type WorkStatus = "queued" | "running" | "waiting-approval" | "rejected" | "completed" | "dead-letter";

export interface WorkItem {
  id: string;
  title: string;
  specRef: string;
  status: WorkStatus;
  currentStage: WorkflowStage;
  assigneeRole: Role | null;
  deps: string[];
  budgetTokens: number;
  budgetUsd: number;
  retries: number;
  retryCount: number;
  tokensUsed: number;
  usdUsed: number;
  harness: string;
  model: string;
  sandboxId: string | null;
  evidenceUri: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NewWorkItem {
  id: string;
  title: string;
  specRef: string;
  deps?: string[];
  budgetTokens: number;
  budgetUsd: number;
  retries: number;
  harness: string;
  model: string;
}

export interface RunRecord {
  id: string;
  workId: string;
  role: Role | null;
  stage: WorkflowStage;
  status: "running" | "succeeded" | "failed" | "dead-letter";
  sandboxId: string | null;
  worktreePath: string | null;
  promptHash: string;
  input: Record<string, unknown>;
  result: Record<string, unknown>;
  tokensUsed: number;
  usdUsed: number;
  startedAt: string;
  completedAt: string | null;
}

export interface ApprovalRecord {
  id: string;
  workId: string;
  gate: Gate;
  decision: "approved" | "rejected";
  reason: string | null;
  createdAt: string;
}

export interface EvidenceRecord {
  id: string;
  workId: string;
  kind: string;
  uri: string;
  sha256: string;
  createdAt: string;
}
