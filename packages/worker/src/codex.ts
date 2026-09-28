import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { reviewerInput, type HarnessAdapter, type HarnessRequest, type HarnessResult, type ReviewerRequest } from "./harness.js";

export type CodexErrorCode =
  | "CODEX_NOT_FOUND"
  | "CODEX_NOT_LOGGED_IN"
  | "CODEX_STATUS_UNAVAILABLE"
  | "CODEX_EXEC_FAILED"
  | "CODEX_EXEC_TIMEOUT"
  | "CODEX_WORKTREE_REQUIRED"
  | "CODEX_ROLE_POLICY";

export class CodexHarnessError extends Error {
  constructor(readonly code: CodexErrorCode, message: string) {
    super(message);
    this.name = "CodexHarnessError";
  }
}

export type CodexLoginStatus =
  | { state: "logged-in"; message: string }
  | { state: "logged-out"; message: string }
  | { state: "missing"; message: string }
  | { state: "unavailable"; message: string };

export interface CodexCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type CodexCommandRunner = (args: string[], cwd: string, timeoutMs: number) => Promise<CodexCommandResult>;
export type CodexLoginProbe = () => Promise<CodexLoginStatus>;

export interface CodexHarnessOptions {
  executable?: string;
  timeoutMs?: number;
  tokenLimit?: number;
  runCommand?: CodexCommandRunner;
  loginProbe?: CodexLoginProbe;
  changedFiles?: (cwd: string, before: Map<string, string>) => string[];
}

const LOGIN_TIMEOUT_MS = 5_000;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

function codexExecutable(): string {
  return process.platform === "win32" ? "codex.exe" : "codex";
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

export function runCodexCommand(executable: string, args: string[], cwd: string, timeoutMs: number): Promise<CodexCommandResult> {
  return new Promise((resolveResult, reject) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const child = spawn(executable, args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    const finish = (result?: CodexCommandResult, error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolveResult(result ?? { exitCode: 1, stdout, stderr });
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (Buffer.byteLength(stdout) > MAX_OUTPUT_BYTES) child.kill();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (Buffer.byteLength(stderr) > MAX_OUTPUT_BYTES) child.kill();
    });
    child.once("error", (error) => finish(undefined, error));
    child.once("close", (code) => {
      if (timedOut) {
        finish({ exitCode: 124, stdout, stderr: (stderr + "\nCodex exec exceeded its wall-clock limit.").trim() });
      } else if (Buffer.byteLength(stdout) > MAX_OUTPUT_BYTES || Buffer.byteLength(stderr) > MAX_OUTPUT_BYTES) {
        finish({ exitCode: 1, stdout: "", stderr: "Codex exec output exceeded the 16 MiB limit." });
      } else {
        finish({ exitCode: code ?? 1, stdout, stderr });
      }
    });
  });
}

export async function probeCodexLoginStatus(options: {
  executable?: string;
  runCommand?: CodexCommandRunner;
  timeoutMs?: number;
} = {}): Promise<CodexLoginStatus> {
  const executable = options.executable ?? codexExecutable();
  const runner = options.runCommand ?? ((args, cwd, timeoutMs) => runCodexCommand(executable, args, cwd, timeoutMs));
  try {
    const result = await runner(["login", "status"], process.cwd(), options.timeoutMs ?? LOGIN_TIMEOUT_MS);
    if (result.exitCode === 0) return { state: "logged-in", message: "Codex is logged in on the host." };
    return { state: "logged-out", message: "Codex login status failed. Run codex login on the host and retry." };
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { state: "missing", message: "Codex CLI was not found on PATH." };
    if (errorCode(error) === "ETIMEDOUT") return { state: "unavailable", message: "Codex login status check timed out." };
    return { state: "unavailable", message: "Codex login status could not be checked: " + errorText(error) };
  }
}

export function buildCodexExecArgs(request: HarnessRequest, prompt: string): string[] {
  const workspacePath = request.workspacePath;
  if (!workspacePath) throw new CodexHarnessError("CODEX_WORKTREE_REQUIRED", "Codex requires a job worktree for every role.");
  const sandbox = request.stage === "independent-review" ? "read-only" : "workspace-write";
  return [
    "exec",
    "--ephemeral",
    "--json",
    "--sandbox",
    sandbox,
    "--config",
    'approval_policy="never"',
    "-C",
    resolve(workspacePath),
    prompt,
  ];
}

