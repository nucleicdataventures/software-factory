import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";

export interface SandboxIdentity {
  workId: string;
  role: string;
  stage: string;
  sandboxId: string;
  image: string;
}

export interface SandboxResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  sandboxId: string;
}

const SAFE_ENV_KEYS = ["CI", "FORGE_WORK_ID", "FORGE_ROLE", "FORGE_SANDBOX_ID"] as const;
const SECRET_ENV_NAME = /(api.?key|secret|token|password|credential|private.?key|pat)/i;

export function sandboxEnvironment(identity: Pick<SandboxIdentity, "workId" | "role" | "sandboxId">): Record<string, string> {
  return {
    CI: "1",
    FORGE_WORK_ID: identity.workId,
    FORGE_ROLE: identity.role,
    FORGE_SANDBOX_ID: identity.sandboxId,
  };
}

export function assertSafeSandboxEnvironment(env: Record<string, string>): void {
  for (const key of Object.keys(env)) {
    if (!SAFE_ENV_KEYS.includes(key as (typeof SAFE_ENV_KEYS)[number]) || SECRET_ENV_NAME.test(key)) {
      throw new Error(`Sandbox environment key is not allowlisted: ${key}`);
    }
  }
}

export function dockerRunArgs(identity: SandboxIdentity, workspacePath: string, command: string[], dependencyPaths: string[] = []): string[] {
  if (!command.length || command.some((part) => part.includes("\0"))) throw new Error("Invalid sandbox command");
  if (identity.image !== "node:22-bookworm-slim") throw new Error("Forge uses one approved sandbox image: node:22-bookworm-slim");
  const env = sandboxEnvironment(identity);
  assertSafeSandboxEnvironment(env);
  const mountPath = resolve(workspacePath);
  const args = [
    "run", "--rm", "--init",
    "--network=none",
    "--read-only",
    "--user", "node",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--pids-limit=128",
    "--memory=2g",
    "--cpus=2",
    "--label", `forge.work-id=${identity.workId}`,
    "--label", `forge.sandbox-id=${identity.sandboxId}`,
    "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m",
    "--mount", `type=bind,source=${mountPath},target=/workspace`,
    "--workdir", "/workspace",
    ...Object.entries(env).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
    identity.image,
    ...command,
  ];
  let mountIndex = args.indexOf(identity.image);
  for (const dependencyPath of dependencyPaths) {
    const target = dependencyPath.toLowerCase().includes("demo-app") ? "/workspace/demo-app/node_modules" : "/workspace/node_modules";
    args.splice(mountIndex, 0, "--mount", `type=bind,source=${resolve(dependencyPath)},target=${target},readonly`);
    mountIndex += 2;
  }
  return args;
}

export class DockerSandbox {
  run(identity: SandboxIdentity, workspacePath: string, command: string[], dependencyPaths: string[] = [], timeoutMs = 30 * 60_000): SandboxResult {
    const args = dockerRunArgs(identity, workspacePath, command, dependencyPaths);
    const cliEnv: NodeJS.ProcessEnv = {};
    for (const key of ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "COMSPEC", "PATHEXT", "USERPROFILE", "HOME"]) {
      const value = process.env[key];
      if (value) cliEnv[key] = value;
    }
    const result = spawnSync("docker", args, { encoding: "utf8", windowsHide: true, env: cliEnv, timeout: timeoutMs, killSignal: "SIGKILL" });
    const spawnError = result.error as NodeJS.ErrnoException | undefined;
    if (spawnError && spawnError.code !== "ETIMEDOUT") throw new Error(`Could not start Docker sandbox: ${spawnError.message}`);
    if (spawnError?.code === "ETIMEDOUT") {
      const ids = spawnSync("docker", ["ps", "--quiet", "--filter", `label=forge.sandbox-id=${identity.sandboxId}`], { encoding: "utf8", windowsHide: true, env: cliEnv });
      for (const id of (ids.stdout ?? "").split(/\r?\n/).filter(Boolean)) {
        spawnSync("docker", ["rm", "--force", id], { encoding: "utf8", windowsHide: true, env: cliEnv });
      }
      return { exitCode: 124, stdout: result.stdout ?? "", stderr: `${result.stderr ?? ""}\nSandbox exceeded its wall-clock limit`.trim(), sandboxId: identity.sandboxId };
    }
    return {
      exitCode: result.status ?? 1,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      sandboxId: identity.sandboxId,
    };
  }
}

