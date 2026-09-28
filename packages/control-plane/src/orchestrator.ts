import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  evidenceDirectory,
  makeEvidencePath,
  sha256,
  writeEvidenceFile,
  writeProvenance,
  type ProvenanceRecord,
} from "evidence";
import { Ledger, type ApprovalRecord, type Gate, type Role, type RunRecord, type WorkflowStage } from "ledger";
import { CodexHarnessError, DockerSandbox, GitWorktreeManager, buildCodexPrompt, type CodexLoginStatus, probeCodexLoginStatus, type HarnessAdapter, type HarnessRequest, type HarnessResult, type WorktreeSandbox } from "worker";
import { createHarnessAdapter, loadFactoryConfig, type FactoryConfig } from "./factory.js";

export interface TestResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface TestExecutor {
  run(worktree: WorktreeSandbox, repoRoot: string): Promise<TestResult>;
}

export class DockerTestExecutor implements TestExecutor {
  private readonly docker = new DockerSandbox();

  constructor(private readonly timeoutMs = 30 * 60_000) {}

  async run(worktree: WorktreeSandbox, repoRoot: string): Promise<TestResult> {
    const result = this.docker.run(
      {
        workId: worktree.workId,
        role: worktree.role,
        stage: worktree.stage,
        sandboxId: worktree.sandboxId,
        image: worktree.image,
      },
      worktree.path,
      ["node", "node_modules/vitest/vitest.mjs", "run", "--config", "vitest.config.ts"],
      [join(repoRoot, "node_modules"), join(repoRoot, "demo-app", "node_modules")],
      this.timeoutMs,
    );
    return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
  }
}

export interface OrchestratorOptions {
  ledger?: Ledger;
  harness?: HarnessAdapter;
  harnessName?: string | undefined;
  worktrees?: GitWorktreeManager;
  testExecutor?: TestExecutor;
  now?: () => Date;
  codexStatusProbe?: () => Promise<CodexLoginStatus>;
}

export interface WorkItemView {
  item: ReturnType<Ledger["getWorkItem"]>;
  runs: RunRecord[];
  evidence: ReturnType<Ledger["listEvidence"]>;
}

const DEMO_FILES: Record<string, string> = {
  "package.json": JSON.stringify({
    name: "demo-app", version: "0.1.0", private: true, type: "module",
    scripts: { build: "tsc -p tsconfig.json", typecheck: "tsc --noEmit -p tsconfig.json", test: "vitest run", start: "node dist/server.js" },
    dependencies: { fastify: "^5.6.0" },
    devDependencies: { "@types/node": "^22.15.0", typescript: "^5.9.2", vitest: "^3.2.4" },
  }, null, 2) + "\n",
  "tsconfig.json": JSON.stringify({ extends: "../tsconfig.base.json", compilerOptions: { rootDir: "src", outDir: "dist" }, include: ["src/**/*.ts"] }, null, 2) + "\n",
  "src/app.ts": `import Fastify from "fastify";\n\nexport function buildApp() {\n  const app = Fastify({ logger: false });\n  const todos: Array<{ id: number; title: string; completed: boolean }> = [];\n  let nextId = 1;\n  app.get("/todos", async () => todos);\n  app.post<{ Body: { title?: string } }>("/todos", async (request, reply) => {\n    const title = request.body?.title?.trim();\n    if (!title) return reply.code(400).send({ error: "title is required" });\n    const todo = { id: nextId++, title, completed: false };\n    todos.push(todo);\n    return reply.code(201).send(todo);\n  });\n  return app;\n}\n`,
  "src/server.ts": `import { buildApp } from "./app.js";\nconst app = buildApp();\nawait app.listen({ host: "0.0.0.0", port: Number(process.env.PORT ?? 3000) });\n`,
  "tests/app.test.ts": `import { afterEach, expect, it } from "vitest";\nimport { buildApp } from "../src/app.js";\nconst apps: Array<ReturnType<typeof buildApp>> = [];\nafterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));\nit("creates and lists todos", async () => {\n  const app = buildApp(); apps.push(app);\n  const created = await app.inject({ method: "POST", url: "/todos", payload: { title: "Ship Forge" } });\n  expect(created.statusCode).toBe(201);\n  expect((await app.inject({ method: "GET", url: "/todos" })).json()).toHaveLength(1);\n});\n`,
};

export function initializeWorkspace(repoRoot: string): Ledger {
  mkdirSync(join(repoRoot, ".forge"), { recursive: true });
  for (const [name, body] of Object.entries(DEMO_FILES)) {
    const target = join(repoRoot, "demo-app", ...name.split("/"));
    if (!existsSync(target)) {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, body, { flag: "wx" });
    }
  }
  return new Ledger(join(repoRoot, ".forge", "forge.db"));
}

