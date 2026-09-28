import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeProvenance } from "evidence";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("provenance writer", () => {
  it("records the work, harness, model, prompt hash, sandbox IDs, and evidence paths", () => {
    const root = mkdtempSync(join(tmpdir(), "forge-evidence-"));
    roots.push(root);
    const file = writeProvenance(root, {
      version: 1,
      workId: "forge-1",
      harness: "stub",
      model: "deterministic",
      promptHash: "a".repeat(64),
      sandboxIds: ["sandbox-author", "sandbox-implement", "sandbox-verify"],
      evidencePaths: ["evidence/runs/forge-1/patch.diff", "evidence/runs/forge-1/test-output.txt"],
      stages: [{ role: "Implementer", stage: "implement", harness: "stub", model: "deterministic", promptHash: "b".repeat(64), sandboxId: "sandbox-implement", worktreePath: ".forge/worktrees/forge-1/implement" }],
      createdAt: new Date(0).toISOString(),
    });

    const record = JSON.parse(readFileSync(file.path, "utf8")) as Record<string, unknown>;
    expect(record).toMatchObject({ workId: "forge-1", harness: "stub", model: "deterministic", promptHash: "a".repeat(64) });
    expect(record.sandboxIds).toEqual(["sandbox-author", "sandbox-implement", "sandbox-verify"]);
    expect(record.evidencePaths).toContain("evidence/runs/forge-1/patch.diff");
    expect(file.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects evidence paths that escape a work item's evidence directory", () => {
    const root = mkdtempSync(join(tmpdir(), "forge-evidence-path-"));
    roots.push(root);
    expect(() => writeProvenance(root, {
      version: 1, workId: "../other", harness: "stub", model: "deterministic", promptHash: "hash",
      sandboxIds: [], evidencePaths: [], stages: [], createdAt: new Date().toISOString(),
    })).toThrow(/Invalid work item id/);
  });
});
