import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadFactoryConfig, resolveHarnessName } from "control-plane";
import {
  buildCodexExecArgs,
  buildCodexPrompt,
  CodexHarness,
  DockerSandbox,
  dockerRunArgs,
  probeCodexLoginStatus,
  resolveHostBinary,
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
  it("prefers an existing Docker override over PATH", () => {
    const root = mkdtempSync(join(tmpdir(), "forge-docker-path-"));
    roots.push(root);
    const override = join(root, process.platform === "win32" ? "docker.exe" : "docker");
    const pathDirectory = join(root, "path");
    mkdirSync(pathDirectory);
    writeFileSync(override, "");
    writeFileSync(join(pathDirectory, process.platform === "win32" ? "docker.exe" : "docker"), "");

    expect(resolveHostBinary("docker", {
      environment: { FORGE_DOCKER_BIN: override, PATH: pathDirectory },
    })?.toLowerCase()).toBe(resolve(override).toLowerCase());
  });

  it.skipIf(process.platform !== "win32")("finds a fake .cmd shim through a Windows-style PATH and PATHEXT", () => {
    const root = mkdtempSync(join(tmpdir(), "forge-codex-path-"));
    roots.push(root);
    const shim = join(root, "codex.cmd");
    writeFileSync(shim, "@echo off\r\nexit /b 0\r\n");

    expect(resolveHostBinary("codex", {
      environment: {
        Path: `${root};C:\\Windows\\System32`,
        PATHEXT: ".EXE;.BAT;.CMD",
        APPDATA: join(root, "appdata"),
        LOCALAPPDATA: join(root, "localappdata"),
      },
      platform: "win32",
    })?.toLowerCase()).toBe(resolve(shim).toLowerCase());
  });

  it("runs login status and exec through the resolved Codex binary", async () => {
    const root = mkdtempSync(join(tmpdir(), "forge-codex-resolved-"));
    roots.push(root);
    const shimDirectory = join(root, "shim %TEMP% & directory!");
    const workspace = join(root, "job & workspace!(1)");
    mkdirSync(shimDirectory);
    mkdirSync(workspace);
    const shim = join(shimDirectory, process.platform === "win32" ? "fake codex.cmd" : "fake codex");
    const invocationLog = join(root, "invocations.txt");
    if (process.platform === "win32") {
      writeFileSync(shim, '@echo off\r\necho %*>> "%FORGE_CODEX_TEST_LOG%"\r\nif "%1"=="exec" cd >> "%FORGE_CODEX_TEST_LOG%"\r\nif "%1"=="exec" echo {"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}\r\nexit /b 0\r\n');
    } else {
      writeFileSync(shim, '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$FORGE_CODEX_TEST_LOG"\nif [ "$1" = exec ]; then printf \'cwd=%s\\n\' "$PWD" >> "$FORGE_CODEX_TEST_LOG"; printf \'%s\\n\' \'{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}\'; fi\nexit 0\n');
      chmodSync(shim, 0o755);
    }

    const previousBinary = process.env.FORGE_CODEX_BIN;
    const previousLog = process.env.FORGE_CODEX_TEST_LOG;
    process.env.FORGE_CODEX_BIN = shim;
    process.env.FORGE_CODEX_TEST_LOG = invocationLog;
    try {
      const harness = new CodexHarness({ changedFiles: () => [] });
      expect(harness.executablePath).toBe(resolve(shim));
      const result = await harness.run(implementRequest(workspace));
      const invocations = readFileSync(invocationLog, "utf8");
      expect(result.success, `Codex result: ${JSON.stringify(result)}; shim invocations: ${invocations}`).toBe(true);
      expect(invocations).toContain("login status");
      expect(invocations).toContain("exec --ephemeral");
      if (process.platform === "win32") expect(invocations).toContain(resolve(workspace));
      else expect(invocations).toContain(`cwd=${resolve(workspace)}`);
    } finally {
      if (previousBinary === undefined) delete process.env.FORGE_CODEX_BIN;
      else process.env.FORGE_CODEX_BIN = previousBinary;
      if (previousLog === undefined) delete process.env.FORGE_CODEX_TEST_LOG;
      else process.env.FORGE_CODEX_TEST_LOG = previousLog;
    }
  });

  it("builds a writable Implementer command scoped to its job worktree", () => {
    const worktree = join(tmpdir(), "forge-codex-implement");
    const args = buildCodexExecArgs(implementRequest(worktree), "Implement the spec.");
    expect(args).toContain("--ephemeral");
    expect(args).toContain("--json");
    expect(args).toContain("--sandbox");
    expect(args).toContain("workspace-write");
    expect(args).not.toContain("-C");
    expect(args).not.toContain(resolve(worktree));
    expect(args).toContain('approval_policy="never"');
    expect(args).not.toContain("--yolo");
    expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
  });

  it("overrides workstation reasoning settings with budgeted low effort", () => {
    const args = buildCodexExecArgs(implementRequest(join(tmpdir(), "forge-codex-budget")), "Implement the spec.");

    expect(args).toContain('model_reasoning_effort="low"');
  });

  it("keeps Planner work bounded to the supplied spec", () => {
    const request: HarnessRequest = {
      ...implementRequest(join(tmpdir(), "forge-codex-planner")),
      role: "Planner",
      stage: "plan",
    };
    const prompt = buildCodexPrompt(request);

    expect(prompt).toContain("Do not run commands, inspect files, or search the repository during planning.");
    expect(prompt).toContain("Limit plan.md to at most six concise numbered steps.");
  });

  it("uses the resolved Docker binary for sandbox execution and timeout cleanup", () => {
    const root = mkdtempSync(join(tmpdir(), "forge-docker-resolved-"));
    roots.push(root);
    const shimDirectory = join(root, "%TEMP% & shim!");
    mkdirSync(shimDirectory);
    const executable = join(shimDirectory, process.platform === "win32" ? "fake docker.cmd" : "fake docker");
    const sandboxWorkspace = join(root, "%TEMP% & workspace!");
    mkdirSync(sandboxWorkspace);
    writeFileSync(executable, "shim");
    const previousBinary = process.env.FORGE_DOCKER_BIN;
    process.env.FORGE_DOCKER_BIN = executable;
    const calls: Array<{ command: string; args: string[]; options?: { windowsVerbatimArguments?: boolean; env?: NodeJS.ProcessEnv } }> = [];
    const spawn = (command: string, args: string[], options?: { windowsVerbatimArguments?: boolean; env?: NodeJS.ProcessEnv }) => {
      calls.push({ command, args, options });
      if (calls.length === 1) {
        return { status: null, stdout: "", stderr: "", error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }) };
      }
      const isPs = process.platform === "win32" ? options?.env?.FORGE_SHELL_ARG_0 === "ps" : args[0] === "ps";
      return { status: 0, stdout: isPs ? "container-id\n" : "", stderr: "" };
    };

    try {
      const identity = { workId: "forge-test", role: "Test Author", stage: "author-tests", sandboxId: "sbx-test", image: "node:22-bookworm-slim" };
      const result = new DockerSandbox({ spawn }).run(identity, sandboxWorkspace, ["pnpm", "test"], [], 10);
      expect(result.exitCode).toBe(124);
      if (process.platform === "win32") {
        const commandLines = calls.map((call) => call.args[3] ?? "");
        expect(calls.every((call) => call.command.toLowerCase().endsWith("cmd.exe")), JSON.stringify(calls)).toBe(true);
        expect(commandLines[0]).toContain('"%FORGE_SHELL_EXECUTABLE%" %FORGE_SHELL_ARG_0%');
        expect(commandLines[1]).toContain('"%FORGE_SHELL_EXECUTABLE%" %FORGE_SHELL_ARG_0%');
        expect(commandLines[2]).toContain('"%FORGE_SHELL_EXECUTABLE%" %FORGE_SHELL_ARG_0%');
        expect(calls[0]?.options?.env?.FORGE_SHELL_EXECUTABLE).toBe(resolve(executable));
        expect(Object.values(calls[0]?.options?.env ?? {}).some((value) => value.includes(resolve(sandboxWorkspace)))).toBe(true);
        expect(calls.every((call) => call.options?.windowsVerbatimArguments)).toBe(true);
      } else {
        expect(calls.map((call) => call.args[0])).toEqual(["run", "ps", "rm"]);
        expect(calls.every((call) => call.command === resolve(executable))).toBe(true);
      }
    } finally {
      if (previousBinary === undefined) delete process.env.FORGE_DOCKER_BIN;
      else process.env.FORGE_DOCKER_BIN = previousBinary;
    }
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
    let capturedCwd = "";
    const harness = new CodexHarness({
      loginProbe: async () => ({ state: "logged-in", message: "logged in" }),
      runCommand: async (args, cwd) => {
        capturedArgs = args;
        capturedCwd = cwd;
        return { exitCode: 0, stdout, stderr: "" };
      },
      changedFiles: () => ["demo-app/src/app.ts"],
    });
    const result = await harness.run(implementRequest(root));
    expect(capturedCwd).toBe(resolve(root));
    expect(capturedArgs).not.toContain("-C");
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
    expect(args).not.toContain(resolve(request.workspacePath!));
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