export function buildCodexPrompt(request: HarnessRequest): string {
  if (request.stage === "plan") {
    return [
      "You are Forge's Planner.",
      "Read the supplied spec and write a clear implementation plan to plan.md at the worktree root.",
      "Only create or change plan.md. Do not edit source code or tests.",
      "Do not merge, push, or modify Forge state.",
      "",
      "SPEC:",
      request.specText,
    ].join("\n");
  }
  if (request.stage === "author-tests") {
    return [
      "You are Forge's Test Author.",
      "Add or update tests only, based on the supplied spec. Do not edit implementation code.",
      "Do not weaken existing tests, merge, or push.",
      "",
      "SPEC:",
      request.specText,
    ].join("\n");
  }
  if (request.stage === "implement") {
    return [
      "You are Forge's Implementer.",
      "Make the supplied spec pass the existing tests. Do not weaken or edit tests.",
      "Write only inside this job worktree. Do not merge or push.",
      "",
      "SPEC:",
      request.specText,
    ].join("\n");
  }
  const review = reviewerInput(request as ReviewerRequest);
  return [
    "You are Forge's Independent Reviewer.",
    "Review only the spec, candidate diff, and verification output below. Do not use prior worker conversation.",
    "Return only JSON with boolean approved and string summary fields.",
    "",
    "SPEC:",
    review.specText,
    "",
    "CANDIDATE DIFF:",
    review.diff,
    "",
    "TEST OUTPUT:",
    review.testOutput,
  ].join("\n");
}

function snapshotWorkspace(root: string): Map<string, string> {
  const snapshot = new Map<string, string>();
  const ignored = new Set([".git", ".forge", "node_modules", "coverage", "evidence"]);
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (ignored.has(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isFile() && !lstatSync(path).isSymbolicLink()) {
        const relativePath = relative(root, path).split(sep).join("/");
        snapshot.set(relativePath, createHash("sha256").update(readFileSync(path)).digest("hex"));
      }
    }
  };
  visit(root);
  return snapshot;
}

function readChangedFiles(cwd: string, before: Map<string, string>): string[] {
  const after = snapshotWorkspace(cwd);
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter((path) => before.get(path) !== after.get(path))
    .sort();
}

function isTestPath(file: string): boolean {
  const parts = file.toLowerCase().split("/");
  return parts.some((part) => part === "test" || part === "tests") || /\.(test|spec)\.[^./]+$/i.test(file);
}

interface ParsedOutput {
  summary: string;
  tokensUsed: number | null;
  model?: string | undefined;
}

function parseJsonl(output: string): ParsedOutput {
  let summary = "";
  let tokensUsed: number | null = null;
  let model: string | undefined;
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as Record<string, any>;
      if (typeof event.model === "string") model = event.model;
      if (event.type === "item.completed" && event.item && event.item.type === "agent_message" && typeof event.item.text === "string") {
        summary = event.item.text;
      }
      const usage = event.usage ?? (event.info ? event.info.total_token_usage : undefined);
      if (usage && typeof usage === "object") {
        const input = Number(usage.input_tokens ?? usage.inputTokens ?? 0);
        const outputTokens = Number(usage.output_tokens ?? usage.outputTokens ?? 0);
        const total = Number(usage.total_tokens ?? usage.totalTokens ?? input + outputTokens);
        if (Number.isFinite(total) && total >= 0) tokensUsed = total;
      }
    } catch {
      // Ignore non-JSON stdout lines so the adapter can still report the final agent message.
    }
  }
  return { summary: summary.trim(), tokensUsed, model };
}

function parseReview(summary: string): { approved: boolean; summary: string } | null {
  const fence = String.fromCharCode(96).repeat(3);
  const text = summary.trim()
    .replace(new RegExp("^" + fence + "(?:json)?\\s*", "i"), "")
    .replace(new RegExp("\\s*" + fence + "$"), "");
  try {
    const value = JSON.parse(text) as { approved?: unknown; summary?: unknown };
    if (typeof value.approved !== "boolean" || typeof value.summary !== "string") return null;
    return { approved: value.approved, summary: value.summary };
  } catch {
    return null;
  }
}

function rolePolicyError(request: HarnessRequest, files: string[]): string | null {
  if (request.stage === "plan" && (files.length !== 1 || files[0] !== "plan.md")) return "Planner may change plan.md only.";
  if (request.stage === "author-tests" && (files.length === 0 || files.some((file) => !isTestPath(file)))) return "Test Author must add or update tests only.";
  if (request.stage === "implement" && files.some(isTestPath)) return "Implementer may not change tests.";
  if (request.stage === "independent-review" && files.length > 0) return "Independent Reviewer worktree contains changes after a read-only run.";
  return null;
}

export class CodexHarness implements HarnessAdapter {
  readonly name = "codex";
  private readonly executable: string;
  private readonly timeoutMs: number;
  private readonly tokenLimit: number;
  private readonly runCommand: CodexCommandRunner;
  private readonly loginProbe: CodexLoginProbe;
  private readonly changedFiles: (cwd: string, before: Map<string, string>) => string[];

