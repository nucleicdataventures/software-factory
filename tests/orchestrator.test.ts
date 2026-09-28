import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initializeWorkspace, Orchestrator, type TestExecutor } from "control-plane";
import { Ledger } from "ledger";
import { GitWorktreeManager, StubHarness, type HarnessRequest } from "worker";

const repositoryRoot = process.cwd();
const roots: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixtureRepository(): string {
  const root = mkdtempSync(join(tmpdir(), "forge-orchestrator-"));
  roots.push(root);
  mkdirSync(join(root, "workflows"), { recursive: true });
  mkdirSync(join(root, "demo-app", "src"), { recursive: true });
  copyFileSync(join(repositoryRoot, "factory.yaml"), join(root, "factory.yaml"));
  copyFileSync(join(repositoryRoot, "workflows", "default.yaml"), join(root, "workflows", "default.yaml"));
  copyFileSync(join(repositoryRoot, "demo-app", "src", "app.ts"), join(root, "demo-app", "src", "app.ts"));
  writeFileSync(join(root, ".gitignore"), ".forge/\nevidence/runs/\n");
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Forge Tests"], { cwd: root });
  execFileSync("git", ["config", "user.email", "forge-tests@example.invalid"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-m", "fixture", "-q"], { cwd: root });
  return root;
}

describe("orchestrator", () => {
  it("initializes the SQLite ledger and demo app without overwriting existing files", () => {
    const root = mkdtempSync(join(tmpdir(), "forge-init-"));
    roots.push(root);
    const ledger = initializeWorkspace(root);
    expect(existsSync(join(root, ".forge", "forge.db"))).toBe(true);
    expect(existsSync(join(root, "demo-app", "src", "app.ts"))).toBe(true);
    expect(existsSync(join(root, "demo-app", "tests", "app.test.ts"))).toBe(true);
    ledger.close();
  });

  it("persists a request and stops at the plan gate", async () => {
    const root = fixtureRepository();
    const ledger = new Ledger(":memory:");
    const executor: TestExecutor = { async run() { throw new Error("not reached before plan approval"); } };
    const orchestrator = new Orchestrator(root, { ledger, worktrees: new GitWorktreeManager(root), testExecutor: executor });

    const item = await orchestrator.createFromPrompt("add a GET /health endpoint to demo-app");
    expect(item.status).toBe("waiting-approval");
    expect(item.currentStage).toBe("plan-gate");
    expect(readFileSync(join(root, item.specRef), "utf8")).toContain("GET /health");
    expect(readFileSync(join(root, item.evidenceUri!, "plan.md"), "utf8")).toContain("Task DAG");
    expect(ledger.getWorkItem(item.id)?.id).toBe(item.id);
    expect(ledger.listRuns(item.id).map((run) => run.stage)).toEqual(["intake", "plan"]);
    ledger.close();
  });

  it("keeps the merge gate closed when either review or fresh verification is missing", async () => {
    const root = fixtureRepository();
    const ledger = new Ledger(":memory:");
    const orchestrator = new Orchestrator(root, { ledger, worktrees: new GitWorktreeManager(root) });
    const item = await orchestrator.createFromPrompt("add a GET /health endpoint to demo-app");
    ledger.updateWorkItem(item.id, { status: "waiting-approval", currentStage: "merge-gate" });

    await expect(orchestrator.approve(item.id, "merge")).rejects.toThrow(/Merge gate is closed/);
    expect(ledger.latestApproval(item.id, "merge")).toBeNull();
    ledger.close();
  });

  it("dead-letters a run when active stage time exceeds the wall-clock budget", async () => {
    const root = fixtureRepository();
    const factoryPath = join(root, "factory.yaml");
    writeFileSync(factoryPath, readFileSync(factoryPath, "utf8").replace("wall_clock_seconds: 1800", "wall_clock_seconds: 1"));
    const ledger = new Ledger(":memory:");
    let tick = 1_800_000_000_000;
    const orchestrator = new Orchestrator(root, {
      ledger,
      worktrees: new GitWorktreeManager(root),
      now: () => new Date(tick += 700),
    });
    const item = await orchestrator.createFromPrompt("add a GET /health endpoint to demo-app");
    const stopped = await orchestrator.approve(item.id, "plan");
    expect(stopped.status).toBe("dead-letter");
    expect(ledger.listRuns(item.id)).toHaveLength(2);
    await expect(orchestrator.resume(item.id)).rejects.toThrow(/dead-letter status cannot be resumed/);
    expect(ledger.listRuns(item.id)).toHaveLength(2);
    ledger.close();
  });

  it("does not rerun a reviewer-rejected item", async () => {
    const root = fixtureRepository();
    const ledger = new Ledger(":memory:");
    const executor: TestExecutor = { async run() { return { exitCode: 0, stdout: "1 test passed", stderr: "" }; } };
    const baseHarness = new StubHarness();
    const harness = {
      name: "rejecting-stub",
      async run(request: HarnessRequest) {
        if (request.stage === "independent-review") {
          return { success: true, changedFiles: [], tokensUsed: 7, usdCost: 0.25, summary: "Review rejected", approved: false };
        }
        return baseHarness.run(request);
      },
    };
    const orchestrator = new Orchestrator(root, { ledger, harness, worktrees: new GitWorktreeManager(root), testExecutor: executor });
    const plan = await orchestrator.createFromPrompt("add a GET /health endpoint to demo-app");
    const rejected = await orchestrator.approve(plan.id, "plan");
    const runCount = ledger.listRuns(plan.id).length;
    expect(rejected.status).toBe("rejected");

    await expect(orchestrator.resume(plan.id)).rejects.toThrow(/rejected status cannot be resumed/);
    expect(ledger.listRuns(plan.id)).toHaveLength(runCount);
    expect(ledger.getWorkItem(plan.id)).toMatchObject({ status: "rejected", tokensUsed: 9, usdUsed: 0.25 });
    ledger.close();
  });

  it("resumes a queued retry after a recoverable stage failure", async () => {
    const root = fixtureRepository();
    const ledger = new Ledger(":memory:");
    const executor: TestExecutor = { async run() { return { exitCode: 0, stdout: "1 test passed", stderr: "" }; } };
    const baseHarness = new StubHarness();
    let failFirstAuthorRun = true;
    const harness = {
      name: "retrying-stub",
      async run(request: HarnessRequest) {
        if (request.stage === "author-tests" && failFirstAuthorRun) {
          failFirstAuthorRun = false;
          return { success: false, changedFiles: [], tokensUsed: 7, usdCost: 0.25, summary: "Temporary author failure" };
        }
        return baseHarness.run(request);
      },
    };
    const orchestrator = new Orchestrator(root, { ledger, harness, worktrees: new GitWorktreeManager(root), testExecutor: executor });
    const plan = await orchestrator.createFromPrompt("add a GET /health endpoint to demo-app");

    await expect(orchestrator.approve(plan.id, "plan")).rejects.toThrow(/can be resumed/);
    expect(ledger.getWorkItem(plan.id)).toMatchObject({ status: "queued", currentStage: "author-tests" });
    const resumed = await orchestrator.resume(plan.id);
    expect(resumed).toMatchObject({ status: "waiting-approval", currentStage: "merge-gate" });
    expect(ledger.getWorkItem(plan.id)?.retryCount).toBe(1);
    expect(ledger.getWorkItem(plan.id)).toMatchObject({ tokensUsed: 10, usdUsed: 0.25 });
    ledger.close();
  });

  it("charges failed harness usage and dead-letters before another over-budget retry", async () => {
    const root = fixtureRepository();
    const factoryPath = join(root, "factory.yaml");
    writeFileSync(factoryPath, readFileSync(factoryPath, "utf8").replace("tokens: 30000", "tokens: 10"));
    const ledger = new Ledger(":memory:");
    const harness = {
      name: "over-budget-failure",
      async run() {
        return { success: false, changedFiles: [], tokensUsed: 6, usdCost: 0.25, summary: "Repeated failed stage" };
      },
    };
    const orchestrator = new Orchestrator(root, { ledger, harness, worktrees: new GitWorktreeManager(root) });
    const plan = await orchestrator.createFromPrompt("add a GET /health endpoint to demo-app");

    await expect(orchestrator.approve(plan.id, "plan")).rejects.toThrow(/can be resumed/);
    expect(ledger.getWorkItem(plan.id)).toMatchObject({ status: "queued", tokensUsed: 6, retryCount: 1 });
    const stopped = await orchestrator.resume(plan.id);
    expect(stopped).toMatchObject({ status: "dead-letter", tokensUsed: 12, retryCount: 1 });
    await expect(orchestrator.resume(plan.id)).rejects.toThrow(/dead-letter status cannot be resumed/);
    ledger.close();
  });

  it("counts a slow failed harness call against the wall-clock budget", async () => {
    const root = fixtureRepository();
    const factoryPath = join(root, "factory.yaml");
    writeFileSync(factoryPath, readFileSync(factoryPath, "utf8").replace("wall_clock_seconds: 1800", "wall_clock_seconds: 1"));
    const ledger = new Ledger(":memory:");
    const harness = {
      name: "slow-failed-stage",
      async run() {
        await new Promise((resolve) => setTimeout(resolve, 1_100));
        return { success: false, changedFiles: [], tokensUsed: 2, usdCost: 0.1, summary: "Slow stage failure" };
      },
    };
    const orchestrator = new Orchestrator(root, { ledger, harness, worktrees: new GitWorktreeManager(root) });
    const plan = await orchestrator.createFromPrompt("add a GET /health endpoint to demo-app");

    const stopped = await orchestrator.approve(plan.id, "plan");
    expect(stopped.status).toBe("dead-letter");
    expect(ledger.getWorkItem(plan.id)).toMatchObject({ status: "dead-letter", tokensUsed: 2, usdUsed: 0.1, retryCount: 0 });
    expect(ledger.listRuns(plan.id).find((run) => run.stage === "author-tests" && run.status === "failed")).toBeDefined();
    await expect(orchestrator.resume(plan.id)).rejects.toThrow(/dead-letter status cannot be resumed/);
    ledger.close();
  });

  it("persists paid harness usage before refusing writes after lease loss", async () => {
    const root = fixtureRepository();
    const ledgerPath = join(root, ".forge", "forge.db");
    const ledger = new Ledger(ledgerPath);
    const otherWorker = new Ledger(ledgerPath);
    let finishHarness: ((result: { success: boolean; changedFiles: string[]; tokensUsed: number; usdCost: number; summary: string }) => void) | undefined;
    let signalHarnessStart: (() => void) | undefined;
    const harnessStarted = new Promise<void>((resolve) => { signalHarnessStart = resolve; });
    const harness = {
      name: "held-harness",
      async run(request: HarnessRequest) {
        if (request.stage === "author-tests") {
          signalHarnessStart?.();
          return new Promise<Awaited<ReturnType<StubHarness["run"]>>>((resolve) => {
            finishHarness = resolve;
          });
        }
        return new StubHarness().run(request);
      },
    };
    const orchestrator = new Orchestrator(root, { ledger, harness, worktrees: new GitWorktreeManager(root) });
    const plan = await orchestrator.createFromPrompt("add a GET /health endpoint to demo-app");
    const activeRun = orchestrator.approve(plan.id, "plan");
    await harnessStarted;

    otherWorker.database.prepare("UPDATE leases SET owner=?,expires_at=? WHERE work_id=?")
      .run("replacement-worker", Date.now() + 60_000, plan.id);
    finishHarness?.({ success: false, changedFiles: [], tokensUsed: 4, usdCost: 0.2, summary: "Paid failure after lease loss" });

    await expect(activeRun).rejects.toThrow(/lease was lost/);
    expect(ledger.getWorkItem(plan.id)).toMatchObject({ status: "running", currentStage: "author-tests", tokensUsed: 4, usdUsed: 0.2 });
    expect(ledger.listRuns(plan.id).find((run) => run.stage === "author-tests" && run.status === "failed")).toBeDefined();
    expect(ledger.listEvidence(plan.id).some((record) => record.kind === "author-tests-patch")).toBe(false);
    otherWorker.close();
    ledger.close();
  });

  it("keeps a work item leased while a long asynchronous stage is active", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const root = fixtureRepository();
    const factoryPath = join(root, "factory.yaml");
    writeFileSync(factoryPath, readFileSync(factoryPath, "utf8").replace("wall_clock_seconds: 1800", "wall_clock_seconds: 1"));
    const ledgerPath = join(root, ".forge", "forge.db");
    const ledger = new Ledger(ledgerPath);
    const otherWorker = new Ledger(ledgerPath);
    let finishTests: ((result: { exitCode: number; stdout: string; stderr: string }) => void) | undefined;
    let signalTestStart: (() => void) | undefined;
    const testStarted = new Promise<void>((resolve) => { signalTestStart = resolve; });
    const executor: TestExecutor = {
      run() {
        signalTestStart?.();
        return new Promise((resolve) => { finishTests = resolve; });
      },
    };
    const orchestrator = new Orchestrator(root, { ledger, worktrees: new GitWorktreeManager(root), testExecutor: executor });
    const plan = await orchestrator.createFromPrompt("add a GET /health endpoint to demo-app");
    const activeRun = orchestrator.approve(plan.id, "plan");
    await testStarted;

    await vi.advanceTimersByTimeAsync(61_000);
    expect(otherWorker.claimLease(plan.id, "competitor", 1000, Date.now())).toBe(false);

    finishTests?.({ exitCode: 0, stdout: "1 test passed", stderr: "" });
    expect(finishTests).toBeTypeOf("function");
    expect((await activeRun).status).toBe("dead-letter");
    expect(otherWorker.claimLease(plan.id, "competitor", 1000, Date.now())).toBe(true);
    otherWorker.close();
    ledger.close();
  });

  it("keeps tracked secret files out of a fresh worker worktree", () => {
    const root = fixtureRepository();
    writeFileSync(join(root, ".env"), "FORGE_API_KEY=not-a-real-key\n");
    execFileSync("git", ["add", ".env"], { cwd: root });
    execFileSync("git", ["commit", "-m", "tracked secret fixture", "-q"], { cwd: root });
    const manager = new GitWorktreeManager(root);
    const sandbox = manager.create("work-secret", "Test Author", "author-tests");

    expect(existsSync(join(sandbox.path, ".env"))).toBe(false);
    expect(existsSync(join(sandbox.path, "demo-app", "src", "app.ts"))).toBe(true);
    expect(existsSync(join(sandbox.path, ".git"))).toBe(true);
    const changedApp = join(sandbox.path, "demo-app", "src", "app.ts");
    writeFileSync(changedApp, `${readFileSync(changedApp, "utf8")}\n// verified worktree edit\n`);
    expect(manager.patch(sandbox.path, ["demo-app/src/app.ts"])).toContain("verified worktree edit");
  });

  it("allows in-repository seed files and rejects symlinks that resolve outside", async () => {
    const root = fixtureRepository();
    const specs = join(root, "specs");
    mkdirSync(specs, { recursive: true });
    const specPath = join(specs, "valid.md");
    writeFileSync(specPath, "# Valid spec\n\nKeep the seed inside the repository.\n");
    symlinkSync(specs, join(root, "specs-alias"), "junction");

    const outside = mkdtempSync(join(tmpdir(), "forge-outside-spec-"));
    roots.push(outside);
    writeFileSync(join(outside, "private.md"), "# Outside secret\n");
    symlinkSync(outside, join(root, "outside-specs"), "junction");

    const ledger = new Ledger(":memory:");
    const orchestrator = new Orchestrator(root, { ledger, worktrees: new GitWorktreeManager(root) });
    const regular = await orchestrator.seed(specPath);
    const internalLink = await orchestrator.seed("specs-alias/valid.md");
    expect(regular.specRef).toBe("specs/valid.md");
    expect(internalLink.specRef).toBe("specs/valid.md");

    await expect(orchestrator.seed("outside-specs/private.md")).rejects.toThrow(/inside the repository/);
    expect(ledger.listWorkItems()).toHaveLength(2);
    expect(readFileSync(join(root, regular.evidenceUri!, "spec.md"), "utf8")).toContain("Keep the seed inside the repository");
    ledger.close();
  });

  it("creates a real health patch in isolated worktrees and keeps merge behind both gates", async () => {
    const root = fixtureRepository();
    const ledger = new Ledger(":memory:");
    const executor: TestExecutor = { async run() { return { exitCode: 0, stdout: "1 test passed", stderr: "" }; } };
    const orchestrator = new Orchestrator(root, { ledger, worktrees: new GitWorktreeManager(root), testExecutor: executor });
    const plan = await orchestrator.createFromPrompt("add a GET /health endpoint to demo-app");

    await expect(orchestrator.approve(plan.id, "merge")).rejects.toThrow(/not waiting at the merge gate/);
    const waiting = await orchestrator.approve(plan.id, "plan");
    expect(waiting.currentStage).toBe("merge-gate");
    expect(waiting.status).toBe("waiting-approval");

    const runs = ledger.listRuns(plan.id);
    const implementation = runs.find((run) => run.stage === "implement")!;
    const verification = runs.find((run) => run.stage === "verify-in-fresh-sandbox")!;
    expect(implementation.sandboxId).not.toBe(verification.sandboxId);
    expect(implementation.worktreePath).not.toBe(verification.worktreePath);
    const reviewer = runs.find((run) => run.role === "Independent Reviewer")!;
    expect(reviewer.input).toEqual(expect.objectContaining({ specText: expect.any(String), diff: expect.stringContaining("/health"), testOutput: expect.stringContaining("passed") }));
    expect(reviewer.input).not.toHaveProperty("implementerTranscript");
    expect(readdirSync(reviewer.worktreePath!)).toEqual([]);

    const completed = await orchestrator.approve(plan.id, "merge");
    expect(completed.status).toBe("completed");
    const patch = readFileSync(join(root, completed.evidenceUri!, "patch.diff"), "utf8");
    expect(patch).toContain('app.get("/health"');
    const provenance = JSON.parse(readFileSync(join(root, completed.evidenceUri!, "provenance.json"), "utf8")) as Record<string, unknown>;
    expect(provenance).toMatchObject({ workId: plan.id, harness: "stub", model: "deterministic" });
    expect(provenance).toHaveProperty("promptHash");
    expect(provenance).toHaveProperty("sandboxIds");
    expect(provenance).toHaveProperty("evidencePaths");
    ledger.close();
  });

  it("resumes draft packaging after a crash between merge approval and the bundle write", async () => {
    const root = fixtureRepository();
    const ledger = new Ledger(":memory:");
    const executor: TestExecutor = { async run() { return { exitCode: 0, stdout: "1 test passed", stderr: "" }; } };
    const orchestrator = new Orchestrator(root, { ledger, worktrees: new GitWorktreeManager(root), testExecutor: executor });
    const plan = await orchestrator.createFromPrompt("add a GET /health endpoint to demo-app");
    const waiting = await orchestrator.approve(plan.id, "plan");
    expect(waiting).toMatchObject({ status: "waiting-approval", currentStage: "merge-gate" });
    expect(ledger.transitionGate({
      id: "simulated-merge-approval", workId: plan.id, gate: "merge", decision: "approved", reason: null, createdAt: new Date().toISOString(),
    }, "merge-gate", { status: "running", assigneeRole: "Integrator" })).toBe(true);

    const completed = await orchestrator.resume(plan.id);
    expect(completed).toMatchObject({ status: "completed", currentStage: "complete" });
    expect(existsSync(join(root, completed.evidenceUri!, "provenance.json"))).toBe(true);
    ledger.close();
  });
});
