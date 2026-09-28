import { spawn } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  Orchestrator,
  resolveHostBinary,
  usesWindowsCommandShell,
  windowsCommandShellInvocation,
  type WorkItemView,
} from "control-plane";
import type { Gate, RunRecord, WorkItem } from "ledger";

const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_EVIDENCE_BYTES = 2 * 1024 * 1024;
const WORK_ID = /^forge-[0-9]{8}-[a-f0-9]{8}$/i;
const DOCKER_HEALTH_TIMEOUT_MS = 5_000;

export interface ForgeHttpOptions {
  root: string;
  orchestrator: Orchestrator;
  uiDirectory: string;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

function sendError(response: ServerResponse, error: unknown, fallbackStatus = 500): void {
  const message = error instanceof Error ? error.message : String(error);
  const status = error instanceof HttpError ? error.status : (/codex|docker|sandbox|Stage .* stopped/i.test(message) ? 502 : fallbackStatus);
  sendJson(response, status, { error: message });
}

function safeWorkId(value: string): string {
  if (!WORK_ID.test(value)) throw new HttpError(400, "Invalid work item id");
  return value;
}

function safeItem(item: WorkItem): Record<string, unknown> {
  return {
    id: item.id,
    title: item.title,
    specRef: item.specRef,
    status: item.status,
    currentStage: item.currentStage,
    assigneeRole: item.assigneeRole,
    deps: item.deps,
    budgetTokens: item.budgetTokens,
    budgetUsd: item.budgetUsd,
    retries: item.retries,
    retryCount: item.retryCount,
    tokensUsed: item.tokensUsed,
    usdUsed: item.usdUsed,
    harness: item.harness,
    model: item.model,
    sandboxId: item.sandboxId,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

function safeRun(run: RunRecord): Record<string, unknown> {
  return {
    id: run.id,
    role: run.role,
    stage: run.stage,
    status: run.status,
    sandboxId: run.sandboxId,
    promptHash: run.promptHash,
    tokensUsed: run.tokensUsed,
    usdUsed: run.usdUsed,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
  };
}

function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path !== "" && path !== "." && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function samePath(left: string, right: string): boolean {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function safeRepoFile(root: string, reference: string): string {
  try {
    const canonicalRoot = realpathSync(root);
    const target = resolve(canonicalRoot, reference);
    if (!inside(canonicalRoot, target)) throw new HttpError(404, "Spec file is unavailable");
    const canonicalTarget = realpathSync(target);
    if (!inside(canonicalRoot, canonicalTarget) || !statSync(canonicalTarget).isFile()) {
      throw new HttpError(404, "Spec file is unavailable");
    }
    return canonicalTarget;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(404, "Spec file is unavailable");
  }
}

function safeEvidenceName(file: string): boolean {
  const lower = file.toLowerCase();
  return file.length > 0
    && file !== "."
    && file !== ".."
    && basename(file) === file
    && !file.includes("/")
    && !file.includes("\\")
    && !file.includes("\0")
    && !/^\.env(?:$|\.)/i.test(file)
    && !/\.(?:pem|key)$/i.test(file)
    && !/(?:secret|credential|token|id_rsa|id_ed25519)/i.test(lower);
}

function safeEvidenceFile(root: string, workId: string, file: string): string {
  const id = safeWorkId(workId);
  if (!safeEvidenceName(file)) throw new HttpError(404, "Evidence file is unavailable");
  const canonicalRoot = realpathSync(root);
  const expectedDirectory = resolve(canonicalRoot, "evidence", "runs", id);
  let canonicalDirectory: string;
  try {
    canonicalDirectory = realpathSync(expectedDirectory);
  } catch {
    throw new HttpError(404, "Evidence file is unavailable");
  }
  if (!samePath(expectedDirectory, canonicalDirectory)) throw new HttpError(404, "Evidence file is unavailable");
  const target = resolve(canonicalDirectory, file);
  if (!samePath(dirname(target), canonicalDirectory)) throw new HttpError(404, "Evidence file is unavailable");
  try {
    const entry = lstatSync(target);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.size > MAX_EVIDENCE_BYTES) {
      throw new HttpError(entry.size > MAX_EVIDENCE_BYTES ? 413 : 404, "Evidence file is unavailable");
    }
    const canonicalTarget = realpathSync(target);
    if (!inside(canonicalDirectory, canonicalTarget) || !samePath(dirname(canonicalTarget), canonicalDirectory)) {
      throw new HttpError(404, "Evidence file is unavailable");
    }
    return canonicalTarget;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(404, "Evidence file is unavailable");
  }
}

function stripHostPaths(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripHostPaths);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "worktreePath").map(([key, entry]) => [key, stripHostPaths(entry)]));
  }
  return value;
}