function makeId(now: Date): string {
  return `forge-${now.toISOString().slice(0, 10).replaceAll("-", "")}-${randomUUID().slice(0, 8)}`;
}

function titleFromText(text: string): string {
  const title = text.split(/\r?\n/).find((line) => line.trim())?.replace(/^#+\s*/, "").trim();
  return (title || "Forge work item").slice(0, 180);
}

function makeSpec(prompt: string): string {
  return `# ${titleFromText(prompt)}\n\n## Request\n\n${prompt.trim()}\n\n## Acceptance criteria\n\n- The requested behavior is implemented in the target project.\n- Existing tests stay green and a focused test covers the change.\n- A fresh sandbox verifies the candidate patch.\n\n## Constraints\n\n- Follow factory.yaml and policies/invariants.md.\n- Do not merge, push, or force-push.\n`;
}

function planFor(specText: string): string {
  const title = titleFromText(specText);
  return `# Plan: ${title}\n\n## Task DAG\n\n1. Test Author: turn the acceptance criteria into a focused failing test.\n2. Implementer: make the test pass in a separate worktree.\n3. Independent Reviewer: inspect only the spec, diff, and test output.\n4. CODE: verify the candidate in a fresh sandbox.\n5. Integrator: package the patch and provenance after the human merge-gate approval.\n\n## Gate\n\nWaiting for human approval before any implementation work starts.\n`;
}

function parseTitle(specText: string): string {
  return titleFromText(specText);
}

function safeSpecPath(repoRoot: string, reference: string): string {
  const canonicalRoot = realpathSync(repoRoot);
  const target = resolve(canonicalRoot, reference);
  const relativeTarget = relative(canonicalRoot, target);
  if (!relativeTarget || relativeTarget === "." || relativeTarget === ".." || relativeTarget.startsWith(`..${sep}`) || isAbsolute(relativeTarget)) {
    throw new Error("Spec reference must point to a file inside the repository");
  }
  const canonicalTarget = realpathSync(target);
  const canonicalRelativeTarget = relative(canonicalRoot, canonicalTarget);
  if (!canonicalRelativeTarget || canonicalRelativeTarget === "." || canonicalRelativeTarget === ".." || canonicalRelativeTarget.startsWith(`..${sep}`) || isAbsolute(canonicalRelativeTarget)) {
    throw new Error("Spec reference must point to a file inside the repository");
  }
  return canonicalTarget;
}

const RESUMABLE_STAGES = new Set<WorkflowStage>([
  "plan",
  "author-tests",
  "implement",
  "independent-review",
  "verify-in-fresh-sandbox",
]);

function extractError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export class Orchestrator {
  readonly root: string;
  readonly config: FactoryConfig;
  readonly ledger: Ledger;
  readonly harness: HarnessAdapter;
  readonly worktrees: GitWorktreeManager;
  readonly testExecutor: TestExecutor;
  private readonly now: () => Date;
  private readonly codexStatusProbe: () => Promise<CodexLoginStatus>;

  constructor(root: string, options: OrchestratorOptions = {}) {
    this.root = resolve(root);
    this.config = loadFactoryConfig(this.root);
    this.ledger = options.ledger ?? initializeWorkspace(this.root);
    this.harness = options.harness ?? createHarnessAdapter(this.config, options.harnessName);
    this.worktrees = options.worktrees ?? new GitWorktreeManager(this.root, this.config.sandbox.image);
    this.testExecutor = options.testExecutor ?? new DockerTestExecutor(this.config.budgets.defaults.wall_clock_seconds * 1000);
    this.now = options.now ?? (() => new Date());
    this.codexStatusProbe = options.codexStatusProbe ?? probeCodexLoginStatus;
  }

  getCodexLoginStatus(): Promise<CodexLoginStatus> {
    return this.codexStatusProbe();
  }

  async createFromPrompt(prompt: string): Promise<NonNullable<ReturnType<Ledger["getWorkItem"]>>> {
    if (!prompt.trim()) throw new Error("A request is required");
    const id = makeId(this.now());
    const specPath = join(this.root, "specs", `${id}.md`);
    mkdirSync(dirname(specPath), { recursive: true });
    const specText = makeSpec(prompt);
    writeFileSync(specPath, specText, { flag: "wx" });
    return this.createWorkFromSpec(id, titleFromText(prompt), `specs/${id}.md`, specText);
  }

  async seed(specReference: string): Promise<NonNullable<ReturnType<Ledger["getWorkItem"]>>> {
    const canonicalRoot = realpathSync(this.root);
    const path = safeSpecPath(canonicalRoot, specReference);
    const specText = readFileSync(path, "utf8");
    const id = makeId(this.now());
    return this.createWorkFromSpec(id, parseTitle(specText), relative(canonicalRoot, path).split(sep).join("/"), specText);
  }

  private async createWorkFromSpec(id: string, title: string, specRef: string, specText: string) {
    const harness = this.config.harnesses[this.harness.name] ? this.harness.name : this.config.harnesses.default;
    const harnessConfig = this.config.harnesses[harness] as { model?: string };
    const item = this.ledger.createWorkItem({
      id,
      title,
      specRef,
      budgetTokens: this.config.budgets.defaults.tokens,
      budgetUsd: this.config.budgets.defaults.usd,
      retries: this.config.budgets.defaults.retries,
      harness,
      model: harnessConfig.model ?? "unspecified",
    });
    const promptHash = sha256(specText);
    this.recordRun({
      id: randomUUID(), workId: id, role: "Intake", stage: "intake", status: "succeeded",
      sandboxId: null, worktreePath: null, promptHash,
      input: { source: "cli", specRef }, result: { summary: "Persisted the request as the work item spec." },
      tokensUsed: 0, usdCost: 0, startedAt: this.now().toISOString(), completedAt: this.now().toISOString(),
    });
    this.ledger.updateWorkItem(id, { status: "running", currentStage: "plan", assigneeRole: "Planner" });
    return this.continueAfterPlan(id);
  }

  private recordRun(input: Omit<RunRecord, "usdUsed"> & { usdCost: number }): void {
    this.ledger.recordRun({ ...input, usdUsed: input.usdCost });
  }

  getView(workId: string): WorkItemView {
    return { item: this.ledger.getWorkItem(workId), runs: this.ledger.listRuns(workId), evidence: this.ledger.listEvidence(workId) };
  }

  async approve(workId: string, gate: Gate): Promise<NonNullable<ReturnType<Ledger["getWorkItem"]>>> {
    const item = this.ledger.getWorkItem(workId);
    if (!item) throw new Error(`Unknown work item: ${workId}`);
    const expectedStage = gate === "plan" ? "plan-gate" : "merge-gate";
    if (item.currentStage !== expectedStage || item.status !== "waiting-approval") {
      throw new Error(`Work item is not waiting at the ${gate} gate`);
    }
    if (gate === "merge") this.assertMergeReady(workId);
    const approval: ApprovalRecord = { id: randomUUID(), workId, gate, decision: "approved", reason: null, createdAt: this.now().toISOString() };
    if (gate === "plan") {
      return this.continueAfterPlan(workId, approval);
    }
    if (!this.ledger.transitionGate(approval, "merge-gate", { status: "running", assigneeRole: "Integrator" })) {
      throw new Error("Work item is not waiting at the merge gate");
    }
    return this.packageAfterMergeApproval(workId);
  }

  reject(workId: string, reason: string, expectedGate?: Gate): NonNullable<ReturnType<Ledger["getWorkItem"]>> {
    const item = this.ledger.getWorkItem(workId);
    if (!item) throw new Error(`Unknown work item: ${workId}`);
    if (item.status !== "waiting-approval" || (item.currentStage !== "plan-gate" && item.currentStage !== "merge-gate")) {
      throw new Error("Work item is not waiting at a human gate");
    }
    const gate: Gate = item.currentStage === "plan-gate" ? "plan" : "merge";
    if (expectedGate && gate !== expectedGate) throw new Error(`Work item is not waiting at the ${expectedGate} gate`);
    const transitioned = this.ledger.transitionGate(
      { id: randomUUID(), workId, gate, decision: "rejected", reason, createdAt: this.now().toISOString() },
      item.currentStage,
      { status: "rejected" },
    );
    if (!transitioned) throw new Error("Work item is no longer waiting at that human gate");
    return this.ledger.getWorkItem(workId)!;
  }

  async resume(workId: string): Promise<NonNullable<ReturnType<Ledger["getWorkItem"]>>> {
    const item = this.ledger.getWorkItem(workId);
    if (!item) throw new Error(`Unknown work item: ${workId}`);
    if (item.currentStage !== "plan" && this.ledger.latestApproval(workId, "plan")?.decision !== "approved") throw new Error("The plan gate has not been approved");
    if (item.currentStage === "merge-gate" && item.status === "waiting-approval") return item;
    if (item.currentStage === "merge-gate" && item.status === "running" && this.ledger.latestApproval(workId, "merge")?.decision === "approved") {
      return this.packageAfterMergeApproval(workId);
    }
    if (item.status !== "queued" && item.status !== "running") {
      throw new Error(`Work item in ${item.status} status cannot be resumed`);
    }
    if (!RESUMABLE_STAGES.has(item.currentStage)) {
      throw new Error(`Work item at ${item.currentStage} cannot be resumed`);
    }
    return this.continueAfterPlan(workId);
  }

  private async continueAfterPlan(workId: string, planApproval?: ApprovalRecord) {
    const owner = `control-plane:${process.pid}:${randomUUID()}`;
    const leaseTtlMs = Math.max(60_000, this.config.budgets.defaults.wall_clock_seconds * 2_000 + 60_000);
    if (!this.ledger.claimLease(workId, owner, leaseTtlMs)) throw new Error("This work item is already leased by another worker");
    let leaseLost = false;
    const renewLease = () => {
      if (leaseLost || !this.ledger.renewLease(workId, owner, leaseTtlMs)) {
        leaseLost = true;
        throw new Error("The work item lease was lost; refusing further execution");
      }
    };
    const heartbeat = setInterval(() => {
      if (leaseLost) return;
      try {
        if (!this.ledger.renewLease(workId, owner, leaseTtlMs)) leaseLost = true;
      } catch {
        leaseLost = true;
      }
    }, Math.min(30_000, Math.max(1_000, Math.floor(leaseTtlMs / 3))));
    heartbeat.unref();
    const runWhileLeased = async <T>(operation: () => Promise<T>, recordCompleted?: (result: T) => void): Promise<T> => {
      renewLease();
      const result = await operation();
      recordCompleted?.(result);
      renewLease();
      return result;
    };
    try {
      if (planApproval && !this.ledger.transitionGate(planApproval, "plan-gate", {
        status: "running", currentStage: "author-tests", assigneeRole: "Test Author",
      })) {
        throw new Error("Work item is no longer waiting at the plan gate");
      }
      let item = this.ledger.getWorkItem(workId);
      if (!item) throw new Error(`Unknown work item: ${workId}`);
      if (item.currentStage === "merge-gate" && item.status === "waiting-approval") return item;
      if ((item.status !== "queued" && item.status !== "running") || !RESUMABLE_STAGES.has(item.currentStage)) {
        throw new Error(`Work item in ${item.status} status at ${item.currentStage} cannot continue`);
      }
      if (!this.withinWallClock(workId)) return this.ledger.getWorkItem(workId)!;
      const specPath = safeSpecPath(this.root, item.specRef);
      const activeSpecRef = item.specRef;
      const specText = readFileSync(specPath, "utf8");
      const dir = evidenceDirectory(this.root, workId);

      if (item.currentStage === "plan") {
        if (this.harness.name !== "codex") {
          const startedAt = this.now().toISOString();
          const planText = planFor(specText);
          const planFile = writeEvidenceFile(this.root, workId, "plan.md", planText);
          const specFile = writeEvidenceFile(this.root, workId, "spec.md", specText);
          this.recordRun({
            id: randomUUID(), workId, role: "Planner", stage: "plan", status: "succeeded",
            sandboxId: null, worktreePath: null, promptHash: sha256(specText + "\nPlanner"),
            input: { specRef: activeSpecRef }, result: { summary: planText, changedFiles: ["plan.md"], model: "deterministic" },
            tokensUsed: 0, usdCost: 0, startedAt, completedAt: this.now().toISOString(),
          });
          this.ledger.recordEvidence({ id: randomUUID(), workId, kind: "spec", uri: makeEvidencePath(this.root, specFile.path), sha256: specFile.sha256, createdAt: this.now().toISOString() });
          this.ledger.recordEvidence({ id: randomUUID(), workId, kind: "plan", uri: makeEvidencePath(this.root, planFile.path), sha256: planFile.sha256, createdAt: this.now().toISOString() });
          return this.ledger.updateWorkItem(workId, {
            status: "waiting-approval",
            currentStage: "plan-gate",
            assigneeRole: "Planner",
            evidenceUri: makeEvidencePath(this.root, dir),
          });
        }
        renewLease();
        const sandbox = this.worktrees.create(workId, "Planner", "plan");
        const request: HarnessRequest = { role: "Planner", stage: "plan", workId, sandboxId: sandbox.sandboxId, workspacePath: sandbox.path, specText };
        const expectedPromptHash = sha256(this.harness.name === "codex" ? buildCodexPrompt(request) : specText + "\nPlanner");
        const startedAt = this.now().toISOString();
        let withinBudget = true;
        const result = await runWhileLeased(
          () => this.runHarness(request),
          (completed) => {
            withinBudget = this.ledger.recordUsage(workId, completed.tokensUsed, completed.usdCost);
            this.recordRun({
              id: randomUUID(), workId, role: "Planner", stage: "plan",
              status: completed.success ? "succeeded" : "failed", sandboxId: sandbox.sandboxId,
              worktreePath: sandbox.path, promptHash: completed.promptHash ?? expectedPromptHash,
              input: { specRef: activeSpecRef },
              result: { summary: completed.summary, changedFiles: completed.changedFiles, model: completed.model, errorCode: completed.errorCode },
              tokensUsed: completed.tokensUsed, usdCost: completed.usdCost, startedAt, completedAt: this.now().toISOString(),
            });
          },
        );
        if (!this.withinWallClock(workId)) return this.ledger.getWorkItem(workId)!;
        if (!withinBudget) return this.ledger.getWorkItem(workId)!;
        if (!result.success) return this.failStage(workId, "plan", result.summary, this.harness.name === "codex");
        if (result.changedFiles.length !== 1 || result.changedFiles[0] !== "plan.md" || !existsSync(join(sandbox.path, "plan.md"))) {
          return this.failStage(workId, "plan", "Planner must create plan.md only.", this.harness.name === "codex");
        }
        const planFile = writeEvidenceFile(this.root, workId, "plan.md", readFileSync(join(sandbox.path, "plan.md"), "utf8"));
        const specFile = writeEvidenceFile(this.root, workId, "spec.md", specText);
        this.ledger.recordEvidence({ id: randomUUID(), workId, kind: "spec", uri: makeEvidencePath(this.root, specFile.path), sha256: specFile.sha256, createdAt: this.now().toISOString() });
        this.ledger.recordEvidence({ id: randomUUID(), workId, kind: "plan", uri: makeEvidencePath(this.root, planFile.path), sha256: planFile.sha256, createdAt: this.now().toISOString() });
        return this.ledger.updateWorkItem(workId, {
          status: "waiting-approval",
          currentStage: "plan-gate",
          assigneeRole: "Planner",
          sandboxId: sandbox.sandboxId,
          evidenceUri: makeEvidencePath(this.root, dir),
        });
      }

      if (item.currentStage === "author-tests") {
        renewLease();
        const sandbox = this.worktrees.create(workId, "Test Author", "author-tests");
        const request: HarnessRequest = { role: "Test Author", stage: "author-tests", workId, sandboxId: sandbox.sandboxId, workspacePath: sandbox.path, specText };
        const expectedPromptHash = sha256(this.harness.name === "codex" ? buildCodexPrompt(request) : specText + "\nTest Author");
        const startedAt = this.now().toISOString();
        let withinBudget = true;
        const result = await runWhileLeased(
          () => this.runHarness(request),
          (completed) => {
            withinBudget = this.ledger.recordUsage(workId, completed.tokensUsed, completed.usdCost);
            this.recordRun({
              id: randomUUID(), workId, role: "Test Author", stage: "author-tests",
              status: completed.success ? "succeeded" : "failed", sandboxId: sandbox.sandboxId,
              worktreePath: sandbox.path, promptHash: completed.promptHash ?? expectedPromptHash,
              input: { specRef: activeSpecRef },
              result: { summary: completed.summary, changedFiles: completed.changedFiles, model: completed.model, errorCode: completed.errorCode },
              tokensUsed: completed.tokensUsed, usdCost: completed.usdCost, startedAt, completedAt: this.now().toISOString(),
            });
          },
        );
        if (!this.withinWallClock(workId)) return this.ledger.getWorkItem(workId)!;
        if (!withinBudget) return this.ledger.getWorkItem(workId)!;
        if (!result.success) {
          return this.failStage(workId, "author-tests", result.summary, this.harness.name === "codex");
        }
        const patch = this.worktrees.patch(sandbox.path, result.changedFiles);
        const file = writeEvidenceFile(this.root, workId, "author-tests.patch", patch);
        this.ledger.recordEvidence({ id: randomUUID(), workId, kind: "author-tests-patch", uri: makeEvidencePath(this.root, file.path), sha256: file.sha256, createdAt: this.now().toISOString() });
        this.ledger.updateWorkItem(workId, { currentStage: "implement", assigneeRole: "Implementer", sandboxId: sandbox.sandboxId });
      }

      item = this.ledger.getWorkItem(workId)!;
      if (item.currentStage === "implement") {
        renewLease();
        const sandbox = this.worktrees.create(workId, "Implementer", "implement");
        const authorPatch = readFileSync(join(dir, "author-tests.patch"), "utf8");
        this.worktrees.applyPatch(sandbox.path, authorPatch);
        const request: HarnessRequest = { role: "Implementer", stage: "implement", workId, sandboxId: sandbox.sandboxId, workspacePath: sandbox.path, specText };
        const expectedPromptHash = sha256(this.harness.name === "codex" ? buildCodexPrompt(request) : specText + "\nImplementer");
        const startedAt = this.now().toISOString();
        let withinBudget = true;
        const result = await runWhileLeased(
          () => this.runHarness(request),
          (completed) => {
            withinBudget = this.ledger.recordUsage(workId, completed.tokensUsed, completed.usdCost);
            this.recordRun({
              id: randomUUID(), workId, role: "Implementer", stage: "implement",
              status: completed.success ? "succeeded" : "failed", sandboxId: sandbox.sandboxId,
              worktreePath: sandbox.path, promptHash: completed.promptHash ?? expectedPromptHash,
              input: { specRef: activeSpecRef, authorPatchHash: sha256(authorPatch) },
              result: { summary: completed.summary, changedFiles: completed.changedFiles, model: completed.model, errorCode: completed.errorCode },
              tokensUsed: completed.tokensUsed, usdCost: completed.usdCost, startedAt, completedAt: this.now().toISOString(),
            });
          },
        );
        if (!this.withinWallClock(workId)) return this.ledger.getWorkItem(workId)!;
        if (!withinBudget) return this.ledger.getWorkItem(workId)!;
        if (!result.success) {
          return this.failStage(workId, "implement", result.summary, this.harness.name === "codex");
        }
        const implementationPatch = this.worktrees.patch(sandbox.path, result.changedFiles);
        const candidatePatch = [authorPatch, implementationPatch].filter(Boolean).join("\n");
        const implementationFile = writeEvidenceFile(this.root, workId, "implementation.patch", implementationPatch);
        const candidateFile = writeEvidenceFile(this.root, workId, "candidate.patch", candidatePatch);
        this.ledger.recordEvidence({ id: randomUUID(), workId, kind: "implementation-patch", uri: makeEvidencePath(this.root, implementationFile.path), sha256: implementationFile.sha256, createdAt: this.now().toISOString() });
        this.ledger.recordEvidence({ id: randomUUID(), workId, kind: "candidate-patch", uri: makeEvidencePath(this.root, candidateFile.path), sha256: candidateFile.sha256, createdAt: this.now().toISOString() });
        this.ledger.updateWorkItem(workId, { currentStage: "independent-review", assigneeRole: "Independent Reviewer", sandboxId: sandbox.sandboxId });
      }

      item = this.ledger.getWorkItem(workId)!;
      if (item.currentStage === "independent-review") {
        const candidatePatch = readFileSync(join(dir, "candidate.patch"), "utf8");
        const implementRun = this.ledger.listRuns(workId).findLast((run) => run.stage === "implement" && run.status === "succeeded");
        if (!implementRun?.worktreePath || !implementRun.sandboxId) throw new Error("Implementer checkpoint is missing its worktree");
        const implementationSandbox: WorktreeSandbox = {
          workId, role: "Implementer", stage: "implement", sandboxId: implementRun.sandboxId,
          image: this.config.sandbox.image, path: implementRun.worktreePath,
        };
        const startedAt = this.now().toISOString();
        let preReviewOutput = "";
        const tests = await runWhileLeased(() => this.runTests(implementationSandbox), (completed) => {
          preReviewOutput = `${completed.stdout}\n${completed.stderr}`.trim();
          this.recordRun({
            id: randomUUID(), workId, role: null, stage: "independent-review",
            status: completed.exitCode === 0 ? "succeeded" : "failed",
            sandboxId: implementationSandbox.sandboxId, worktreePath: implementationSandbox.path,
            promptHash: sha256(`${candidatePatch}\npre-review-test`), input: { command: "vitest run" },
            result: { exitCode: completed.exitCode, testOutput: preReviewOutput }, tokensUsed: 0, usdCost: 0,
            startedAt, completedAt: this.now().toISOString(),
          });
        });
        writeEvidenceFile(this.root, workId, "pre-review-test-output.txt", preReviewOutput);
        if (tests.exitCode !== 0) {
          if (!this.withinWallClock(workId)) return this.ledger.getWorkItem(workId)!;
          return this.failStage(workId, "independent-review", preReviewOutput || "Candidate tests failed");
        }
        const reviewerSandbox = this.worktrees.createReviewerContext(workId);
        const reviewerSandboxId = reviewerSandbox.sandboxId;
        const reviewRequest: HarnessRequest = {
          role: "Independent Reviewer", stage: "independent-review", workId, sandboxId: reviewerSandboxId,
          specText, diff: candidatePatch, testOutput: preReviewOutput, workspacePath: reviewerSandbox.path,
        };
        const expectedReviewPromptHash = sha256(this.harness.name === "codex" ? buildCodexPrompt(reviewRequest) : specText + "\n" + candidatePatch + "\n" + preReviewOutput);
        const reviewerStartedAt = this.now().toISOString();
        let withinBudget = true;
        const review = await runWhileLeased(() => this.runHarness(reviewRequest), (completed) => {
          withinBudget = this.ledger.recordUsage(workId, completed.tokensUsed, completed.usdCost);
          this.recordRun({
            id: randomUUID(), workId, role: "Independent Reviewer", stage: "independent-review", status: completed.success ? "succeeded" : "failed",
            sandboxId: reviewerSandboxId, worktreePath: reviewerSandbox.path, promptHash: completed.promptHash ?? expectedReviewPromptHash,
            input: { specText, diff: candidatePatch, testOutput: preReviewOutput },
            result: { approved: completed.approved ?? false, summary: completed.summary, model: completed.model, errorCode: completed.errorCode },
            tokensUsed: completed.tokensUsed, usdCost: completed.usdCost, startedAt: reviewerStartedAt, completedAt: this.now().toISOString(),
          });
        });
        if (!this.withinWallClock(workId)) return this.ledger.getWorkItem(workId)!;
        writeEvidenceFile(this.root, workId, "review.json", `${JSON.stringify({ approved: review.approved ?? false, summary: review.summary }, null, 2)}\n`);
        if (!withinBudget) return this.ledger.getWorkItem(workId)!;
        if (!review.success) return this.failStage(workId, "independent-review", review.summary, this.harness.name === "codex");
        if (!review.approved) return this.ledger.updateWorkItem(workId, { status: "rejected" });
        this.ledger.updateWorkItem(workId, { currentStage: "verify-in-fresh-sandbox", assigneeRole: null, sandboxId: reviewerSandboxId });
      }

      item = this.ledger.getWorkItem(workId)!;
      if (item.currentStage === "verify-in-fresh-sandbox") {
        renewLease();
        const candidatePatch = readFileSync(join(dir, "candidate.patch"), "utf8");
        const sandbox = this.worktrees.create(workId, "CODE", "verify-in-fresh-sandbox");
        const implementRun = this.ledger.listRuns(workId).findLast((run) => run.stage === "implement" && run.status === "succeeded");
        if (sandbox.sandboxId === implementRun?.sandboxId) throw new Error("Verification must use a fresh sandbox ID");
        this.worktrees.applyPatch(sandbox.path, candidatePatch);
        const startedAt = this.now().toISOString();
        let testOutput = "";
        const result = await runWhileLeased(() => this.runTests(sandbox), (completed) => {
          testOutput = `${completed.stdout}\n${completed.stderr}`.trim();
          this.recordRun({
            id: randomUUID(), workId, role: null, stage: "verify-in-fresh-sandbox",
            status: completed.exitCode === 0 ? "succeeded" : "failed", sandboxId: sandbox.sandboxId,
            worktreePath: sandbox.path, promptHash: sha256(candidatePatch), input: { candidatePatchHash: sha256(candidatePatch) },
            result: { exitCode: completed.exitCode, testOutput }, tokensUsed: 0, usdCost: 0,
            startedAt, completedAt: this.now().toISOString(),
          });
        });
        const testFile = writeEvidenceFile(this.root, workId, "test-output.txt", testOutput);
        this.ledger.recordEvidence({ id: randomUUID(), workId, kind: "verify-test-output", uri: makeEvidencePath(this.root, testFile.path), sha256: testFile.sha256, createdAt: this.now().toISOString() });
        if (!this.withinWallClock(workId)) return this.ledger.getWorkItem(workId)!;
        if (result.exitCode !== 0) return this.failStage(workId, "verify-in-fresh-sandbox", testOutput || "Fresh verification failed");
        this.ledger.updateWorkItem(workId, { status: "waiting-approval", currentStage: "merge-gate", assigneeRole: "Integrator", sandboxId: sandbox.sandboxId });
      }
      return this.ledger.getWorkItem(workId)!;
    } finally {
      clearInterval(heartbeat);
      this.ledger.releaseLease(workId, owner);
    }
  }

  private failStage(workId: string, stage: WorkflowStage, reason: string, throwOnDeadLetter = false) {
    const retry = this.ledger.recordFailure(workId);
    if (retry.deadLetter) {
      if (throwOnDeadLetter) throw new Error("Stage " + stage + " dead-lettered after retries: " + reason);
      return this.ledger.getWorkItem(workId)!;
    }
    this.ledger.updateWorkItem(workId, { status: "queued", currentStage: stage });
    throw new Error(`Stage ${stage} stopped and can be resumed (${retry.retryCount}/${this.ledger.getWorkItem(workId)!.retries} retries): ${reason}`);
  }

  private async runHarness(request: HarnessRequest): Promise<HarnessResult> {
    try {
      return await this.harness.run(request);
    } catch (error) {
      return {
        success: false, changedFiles: [], tokensUsed: 0, usdCost: 0, summary: extractError(error),
        errorCode: error instanceof CodexHarnessError ? error.code : undefined,
      };
    }
  }

  private async runTests(worktree: WorktreeSandbox): Promise<TestResult> {
    try {
      return await this.testExecutor.run(worktree, this.root);
    } catch (error) {
      return { exitCode: 1, stdout: "", stderr: extractError(error) };
    }
  }

  private withinWallClock(workId: string): boolean {
    const elapsedMs = this.ledger.listRuns(workId).reduce((sum, run) => {
      if (!run.completedAt) return sum;
      const duration = Date.parse(run.completedAt) - Date.parse(run.startedAt);
      return sum + Math.max(0, Number.isFinite(duration) ? duration : 0);
    }, 0);
    if (elapsedMs <= this.config.budgets.defaults.wall_clock_seconds * 1000) return true;
    this.ledger.updateWorkItem(workId, { status: "dead-letter" });
    return false;
  }

  private assertMergeReady(workId: string): void {
    const runs = this.ledger.listRuns(workId);
    const review = runs.findLast((run) => run.stage === "independent-review" && run.status === "succeeded");
    const verify = runs.findLast((run) => run.stage === "verify-in-fresh-sandbox" && run.status === "succeeded");
    if (!review || review.result.approved !== true || !verify) throw new Error("Merge gate is closed until independent review approves and fresh verification passes");
    const implement = runs.findLast((run) => run.stage === "implement" && run.status === "succeeded");
    if (implement?.sandboxId && implement.sandboxId === verify.sandboxId) throw new Error("Verification did not use a fresh sandbox");
  }

  private packageAfterMergeApproval(workId: string) {
    const owner = `integrator:${process.pid}:${randomUUID()}`;
    if (!this.ledger.claimLease(workId, owner, 60_000)) throw new Error("This work item is already leased by another worker");
    try {
      const item = this.ledger.getWorkItem(workId);
      if (!item || item.status !== "running" || item.currentStage !== "merge-gate" || this.ledger.latestApproval(workId, "merge")?.decision !== "approved") {
        throw new Error("Work item does not have an active merge approval");
      }
      return this.packageBundle(workId);
    } finally {
      this.ledger.releaseLease(workId, owner);
    }
  }

  private packageBundle(workId: string) {
    this.assertMergeReady(workId);
    const item = this.ledger.getWorkItem(workId)!;
    const dir = evidenceDirectory(this.root, workId);
    const candidatePatch = readFileSync(join(dir, "candidate.patch"), "utf8");
    const runs = this.ledger.listRuns(workId);
    const patchFile = writeEvidenceFile(this.root, workId, "patch.diff", candidatePatch);
    const bundleText = `# Local draft bundle: ${item.title}\n\n- Work item: ${workId}\n- Spec: ${item.specRef}\n- Verified test output: test-output.txt\n- Provenance: provenance.json\n\nThis bundle is local evidence. Forge did not open a remote pull request or merge code.\n`;
    const bundleFile = writeEvidenceFile(this.root, workId, "draft-pr.md", bundleText);
    const existingFiles = [
      patchFile.path, bundleFile.path, join(dir, "plan.md"), join(dir, "pre-review-test-output.txt"),
      join(dir, "test-output.txt"), join(dir, "review.json"),
    ].filter((path) => existsSync(path)).map((path) => makeEvidencePath(this.root, path));
    const evidencePaths = [...new Set([
      ...this.ledger.listEvidence(workId).map((record) => record.uri),
      ...existingFiles,
      makeEvidencePath(this.root, join(dir, "provenance.json")),
    ])];
    const provenance: ProvenanceRecord = {
      version: 1,
      workId,
      model: runs.findLast((run) => typeof run.result.model === "string")?.result.model as string ?? item.model,
      harness: item.harness,
      promptHash: runs.find((run) => run.stage === "intake")?.promptHash ?? sha256(readFileSync(safeSpecPath(this.root, item.specRef))),
      sandboxIds: [...new Set(runs.map((run) => run.sandboxId).filter((id): id is string => Boolean(id)))],
      evidencePaths,
      stages: runs.map((run) => ({
        role: run.role, stage: run.stage, harness: item.harness,
        model: typeof run.result.model === "string" ? run.result.model : item.model,
        promptHash: run.promptHash, sandboxId: run.sandboxId, worktreePath: run.worktreePath,
      })),
      createdAt: this.now().toISOString(),
    };
    const provenanceFile = writeProvenance(this.root, provenance);
    for (const file of [patchFile, bundleFile, provenanceFile]) {
      this.ledger.recordEvidence({ id: randomUUID(), workId, kind: relative(this.root, file.path).split(sep).pop() ?? "bundle", uri: makeEvidencePath(this.root, file.path), sha256: file.sha256, createdAt: this.now().toISOString() });
    }
    return this.ledger.updateWorkItem(workId, {
      status: "completed", currentStage: "complete", assigneeRole: "Integrator",
      evidenceUri: makeEvidencePath(this.root, dir),
    });
  }
}
