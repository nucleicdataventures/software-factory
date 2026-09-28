import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadFactoryConfig, resolveHarnessName } from "control-plane";
import {
  buildCodexExecArgs,
  buildCodexPrompt,
  CodexHarness,
  probeCodexLoginStatus,
  reviewerInput,
  type HarnessRequest,
  type ReviewerRequest,
} from "worker";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function implementRequest(workspacePath: string): HarnessRequest {
  return {
    role: "Implementer",
    stage: "implement",
    workId: "forge-test",
    sandboxId: "sbx-implement",
    workspacePath,
    specText: "Add a GET /health endpoint.",
  };
}

describe("CodexHarness", () => {
  it("builds a writable Implementer command scoped to its job worktree", () => {
    const worktree = join(tmpdir(), "forge-codex-implement");
    const args = buildCodexExecArgs(implementRequest(worktree), "Implement the spec.");
    expect(args).toContain("--ephemeral");
    expect(args).toContain("--json");
    expect(args).toContain("--sandbox");
    expect(args).toContain("workspace-write");
    expect(args).toContain("-C");
    expect(args[args.indexOf("-C") + 1]).toBe(resolve(worktree));
    expect(args).toContain('approval_policy="never"');
    expect(args).not.toContain("--yolo");
    expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
  });

  it("runs the host CLI with the generated args and records usage, model, and prompt hash", async () => {
    const root = mkdtempSync(join(tmpdir(), "forge-codex-harness-"));
    roots.push(root);
    let capturedArgs: string[] = [];
    const stdout = [
      JSON.stringify({ type: "turn.started", model: "gpt-codex-test" }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Added the health handler." } }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 7, output_tokens: 3 } }),
    ].join("\n");
    const harness = new CodexHarness({
      loginProbe: async () => ({ state: "logged-in", message: "logged in" }),
      runCommand: async (args) => {
        capturedArgs = args;
        return { exitCode: 0, stdout, stderr: "" };
      },
      changedFiles: () => ["demo-app/src/app.ts"],
    });
    const result = await harness.run(implementRequest(root));
    expect(capturedArgs).toContain("-C");
    expect(capturedArgs[capturedArgs.indexOf("-C") + 1]).toBe(resolve(root));
    expect(result).toMatchObject({
      success: true,
      changedFiles: ["demo-app/src/app.ts"],
      tokensUsed: 10,
      model: "gpt-codex-test",
      summary: "Added the health handler.",
    });
    expect(result.promptHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("uses a read-only Reviewer command and only sends spec, diff, and test output", () => {
    const request: ReviewerRequest = {
      role: "Independent Reviewer",
      stage: "independent-review",
      workId: "forge-test",
      sandboxId: "sbx-review",
      workspacePath: join(tmpdir(), "forge-codex-review"),
      specText: "spec text",
      diff: "candidate diff",
      testOutput: "all tests passed",
    };
    const args = buildCodexExecArgs(request, buildCodexPrompt(request));
    expect(args).toContain("read-only");
    expect(args[args.indexOf("-C") + 1]).toBe(resolve(request.workspacePath!));
    expect(buildCodexPrompt(request)).toContain("spec text");
    expect(buildCodexPrompt(request)).toContain("candidate diff");
    expect(buildCodexPrompt(request)).toContain("all tests passed");
    expect(buildCodexPrompt(request)).not.toContain(request.workspacePath!);
    expect(Object.keys(reviewerInput(request)).sort()).toEqual(["diff", "role", "sandboxId", "specText", "stage", "testOutput", "workId"].sort());
  });

  it("reports a missing CLI as a typed failure without waiting for a hang", async () => {
    const status = await probeCodexLoginStatus({ executable: "forge-no-such-codex-cli-for-test", timeoutMs: 1000 });
    expect(status.state).toBe("missing");
    const harness = new CodexHarness({ loginProbe: async () => status });
    await expect(harness.run(implementRequest(join(tmpdir(), "unused-worktree"))))
      .rejects.toMatchObject({ name: "CodexHarnessError", code: "CODEX_NOT_FOUND" });
  });

  it("rejects an unknown harness name and keeps stub as the configured default", () => {
    const factory = loadFactoryConfig(process.cwd());
    expect(factory.harnesses.default).toBe("stub");
    expect(resolveHarnessName(factory)).toBe("stub");
    expect(resolveHarnessName(factory, "codex")).toBe("codex");
    expect(() => resolveHarnessName(factory, "grok")).toThrow(/Unknown harness name: grok/);
  });
});
