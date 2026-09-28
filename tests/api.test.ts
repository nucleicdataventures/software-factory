import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createForgeHttpServer } from "api";
import { Orchestrator, type OrchestratorOptions, type TestExecutor } from "control-plane";
import { Ledger } from "ledger";
import { parseServeOptions } from "cli";
import { CodexHarness, GitWorktreeManager, StubHarness, type HarnessAdapter } from "worker";

const repositoryRoot = process.cwd();
const fixtures: Array<{ root: string; orchestrator: Orchestrator; server: ReturnType<typeof createForgeHttpServer>; baseUrl: string }> = [];
const temporaryRoots: string[] = [];

interface FixtureOptions {
  harness?: HarnessAdapter;
  testExecutor?: TestExecutor;
  codexStatusProbe?: OrchestratorOptions["codexStatusProbe"] | null;
}

async function fixture(options: FixtureOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), "forge-api-"));
  mkdirSync(join(root, "workflows"), { recursive: true });
  mkdirSync(join(root, "demo-app", "src"), { recursive: true });
  mkdirSync(join(root, "specs"), { recursive: true });
  copyFileSync(join(repositoryRoot, "factory.yaml"), join(root, "factory.yaml"));
  copyFileSync(join(repositoryRoot, "workflows", "default.yaml"), join(root, "workflows", "default.yaml"));
  copyFileSync(join(repositoryRoot, "demo-app", "src", "app.ts"), join(root, "demo-app", "src", "app.ts"));
  copyFileSync(join(repositoryRoot, "specs", "EXAMPLE.md"), join(root, "specs", "EXAMPLE.md"));
  writeFileSync(join(root, ".gitignore"), ".forge/\nevidence/runs/\n");
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Forge Tests"], { cwd: root });
  execFileSync("git", ["config", "user.email", "forge-tests@example.invalid"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-m", "fixture", "-q"], { cwd: root });

  const ledger = new Ledger(":memory:");
  const orchestratorOptions: OrchestratorOptions = {
    ledger,
    worktrees: new GitWorktreeManager(root),
    harness: options.harness ?? new StubHarness(),
  };
  if (options.codexStatusProbe !== null) {
    orchestratorOptions.codexStatusProbe = options.codexStatusProbe ?? (async () => ({ state: "logged-in", message: "Codex is logged in on the host." }));
  }
  if (options.testExecutor) orchestratorOptions.testExecutor = options.testExecutor;
  const orchestrator = new Orchestrator(root, orchestratorOptions);
  const server = createForgeHttpServer({ root, orchestrator, uiDirectory: join(repositoryRoot, "packages", "ui", "public") });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind to a TCP port");
  const created = { root, orchestrator, server, baseUrl: `http://127.0.0.1:${address.port}` };
  fixtures.push(created);
  return created;
}

async function post(baseUrl: string, path: string, body: Record<string, unknown>) {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

afterEach(async () => {
  for (const item of fixtures.splice(0)) {
    await new Promise<void>((resolveClose) => item.server.close(() => resolveClose()));
    item.orchestrator.ledger.close();
    rmSync(item.root, { recursive: true, force: true });
  }
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("local Forge API", () => {
  it("reports the selected harness and host Codex login state", async () => {
    const app = await fixture();
    const health = await fetch(app.baseUrl + "/api/health").then((response) => response.json());
    expect(health).toMatchObject({ harness: "stub", codex: "logged-in" });
    expect(["up", "down"]).toContain(health.docker);
    expect(["logged-in", "logged-out", "missing", "unavailable"]).toContain(health.codex);
    expect(typeof health.codexMessage).toBe("string");
    if (health.docker === "down") expect(typeof health.dockerMessage).toBe("string");
    const script = await fetch(app.baseUrl + "/app.js").then((response) => response.text());
    expect(script).toContain("Codex logged in");
    expect(script).toContain("Codex CLI missing");
  });

  it("checks Codex login through the same resolved binary used by CodexHarness", async () => {
    const root = mkdtempSync(join(tmpdir(), "forge-health-codex-"));
    temporaryRoots.push(root);
    const shimDirectory = join(root, "codex shim directory");
    mkdirSync(shimDirectory);
    const shim = join(shimDirectory, process.platform === "win32" ? "fake codex.cmd" : "fake codex");
    const invocationLog = join(root, "invocations.txt");
    if (process.platform === "win32") {
      writeFileSync(shim, '@echo off\r\necho %*>> "%FORGE_CODEX_TEST_LOG%"\r\nexit /b 0\r\n');
    } else {
      writeFileSync(shim, '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$FORGE_CODEX_TEST_LOG"\nexit 0\n');
      chmodSync(shim, 0o755);
    }

    const previousBinary = process.env.FORGE_CODEX_BIN;
    const previousLog = process.env.FORGE_CODEX_TEST_LOG;
    process.env.FORGE_CODEX_BIN = shim;
    process.env.FORGE_CODEX_TEST_LOG = invocationLog;
    try {
      const app = await fixture({ harness: new CodexHarness(), codexStatusProbe: null });
      const health = await fetch(app.baseUrl + "/api/health").then((response) => response.json());
      expect(health).toMatchObject({ harness: "codex", codex: "logged-in" });
      expect(readFileSync(invocationLog, "utf8")).toContain("login status");
    } finally {
      if (previousBinary === undefined) delete process.env.FORGE_CODEX_BIN;
      else process.env.FORGE_CODEX_BIN = previousBinary;
      if (previousLog === undefined) delete process.env.FORGE_CODEX_TEST_LOG;
      else process.env.FORGE_CODEX_TEST_LOG = previousLog;
    }
  });

  it("preserves an unavailable Codex login-probe state in health", async () => {
    const app = await fixture({ codexStatusProbe: async () => ({ state: "unavailable", message: "Codex status timed out." }) });
    const health = await fetch(app.baseUrl + "/api/health").then((response) => response.json());
    expect(health).toMatchObject({ codex: "unavailable", codexMessage: "Codex status timed out." });
  });

  it("marks Docker up only when the resolved binary reports a Server Version", async () => {
    const root = mkdtempSync(join(tmpdir(), "forge-health-docker-"));
    temporaryRoots.push(root);
    const dockerDirectory = join(root, "%TEMP% & docker shim!");
    mkdirSync(dockerDirectory);
    const docker = join(dockerDirectory, process.platform === "win32" ? "fake docker.cmd" : "fake docker");
    if (process.platform === "win32") {
      writeFileSync(docker, '@echo off\r\nif "%FORGE_DOCKER_TEST_MODE%"=="slow-server" timeout /t 2 /nobreak > nul\r\nif "%FORGE_DOCKER_TEST_MODE%"=="server" goto server\r\nif "%FORGE_DOCKER_TEST_MODE%"=="slow-server" goto server\r\necho Client Version: 29.1.2\r\nexit /b 0\r\n:server\r\necho   Server Version: 29.1.2\r\nexit /b 0\r\n');
    } else {
      writeFileSync(docker, '#!/bin/sh\nif [ "$FORGE_DOCKER_TEST_MODE" = slow-server ]; then sleep 2; fi\nif [ "$FORGE_DOCKER_TEST_MODE" = server ] || [ "$FORGE_DOCKER_TEST_MODE" = slow-server ]; then echo "  Server Version: 29.1.2"; else echo "Client Version: 29.1.2"; fi\n');
      chmodSync(docker, 0o755);
    }

    const previousBinary = process.env.FORGE_DOCKER_BIN;
    const previousMode = process.env.FORGE_DOCKER_TEST_MODE;
    process.env.FORGE_DOCKER_BIN = docker;
    try {
      process.env.FORGE_DOCKER_TEST_MODE = "slow-server";
      const healthyApp = await fixture();
      const healthy = await fetch(healthyApp.baseUrl + "/api/health").then((response) => response.json());
      expect(healthy.docker).toBe("up");
      expect(healthy.dockerMessage).toBeUndefined();

      process.env.FORGE_DOCKER_TEST_MODE = "client-only";
      const incompleteApp = await fixture();
      const incomplete = await fetch(incompleteApp.baseUrl + "/api/health").then((response) => response.json());
      expect(incomplete).toMatchObject({ docker: "down", dockerMessage: "docker info did not report a Server Version." });
    } finally {
      if (previousBinary === undefined) delete process.env.FORGE_DOCKER_BIN;
      else process.env.FORGE_DOCKER_BIN = previousBinary;
      if (previousMode === undefined) delete process.env.FORGE_DOCKER_TEST_MODE;
      else process.env.FORGE_DOCKER_TEST_MODE = previousMode;
    }
  });

  it("returns the exact Codex error when Planner cannot start", async () => {
    const exactError = "Codex CLI was not found on PATH.";
    const harness: HarnessAdapter = {
      name: "codex",
      async run() { throw new Error(exactError); },
    };
    const app = await fixture({ harness });
    const response = await post(app.baseUrl, "/api/run", { prompt: "Add a GET /health endpoint to demo-app" });
    expect(response.status).toBe(502);
    expect((await response.json()).error).toContain(exactError);
    expect(app.orchestrator.ledger.listWorkItems()[0]).toMatchObject({ status: "queued", currentStage: "plan", harness: "codex" });
  });

  it("serves the board and creates prompt or seeded work at the plan gate", async () => {
    const app = await fixture();
    const page = await fetch(app.baseUrl);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Forge · Control room");
    const script = await fetch(`${app.baseUrl}/app.js`).then((response) => response.text());
    expect(script).toContain("FACTORY FLOOR");
    const promptResponse = await post(app.baseUrl, "/api/run", { prompt: "Add a health endpoint" });
    expect(promptResponse.status).toBe(201);
    const prompted = (await promptResponse.json()).item;
    expect(prompted).toMatchObject({ status: "waiting-approval", currentStage: "plan-gate" });

    const seedResponse = await post(app.baseUrl, "/api/seed", { specPath: "specs/EXAMPLE.md" });
    expect(seedResponse.status).toBe(201);
    const seeded = (await seedResponse.json()).item;
    const listing = await fetch(`${app.baseUrl}/api/work`).then((response) => response.json());
    expect(listing.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: prompted.id, status: "waiting-approval", currentStage: "plan-gate" }),
      expect.objectContaining({ id: seeded.id, status: "waiting-approval", currentStage: "plan-gate" }),
    ]));

    const detail = await fetch(`${app.baseUrl}/api/work/${seeded.id}`).then((response) => response.json());
    expect(detail.specText).toContain("Example");
    expect(detail.runs[0]).not.toHaveProperty("input");
    expect(detail.runs[0]).not.toHaveProperty("worktreePath");
    expect(detail.item).not.toHaveProperty("evidenceUri");
  });

  it("redacts nested host worktree paths from provenance detail and evidence", async () => {
    const app = await fixture();
    const created = await post(app.baseUrl, "/api/run", { prompt: "Add a health endpoint" }).then((response) => response.json());
    const id = created.item.id as string;
    const evidenceDirectory = join(app.root, "evidence", "runs", id);
    mkdirSync(evidenceDirectory, { recursive: true });
    writeFileSync(join(evidenceDirectory, "provenance.json"), JSON.stringify({
      promptHash: "a".repeat(64),
      worktreePath: "C:\\Users\\private\\worktree",
      roles: [{ role: "Implementer", worktreePath: "/home/private/worktree" }],
    }));

    const detail = await fetch(`${app.baseUrl}/api/work/${id}`).then((response) => response.json());
    expect(detail.provenance).toEqual({ promptHash: "a".repeat(64), roles: [{ role: "Implementer" }] });
    const evidence = await fetch(`${app.baseUrl}/api/work/${id}/evidence/provenance.json`).then((response) => response.json());
    expect(evidence).toEqual(detail.provenance);
  });

  it("rejects a gate action at the wrong stage and refuses non-loopback serve hosts", async () => {
    const app = await fixture();
    const created = await post(app.baseUrl, "/api/run", { prompt: "Add a GET /health endpoint to demo-app" }).then((response) => response.json());
    const wrongGate = await post(app.baseUrl, `/api/work/${created.item.id}/approve`, { gate: "merge" });
    expect(wrongGate.status).toBe(409);

    expect(() => parseServeOptions(["--host", "0.0.0.0"])).toThrow("Forge UI can only bind to 127.0.0.1");
    expect(() => parseServeOptions(["--host", "::"])).toThrow("Forge UI can only bind to 127.0.0.1");
    expect(parseServeOptions(["--host", "127.0.0.1", "--port", "8787"])).toEqual({ host: "127.0.0.1", port: 8787 });
  });

  it("denies evidence traversal and serves evidence as plain text", async () => {
    const app = await fixture();
    const created = await post(app.baseUrl, "/api/seed", { specPath: "specs/EXAMPLE.md" }).then((response) => response.json());
    const id = created.item.id as string;
    const safe = await fetch(`${app.baseUrl}/api/work/${id}/evidence/plan.md`);
    expect(safe.status).toBe(200);
    expect(safe.headers.get("content-type")).toContain("text/plain");
    expect(safe.headers.get("x-content-type-options")).toBe("nosniff");

    const traversal = await fetch(`${app.baseUrl}/api/work/${id}/evidence/${encodeURIComponent("../../.env")}`);
    expect(traversal.status).toBe(404);
    const secretSuffix = await fetch(`${app.baseUrl}/api/work/${id}/evidence/identity.key`);
    expect(secretSuffix.status).toBe(404);
  });

  it("serializes a concurrent approve/reject race through the existing work-item lease and gate", async () => {
    let announceStarted!: () => void;
    let unblock!: () => void;
    const started = new Promise<void>((resolveStarted) => { announceStarted = resolveStarted; });
    const wait = new Promise<void>((resolveWait) => { unblock = resolveWait; });
    const baseHarness = new StubHarness();
    const harness: HarnessAdapter = {
      name: "delayed-stub",
      async run(request) {
        if (request.stage === "author-tests") {
          announceStarted();
          await wait;
          return { success: false, changedFiles: [], tokensUsed: 0, usdCost: 0, summary: "Intentional race-test stop" };
        }
        return baseHarness.run(request);
      },
    };
    const app = await fixture({ harness });
    const created = await post(app.baseUrl, "/api/run", { prompt: "Add a health endpoint" }).then((response) => response.json());
    const id = created.item.id as string;
    const first = post(app.baseUrl, `/api/work/${id}/approve`, { gate: "plan" });
    await started;
    const second = await post(app.baseUrl, `/api/work/${id}/reject`, { gate: "plan", reason: "Concurrent decision" });
    unblock();
    const firstResponse = await first;
    expect(second.status).toBe(409);
    expect(firstResponse.status).toBe(502);
    expect((await firstResponse.json()).error).toContain("Intentional race-test stop");
  });

  it("shows the exact Docker failure and leaves the item queued without a completed bundle", async () => {
    const exactDockerError = "Could not start Docker sandbox: Cannot connect to the Docker daemon";
    const testExecutor: TestExecutor = { async run() { return { exitCode: 1, stdout: "", stderr: exactDockerError }; } };
    const app = await fixture({ testExecutor });
    const created = await post(app.baseUrl, "/api/run", { prompt: "Add a GET /health endpoint to demo-app" }).then((response) => response.json());
    const id = created.item.id as string;
    const response = await post(app.baseUrl, `/api/work/${id}/approve`, { gate: "plan" });
    const error = await response.json();
    expect(response.status).toBe(502);
    expect(error.error).toContain(exactDockerError);

    const detail = await fetch(`${app.baseUrl}/api/work/${id}`).then((result) => result.json());
    expect(detail.item).toMatchObject({ status: "queued", currentStage: "independent-review" });
    expect(detail.evidenceFiles).toContain("pre-review-test-output.txt");
    expect(detail.evidenceFiles).not.toContain("draft-pr.md");
    expect(detail.evidenceFiles).not.toContain("patch.diff");
    const output = await fetch(`${app.baseUrl}/api/work/${id}/evidence/pre-review-test-output.txt`).then((result) => result.text());
    expect(output).toContain(exactDockerError);
  });
});