function detailView(root: string, orchestrator: Orchestrator, workId: string): Record<string, unknown> {
  const view: WorkItemView = orchestrator.getView(workId);
  if (!view.item) throw new HttpError(404, `Unknown work item: ${workId}`);

  let specText = "";
  let specError: string | null = null;
  try {
    specText = readFileSync(safeRepoFile(root, view.item.specRef), "utf8");
  } catch {
    specError = "The spec file is unavailable in the repository.";
  }

  let files: string[] = [];
  try {
    const expectedDirectory = resolve(realpathSync(root), "evidence", "runs", workId);
    const directory = realpathSync(expectedDirectory);
    if (samePath(expectedDirectory, directory)) {
      files = readdirSync(directory, { withFileTypes: true })
        .filter((entry) => entry.isFile() && safeEvidenceName(entry.name))
        .map((entry) => entry.name)
        .sort();
    }
  } catch {
    files = [];
  }

  const evidence = view.evidence.map((entry) => ({
    kind: entry.kind,
    file: entry.uri.replaceAll("\\", "/").split("/").at(-1) ?? "",
    sha256: entry.sha256,
    createdAt: entry.createdAt,
  })).filter((entry) => safeEvidenceName(entry.file));

  let provenance: unknown = null;
  if (files.includes("provenance.json")) {
    try {
      provenance = stripHostPaths(JSON.parse(readFileSync(safeEvidenceFile(root, workId, "provenance.json"), "utf8")));
    } catch {
      provenance = null;
    }
  }

  return {
    item: safeItem(view.item),
    runs: view.runs.map(safeRun),
    evidence,
    evidenceFiles: files,
    approvals: {
      plan: orchestrator.ledger.latestApproval(workId, "plan"),
      merge: orchestrator.ledger.latestApproval(workId, "merge"),
    },
    specText,
    specError,
    provenance,
  };
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > MAX_REQUEST_BYTES) throw new HttpError(413, "Request body is too large");
    chunks.push(buffer);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Request body must be valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new HttpError(400, "Request body must be a JSON object");
  return parsed as Record<string, unknown>;
}

function requireString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || !value.trim()) throw new HttpError(400, `${key} is required`);
  return value.trim();
}

function requireGate(body: Record<string, unknown>): Gate {
  const gate = body.gate;
  if (gate !== "plan" && gate !== "merge") throw new HttpError(400, "gate must be plan or merge");
  return gate;
}

interface DockerHealthStatus {
  available: boolean;
  message?: string;
}

function dockerStatus(): Promise<DockerHealthStatus> {
  const executable = resolveHostBinary("docker");
  if (!executable) return Promise.resolve({ available: false, message: "Docker CLI was not found on PATH or the configured Docker Desktop location." });

  return new Promise((resolveStatus) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const done = (status: DockerHealthStatus) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveStatus(status);
    };
    const shellInvocation = usesWindowsCommandShell(executable) ? windowsCommandShellInvocation(executable, ["info"]) : null;
    const child = spawn(shellInvocation?.command ?? executable, shellInvocation?.args ?? ["info"], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      ...(shellInvocation ? { env: { ...process.env, ...shellInvocation.env } } : {}),
      ...(shellInvocation ? { windowsVerbatimArguments: true } : {}),
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
      done({ available: false, message: `docker info timed out after ${DOCKER_HEALTH_TIMEOUT_MS}ms.` });
    }, DOCKER_HEALTH_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.once("error", (error) => done({ available: false, message: error.message }));
    child.once("close", (code) => {
      if (timedOut) return;
      if (code === 0 && /^[ \t]*Server Version:\s*\S+/im.test(stdout)) {
        done({ available: true });
        return;
      }
      const message = code === 0
        ? "docker info did not report a Server Version."
        : stderr.trim() || stdout.trim() || `docker info exited with code ${code ?? 1}.`;
      done({ available: false, message });
    });
  });
}

function createHealthReader(orchestrator: Orchestrator): () => Promise<Record<string, unknown>> {
  let cached: { at: number; docker: DockerHealthStatus; codex: Awaited<ReturnType<Orchestrator["getCodexLoginStatus"]>> } | null = null;
  let pending: Promise<{ docker: DockerHealthStatus; codex: Awaited<ReturnType<Orchestrator["getCodexLoginStatus"]>> }> | null = null;
  return async () => {
    if (!cached || Date.now() - cached.at > 2500) {
      pending ??= Promise.all([dockerStatus(), orchestrator.getCodexLoginStatus()])
        .then(([docker, codex]) => ({ docker, codex }))
        .finally(() => { pending = null; });
      const status = await pending;
      cached = { at: Date.now(), ...status };
    }
    return {
      node: process.version,
      docker: cached.docker.available ? "up" : "down",
      ...(!cached.docker.available ? { dockerMessage: cached.docker.message } : {}),
      harness: orchestrator.harness.name,
      codex: cached.codex.state,
      codexMessage: cached.codex.message,
    };
  };
}