function safeSegment(value: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(value)) throw new Error("Unsafe worktree path segment");
  return value;
}

function shouldCopy(sourceRoot: string, sourcePath: string): boolean {
  const rel = relative(sourceRoot, sourcePath);
  if (!rel) return true;
  const parts = rel.split(sep);
  const blocked = new Set([".git", ".forge", "node_modules", "coverage", "evidence", ".aws", ".azure", ".ssh", ".gnupg"]);
  if (parts.some((part) => blocked.has(part))) return false;
  const leaf = basename(sourcePath);
  if ((leaf.startsWith(".env") && leaf !== ".env.example") || [".npmrc", ".netrc", ".git-credentials"].includes(leaf) || /\.(pem|key|p12|pfx)$/i.test(leaf) || /^id_(rsa|ed25519)$/i.test(leaf)) return false;
  try {
    if (lstatSync(sourcePath).isSymbolicLink()) return false;
  } catch {
    return false;
  }
  return true;
}

export function copyWorkspaceSnapshot(sourceRoot: string, targetRoot: string): void {
  const copyDirectory = (source: string, target: string): void => {
    mkdirSync(target, { recursive: true });
    for (const entry of readdirSync(source)) {
      const sourcePath = join(source, entry);
      if (!shouldCopy(sourceRoot, sourcePath)) continue;
      const targetPath = join(target, entry);
      if (statSync(sourcePath).isDirectory()) copyDirectory(sourcePath, targetPath);
      else copyFileSync(sourcePath, targetPath);
    }
  };
  copyDirectory(sourceRoot, targetRoot);
}

export interface WorktreeSandbox {
  workId: string;
  role: string;
  stage: string;
  sandboxId: string;
  image: string;
  path: string;
}

export class GitWorktreeManager {
  constructor(private readonly repoRoot: string, private readonly image = "node:22-bookworm-slim") {}

  create(workId: string, role: string, stage: string): WorktreeSandbox {
    const safeWork = safeSegment(workId);
    const safeStage = safeSegment(stage);
    const sandboxId = `sbx-${randomUUID()}`;
    const path = join(this.repoRoot, ".forge", "worktrees", safeWork, safeStage, sandboxId);
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path)) throw new Error(`Worktree path already exists: ${path}`);
    execFileSync("git", ["worktree", "add", "--detach", "--no-checkout", path, "HEAD"], { cwd: this.repoRoot, stdio: "pipe" });
    try {
      copyWorkspaceSnapshot(this.repoRoot, path);
    } catch (error) {
      spawnSync("git", ["worktree", "remove", "--force", path], { cwd: this.repoRoot, windowsHide: true });
      throw error;
    }
    return { workId, role, stage, sandboxId, image: this.image, path };
  }

  createReviewerContext(workId: string): WorktreeSandbox {
    const safeWork = safeSegment(workId);
    const stage = "independent-review";
    const sandboxId = `sbx-${randomUUID()}`;
    const path = join(this.repoRoot, ".forge", "worktrees", safeWork, stage, sandboxId);
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path)) throw new Error(`Reviewer context path already exists: ${path}`);
    mkdirSync(path);
    return { workId, role: "Independent Reviewer", stage, sandboxId, image: this.image, path };
  }

  patch(worktreePath: string, changedFiles: string[]): string {
    const safePaths = changedFiles.map((file) => {
      const normalized = file.replaceAll("\\", "/");
      if (!normalized || normalized.startsWith("/") || normalized.split("/").includes("..")) throw new Error("Harness returned an unsafe file path");
      return normalized;
    });
    if (!safePaths.length) return "";
    execFileSync("git", ["add", "--intent-to-add", "--", ...safePaths], { cwd: worktreePath, stdio: "pipe" });
    return execFileSync("git", ["diff", "--binary", "--no-ext-diff", "HEAD", "--", ...safePaths], {
      cwd: worktreePath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  applyPatch(worktreePath: string, patch: string): void {
    if (!patch.trim()) return;
    execFileSync("git", ["apply", "--whitespace=nowarn", "-"], { cwd: worktreePath, input: patch, stdio: ["pipe", "pipe", "pipe"] });
  }
}