  constructor(options: CodexHarnessOptions = {}) {
    this.executable = options.executable ?? codexExecutable();
    this.timeoutMs = options.timeoutMs ?? 30 * 60_000;
    this.tokenLimit = options.tokenLimit ?? 30_000;
    this.runCommand = options.runCommand ?? ((args, cwd, timeoutMs) => runCodexCommand(this.executable, args, cwd, timeoutMs));
    this.loginProbe = options.loginProbe ?? (() => probeCodexLoginStatus({ executable: this.executable, runCommand: this.runCommand }));
    this.changedFiles = options.changedFiles ?? readChangedFiles;
  }

  async run(request: HarnessRequest): Promise<HarnessResult> {
    const prompt = buildCodexPrompt(request);
    const promptHash = createHash("sha256").update(prompt).digest("hex");
    const workspacePath = request.workspacePath;
    if (!workspacePath) throw new CodexHarnessError("CODEX_WORKTREE_REQUIRED", "Codex requires a job worktree for every role.");

    const status = await this.loginProbe();
    if (status.state === "missing") throw new CodexHarnessError("CODEX_NOT_FOUND", status.message);
    if (status.state === "logged-out") throw new CodexHarnessError("CODEX_NOT_LOGGED_IN", status.message);
    if (status.state === "unavailable") throw new CodexHarnessError("CODEX_STATUS_UNAVAILABLE", status.message);

    const before = snapshotWorkspace(workspacePath);
    let result: CodexCommandResult;
    try {
      result = await this.runCommand(buildCodexExecArgs(request, prompt), workspacePath, this.timeoutMs);
    } catch (error) {
      if (errorCode(error) === "ENOENT") throw new CodexHarnessError("CODEX_NOT_FOUND", "Codex CLI was not found on PATH.");
      throw new CodexHarnessError("CODEX_EXEC_FAILED", "Could not start Codex exec: " + errorText(error));
    }

    const files = this.changedFiles(workspacePath, before);
    const parsed = parseJsonl(result.stdout);
    const summary = parsed.summary || result.stderr.trim() || "Codex CLI finished without a final message.";
    if (result.exitCode !== 0) {
      const timedOut = result.exitCode === 124;
      return {
        success: false,
        changedFiles: files,
        tokensUsed: parsed.tokensUsed ?? 0,
        usdCost: 0,
        summary: timedOut ? summary : "Codex exec exited with code " + result.exitCode + ": " + summary,
        promptHash,
        model: parsed.model,
        errorCode: timedOut ? "CODEX_EXEC_TIMEOUT" : "CODEX_EXEC_FAILED",
      };
    }
    if (parsed.tokensUsed === null) {
      return {
        success: false,
        changedFiles: files,
        tokensUsed: this.tokenLimit + 1,
        usdCost: 0,
        summary: "Codex completed without reporting token usage; Forge stopped the stage to preserve its token budget.",
        promptHash,
        model: parsed.model,
        errorCode: "CODEX_EXEC_FAILED",
      };
    }
    if (parsed.tokensUsed > this.tokenLimit) {
      return {
        success: false,
        changedFiles: files,
        tokensUsed: parsed.tokensUsed,
        usdCost: 0,
        summary: "Codex reported " + parsed.tokensUsed + " tokens, above the per-item limit of " + this.tokenLimit + ".",
        promptHash,
        model: parsed.model,
        errorCode: "CODEX_EXEC_FAILED",
      };
    }
    const policyError = rolePolicyError(request, files);
    if (policyError) {
      return {
        success: false,
        changedFiles: files,
        tokensUsed: parsed.tokensUsed,
        usdCost: 0,
        summary: policyError,
        promptHash,
        model: parsed.model,
        errorCode: "CODEX_ROLE_POLICY",
      };
    }

    let approved: boolean | undefined;
    let finalSummary = summary;
    if (request.stage === "independent-review") {
      const review = parseReview(summary);
      if (!review) {
        return {
          success: false,
          changedFiles: files,
          tokensUsed: parsed.tokensUsed,
          usdCost: 0,
          summary: "Reviewer response must be JSON with approved and summary fields.",
          approved: false,
          promptHash,
          model: parsed.model,
          errorCode: "CODEX_ROLE_POLICY",
        };
      }
      approved = review.approved;
      finalSummary = review.summary;
    }
    return {
      success: true,
      changedFiles: files,
      tokensUsed: parsed.tokensUsed,
      usdCost: 0,
      summary: finalSummary,
      approved,
      promptHash,
      model: parsed.model,
    };
  }
}