function serveStatic(response: ServerResponse, uiDirectory: string, pathname: string): void {
  const staticFiles: Record<string, { file: string; type: string }> = {
    "/": { file: "index.html", type: "text/html; charset=utf-8" },
    "/index.html": { file: "index.html", type: "text/html; charset=utf-8" },
    "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
    "/styles.css": { file: "styles.css", type: "text/css; charset=utf-8" },
  };
  const asset = staticFiles[pathname];
  if (!asset) throw new HttpError(404, "Not found");
  const file = resolve(uiDirectory, asset.file);
  if (!existsSync(file)) throw new HttpError(503, "Browser UI assets are missing; run pnpm build first");
  const contents = readFileSync(file);
  response.writeHead(200, {
    "Content-Type": asset.type,
    "Content-Length": contents.byteLength,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  });
  response.end(contents);
}

function actionStatus(error: unknown, action: "gate" | "resume"): number {
  if (error instanceof HttpError) return error.status;
  const message = error instanceof Error ? error.message : String(error);
  if (/Unknown work item:/.test(message)) return 404;
  if (/codex|docker|sandbox|Stage .* stopped/i.test(message)) return 502;
  return action === "gate" || action === "resume" ? 409 : 500;
}

export function createForgeHttpServer(options: ForgeHttpOptions): Server {
  const health = createHealthReader(options.orchestrator);

  return createServer((request, response) => {
    const handle = async () => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const parts = url.pathname.split("/").filter(Boolean).map((part) => {
        try { return decodeURIComponent(part); } catch { throw new HttpError(400, "Malformed URL path"); }
      });

      if (request.method === "GET" && parts.length === 2 && parts[0] === "api" && parts[1] === "health") {
        sendJson(response, 200, await health());
        return;
      }

      if (request.method === "GET" && parts.length === 2 && parts[0] === "api" && parts[1] === "work") {
        const items = options.orchestrator.ledger.listWorkItems().map(safeItem);
        sendJson(response, 200, { items });
        return;
      }

      if (request.method === "GET" && parts.length === 5 && parts[0] === "api" && parts[1] === "work" && parts[3] === "evidence") {
        const workId = safeWorkId(parts[2]!);
        const file = parts[4]!;
        if (!options.orchestrator.ledger.getWorkItem(workId)) throw new HttpError(404, `Unknown work item: ${workId}`);
        const evidencePath = safeEvidenceFile(options.root, workId, file);
        const contents = readFileSync(evidencePath, "utf8");
        if (file === "provenance.json") {
          try {
            const safe = JSON.stringify(stripHostPaths(JSON.parse(contents)), null, 2);
            response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
            response.end(`${safe}\n`);
            return;
          } catch {
            throw new HttpError(500, "Provenance evidence is invalid JSON");
          }
        }
        response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
        response.end(contents);
        return;
      }

      if (request.method === "GET" && parts.length === 3 && parts[0] === "api" && parts[1] === "work") {
        sendJson(response, 200, detailView(options.root, options.orchestrator, safeWorkId(parts[2]!)));
        return;
      }

      if (request.method === "POST" && parts.length === 2 && parts[0] === "api" && parts[1] === "run") {
        const body = await readJson(request);
        const prompt = requireString(body, "prompt");
        const item = await options.orchestrator.createFromPrompt(prompt);
        sendJson(response, 201, { item: safeItem(item) });
        return;
      }

      if (request.method === "POST" && parts.length === 2 && parts[0] === "api" && parts[1] === "seed") {
        const body = await readJson(request);
        const specPath = requireString(body, "specPath");
        try {
          safeRepoFile(options.root, specPath);
        } catch {
          throw new HttpError(400, "specPath must point to an existing file inside the repository");
        }
        const item = await options.orchestrator.seed(specPath);
        sendJson(response, 201, { item: safeItem(item) });
        return;
      }

      if (request.method === "POST" && parts.length === 4 && parts[0] === "api" && parts[1] === "work" && (parts[3] === "approve" || parts[3] === "reject")) {
        const workId = safeWorkId(parts[2]!);
        const body = await readJson(request);
        const gate = requireGate(body);
        try {
          const item = parts[3] === "approve"
            ? await options.orchestrator.approve(workId, gate)
            : options.orchestrator.reject(workId, requireString(body, "reason"), gate);
          sendJson(response, 200, { item: safeItem(item) });
        } catch (error) {
          sendError(response, error, actionStatus(error, "gate"));
        }
        return;
      }

      if (request.method === "POST" && parts.length === 4 && parts[0] === "api" && parts[1] === "work" && parts[3] === "resume") {
        const workId = safeWorkId(parts[2]!);
        try {
          const item = await options.orchestrator.resume(workId);
          sendJson(response, 200, { item: safeItem(item) });
        } catch (error) {
          sendError(response, error, actionStatus(error, "resume"));
        }
        return;
      }

      if (request.method === "GET" && parts.length <= 1) {
        serveStatic(response, options.uiDirectory, url.pathname);
        return;
      }

      throw new HttpError(404, "Not found");
    };

    void handle().catch((error: unknown) => {
      if (!response.headersSent) sendError(response, error);
      else response.destroy(error instanceof Error ? error : undefined);
    });
  });
}
