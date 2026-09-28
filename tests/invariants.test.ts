import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadFactoryConfig } from "control-plane";
import { Ledger, ROLES } from "ledger";
import { assertSafeSandboxEnvironment, dockerRunArgs, reviewerInput, sandboxEnvironment } from "worker";

const temporaryRoots: string[] = [];
const openLedgers: Ledger[] = [];

afterEach(() => {
  for (const ledger of openLedgers.splice(0)) ledger.close();
  for (const path of temporaryRoots.splice(0)) rmSync(path, { recursive: true, force: true });
});

function makeLedger() {
  const dir = mkdtempSync(join(tmpdir(), "forge-ledger-"));
  temporaryRoots.push(dir);
  const ledger = new Ledger(join(dir, "forge.db"));
  openLedgers.push(ledger);
  ledger.createWorkItem({ id: "work-1", title: "example", specRef: "specs/example.md", budgetTokens: 10, budgetUsd: 1, retries: 1, harness: "stub", model: "deterministic" });
  return { ledger, dir };
}

describe("factory invariants", () => {
  it("locks the exact roles, stages, gates, and sandbox image", () => {
    const config = loadFactoryConfig(process.cwd());
    expect(config.roles).toEqual([...ROLES]);
    expect(config.harnesses.default).toBe("stub");
    expect(config.harnesses.codex).toMatchObject({ adapter: "CodexHarness" });
    expect(config.graph.map((node) => node.stage)).toContain("verify-in-fresh-sandbox");
    expect(config.gates).toEqual({ plan: "required", merge: "required" });
    expect(config.sandbox).toMatchObject({ image: "node:22-bookworm-slim", network: "none", read_only_root: true });
    expect(config.merge_policy).toMatchObject({ auto_merge: false, force_push: false });
  });

  it("passes only safe metadata into a sandbox and refuses secret-shaped variables", () => {
    const env = sandboxEnvironment({ workId: "work-1", role: "Implementer", sandboxId: "sbx-1" });
    expect(Object.keys(env).sort()).toEqual(["CI", "FORGE_ROLE", "FORGE_SANDBOX_ID", "FORGE_WORK_ID"]);
    expect(() => assertSafeSandboxEnvironment({ ...env, FORGE_API_KEY: "not-a-real-key" })).toThrow(/not allowlisted/);
    expect(JSON.stringify(env)).not.toMatch(/CODEX_|OPENAI_API_KEY|\.codex/i);
    const args = dockerRunArgs({ workId: "work-1", role: "Implementer", stage: "implement", sandboxId: "sbx-1", image: "node:22-bookworm-slim" }, "C:\\jobs\\one", ["node", "--version"]);
    expect(args.join(" ")).toContain("--network=none");
    expect(args.join(" ")).toContain("--read-only");
    expect(args.join(" ")).not.toMatch(/API_KEY|FORGE_SECRET|CODEX_|OPENAI_API_KEY|\.codex|--env-file/i);
    expect(() => dockerRunArgs({ workId: "work-1", role: "Implementer", stage: "implement", sandboxId: "sbx-1", image: "some-other-image" }, ".", ["node"])).toThrow(/one approved/);
  });

  it("gives the independent reviewer only its allowed input", () => {
    const input = reviewerInput({ role: "Independent Reviewer", stage: "independent-review", workId: "work-1", sandboxId: "sbx-review", specText: "spec", diff: "diff", testOutput: "1 test passed" });
    expect(Object.keys(input).sort()).toEqual(["diff", "role", "sandboxId", "specText", "stage", "testOutput", "workId"].sort());
  });
});

describe("SQLite ledger invariants", () => {
  it("allows one live lease, renews only for its owner, and reclaims an expired lease", () => {
    const { ledger, dir } = makeLedger();
    const otherWorker = new Ledger(join(dir, "forge.db"));
    openLedgers.push(otherWorker);
    const now = 10_000;
    expect(ledger.claimLease("work-1", "worker-a", 1000, now)).toBe(true);
    expect(otherWorker.claimLease("work-1", "worker-b", 1000, now + 10)).toBe(false);
    expect(ledger.renewLease("work-1", "worker-a", 1000, now + 500)).toBe(true);
    expect(otherWorker.renewLease("work-1", "worker-b", 1000, now + 600)).toBe(false);
    expect(otherWorker.claimLease("work-1", "worker-b", 1000, now + 1001)).toBe(false);
    expect(otherWorker.claimLease("work-1", "worker-b", 1000, now + 1500)).toBe(true);
    expect(ledger.renewLease("work-1", "worker-a", 1000, now + 1501)).toBe(false);
    expect(ledger.releaseLease("work-1", "worker-a")).toBe(false);
  });

  it("records exactly one gate decision when callers race on a stale gate view", () => {
    const { ledger, dir } = makeLedger();
    const otherWorker = new Ledger(join(dir, "forge.db"));
    openLedgers.push(otherWorker);
    ledger.updateWorkItem("work-1", { status: "waiting-approval", currentStage: "plan-gate" });
    const approved = { id: "approval-a", workId: "work-1", gate: "plan" as const, decision: "approved" as const, reason: null, createdAt: "2026-01-01T00:00:00.000Z" };
    const rejected = { id: "approval-b", workId: "work-1", gate: "plan" as const, decision: "rejected" as const, reason: "revoked", createdAt: "2026-01-01T00:00:01.000Z" };

    const outcomes = [
      ledger.transitionGate(approved, "plan-gate", { status: "running", currentStage: "author-tests" }),
      otherWorker.transitionGate(rejected, "plan-gate", { status: "rejected" }),
    ];
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    expect(ledger.latestApproval("work-1", "plan")?.decision).toBe("approved");
    expect(ledger.getWorkItem("work-1")).toMatchObject({ status: "running", currentStage: "author-tests" });
  });

  it("dead-letters invalid usage reports without allowing negative totals", () => {
    const { ledger } = makeLedger();
    const invalidUsage: Array<[number, number]> = [[-1, 0], [0, -0.01], [Number.NaN, 0], [1.5, 0], [0, Number.POSITIVE_INFINITY]];
    invalidUsage.forEach(([tokens, usd], index) => {
      const id = `invalid-${index}`;
      ledger.createWorkItem({ id, title: id, specRef: "specs/example.md", budgetTokens: 10, budgetUsd: 1, retries: 1, harness: "stub", model: "deterministic" });
      expect(ledger.recordUsage(id, tokens, usd)).toBe(false);
      expect(ledger.getWorkItem(id)).toMatchObject({ status: "dead-letter", tokensUsed: 0, usdUsed: 0 });
    });
  });

  it("dead-letters work when its token budget or retry cap is exceeded", () => {
    const { ledger } = makeLedger();
    expect(ledger.recordUsage("work-1", 11, 0)).toBe(false);
    expect(ledger.getWorkItem("work-1")?.status).toBe("dead-letter");

    ledger.createWorkItem({ id: "work-2", title: "retry", specRef: "specs/retry.md", budgetTokens: 10, budgetUsd: 1, retries: 1, harness: "stub", model: "deterministic" });
    expect(ledger.recordFailure("work-2")).toMatchObject({ retryCount: 1, deadLetter: false });
    expect(ledger.recordFailure("work-2")).toMatchObject({ retryCount: 2, deadLetter: true });
    expect(ledger.getWorkItem("work-2")?.status).toBe("dead-letter");
  });
});
