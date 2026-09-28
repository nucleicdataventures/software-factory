#!/usr/bin/env node
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createForgeHttpServer } from "api";
import { initializeWorkspace, Orchestrator } from "control-plane";
import type { Gate } from "ledger";

function findRepoRoot(start: string): string {
  let current = resolve(start);
  while (true) {
    if (existsSync(join(current, "factory.yaml"))) return current;
    const parent = dirname(current);
    if (parent === current) return resolve(start);
    current = parent;
  }
}

function printUsage(): void {
process.stdout.write(`forge init\nforge seed <spec-path>\nforge run <request>\nforge status <id>\nforge approve <id> plan|merge\nforge reject <id> --reason <text>\nforge evidence <id>\nforge resume <id>\nforge serve [--host 127.0.0.1] [--port 8787]\n`);
}

export interface ServeOptions {
  host: "127.0.0.1";
  port: number;
}

export function parseServeOptions(args: string[]): ServeOptions {
  let host = "127.0.0.1";
  let port = 8787;
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    const value = args[index + 1];
    if (option !== "--host" && option !== "--port") throw new Error(`Unknown serve option: ${option}`);
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${option}`);
    if (option === "--host") host = value;
    else {
      port = Number(value);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Port must be an integer from 1 to 65535");
    }
    index += 1;
  }
  if (host !== "127.0.0.1") throw new Error("Forge UI can only bind to 127.0.0.1");
  return { host, port };
}

function parseGate(value: string | undefined): Gate {
  if (value === "plan" || value === "merge") return value;
  throw new Error("Gate must be plan or merge");
}

export async function runCli(argv = process.argv.slice(2), cwd = process.cwd()): Promise<number> {
  const [command, ...args] = argv;
  if (!command || command === "help" || command === "--help") {
    printUsage();
    return 0;
  }
  const root = findRepoRoot(cwd);

  if (command === "init") {
    const ledger = initializeWorkspace(root);
    ledger.close();
    process.stdout.write(`Forge initialized at ${root}\nSQLite ledger: .forge/forge.db\n`);
    return 0;
  }

  if (command === "serve") {
    const options = parseServeOptions(args);
    const orchestrator = new Orchestrator(root, { harnessName: process.env.FORGE_HARNESS });
    const server = createForgeHttpServer({ root, orchestrator, uiDirectory: join(root, "packages", "ui", "dist") });
    try {
      await new Promise<void>((resolveListen, rejectListen) => {
        server.once("error", rejectListen);
        server.listen(options.port, options.host, () => {
          server.removeListener("error", rejectListen);
          resolveListen();
        });
      });
    } catch (error) {
      orchestrator.ledger.close();
      throw error;
    }
    process.stdout.write(`Forge control room: http://${options.host}:${options.port}\nPress Ctrl+C to stop.\n`);
    return new Promise<number>((resolveServe) => {
      let closing = false;
      const shutdown = () => {
        if (closing) return;
        closing = true;
        server.close(() => {
          orchestrator.ledger.close();
          resolveServe(0);
        });
      };
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
      server.once("close", () => {
        process.removeListener("SIGINT", shutdown);
        process.removeListener("SIGTERM", shutdown);
        if (!closing) orchestrator.ledger.close();
        resolveServe(0);
      });
    });
  }

  const ledger = initializeWorkspace(root);
  ledger.close();
  const orchestrator = new Orchestrator(root, { harnessName: process.env.FORGE_HARNESS });
  try {
    if (command === "seed") {
      const reference = args[0];
      if (!reference) throw new Error("Usage: forge seed <spec-path>");
      const item = await orchestrator.seed(reference);
      process.stdout.write(`Seeded ${item.id}; plan is waiting at plan-gate.\n`);
      return 0;
    }

    if (command === "run") {
      const request = args.join(" ").trim();
      if (!request) throw new Error('Usage: forge run "<request>"');
      const item = await orchestrator.createFromPrompt(request);
      process.stdout.write(`Created ${item.id}; paused at plan-gate.\nSpec: ${item.specRef}\nPlan: ${item.evidenceUri}/plan.md\n`);
      return 0;
    }

    if (command === "status") {
      const id = args[0];
      if (!id) throw new Error("Usage: forge status <id>");
      const view = orchestrator.getView(id);
      if (!view.item) throw new Error(`Unknown work item: ${id}`);
      process.stdout.write(`${JSON.stringify(view, null, 2)}\n`);
      return 0;
    }

    if (command === "approve") {
      const id = args[0];
      if (!id) throw new Error("Usage: forge approve <id> plan|merge");
      const item = await orchestrator.approve(id, parseGate(args[1]));
      process.stdout.write(`${item.id}: ${item.status} at ${item.currentStage}\n`);
      return 0;
    }

    if (command === "reject") {
      const id = args[0];
      const reasonIndex = args.indexOf("--reason");
      if (!id || reasonIndex < 0 || !args[reasonIndex + 1]) throw new Error('Usage: forge reject <id> --reason "<reason>"');
      const reason = args.slice(reasonIndex + 1).join(" ");
      const item = orchestrator.reject(id, reason);
      process.stdout.write(`${item.id}: rejected at ${item.currentStage}\n`);
      return 0;
    }

    if (command === "evidence") {
      const id = args[0];
      if (!id) throw new Error("Usage: forge evidence <id>");
      const view = orchestrator.getView(id);
      if (!view.item) throw new Error(`Unknown work item: ${id}`);
      process.stdout.write(`${JSON.stringify({ evidenceUri: view.item.evidenceUri, evidence: view.evidence }, null, 2)}\n`);
      return 0;
    }

    if (command === "resume") {
      const id = args[0];
      if (!id) throw new Error("Usage: forge resume <id>");
      const item = await orchestrator.resume(id);
      process.stdout.write(`${item.id}: ${item.status} at ${item.currentStage}\n`);
      return 0;
    }

    printUsage();
    return 2;
  } finally {
    orchestrator.ledger.close();
  }
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && realpathSync(resolve(process.argv[1])).toLowerCase() === realpathSync(thisFile).toLowerCase()) {
  runCli().then((code) => { process.exitCode = code; }).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
