import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { ROLES, WORKFLOW_STAGES, type Role, type WorkflowStage } from "ledger";
import { CodexHarness, StubHarness, type HarnessAdapter } from "worker";

export interface GraphNode {
  stage: WorkflowStage;
  role?: Role;
  gate?: "plan" | "merge";
  executor?: "CODE";
  next: string;
}

export interface FactoryConfig {
  version: number;
  inlets: string[];
  graph: GraphNode[];
  roles: Role[];
  harnesses: { default: string; [name: string]: unknown };
  budgets: { defaults: { tokens: number; usd: number; retries: number; wall_clock_seconds: number } };
  sandbox: { image: string; network: string; read_only_root: boolean; writable_mount: string };
  gates: { plan: string; merge: string };
  merge_policy: { mode: string; auto_merge: boolean; force_push: boolean };
}

export function loadFactoryConfig(repoRoot: string): FactoryConfig {
  const factory = parse(readFileSync(join(repoRoot, "factory.yaml"), "utf8")) as FactoryConfig;
  const workflow = parse(readFileSync(join(repoRoot, "workflows", "default.yaml"), "utf8")) as {
    nodes?: Array<{ id: string; next: string; role?: string; gate?: string; executor?: string }>;
  };
  validateFactoryConfig(factory, workflow.nodes ?? []);
  return factory;
}

export function validateFactoryConfig(factory: FactoryConfig, workflowNodes: Array<{ id: string; next: string; role?: string; gate?: string; executor?: string }>): void {
  const expectedRoles = [...ROLES].sort();
  const actualRoles = [...factory.roles].sort();
  if (JSON.stringify(actualRoles) !== JSON.stringify(expectedRoles)) throw new Error("factory.yaml must declare exactly the six supported roles");
  if (factory.inlets.length !== 1 || factory.inlets[0] !== "cli") throw new Error("MVP supports the CLI inlet only");
  if (factory.gates.plan !== "required" || factory.gates.merge !== "required") throw new Error("Plan and merge gates are required");
  if (factory.merge_policy.auto_merge || factory.merge_policy.force_push) throw new Error("Auto-merge and force-push are forbidden");
  if (factory.merge_policy.mode !== "local-patch-or-draft-pr-bundle") throw new Error("Unsupported merge policy");
  for (const name of Object.keys(factory.harnesses).filter((key) => key !== "default")) {
    if (name !== "stub" && name !== "codex") throw new Error("Unknown harness name: " + name);
  }
  if (!factory.harnesses.stub || !factory.harnesses.codex) throw new Error("factory.yaml must declare both stub and codex harnesses");
  if (factory.sandbox.image !== "node:22-bookworm-slim") throw new Error("Use only the approved official Node 22 sandbox image");
  if (factory.sandbox.network !== "none" || !factory.sandbox.read_only_root) throw new Error("Sandbox network and root filesystem must be locked down");
  if (!factory.harnesses[factory.harnesses.default]) throw new Error("The default harness must be declared");
  if (factory.budgets.defaults.tokens <= 0 || factory.budgets.defaults.usd <= 0 || factory.budgets.defaults.retries < 0 || factory.budgets.defaults.wall_clock_seconds <= 0) {
    throw new Error("All factory budgets must be finite non-negative limits");
  }
  const stages = factory.graph.map((node) => node.stage);
  if (JSON.stringify(stages) !== JSON.stringify([...WORKFLOW_STAGES].slice(0, -1))) throw new Error("factory.yaml graph has missing, extra, or reordered workflow stages");
  const expectedNodes = factory.graph.map((node) => ({ id: node.stage, next: node.next, role: node.role, gate: node.gate, executor: node.executor }));
  const normalize = (nodes: typeof workflowNodes) => nodes.map((node) => ({ id: node.id, next: node.next, role: node.role, gate: node.gate, executor: node.executor }));
  if (JSON.stringify(normalize(workflowNodes)) !== JSON.stringify(normalize(expectedNodes as typeof workflowNodes))) {
    throw new Error("workflows/default.yaml must match the graph declared in factory.yaml");
  }
}

export type HarnessName = "stub" | "codex";

export function resolveHarnessName(factory: FactoryConfig, override?: string): HarnessName {
  const selected = override?.trim() || factory.harnesses.default;
  if (selected !== "stub" && selected !== "codex") throw new Error("Unknown harness name: " + selected + ". Choose stub or codex.");
  if (!factory.harnesses[selected]) throw new Error("Harness is not declared in factory.yaml: " + selected);
  return selected;
}

export function createHarnessAdapter(factory: FactoryConfig, override?: string): HarnessAdapter {
  const name = resolveHarnessName(factory, override);
  if (name === "stub") return new StubHarness();
  return new CodexHarness({ timeoutMs: factory.budgets.defaults.wall_clock_seconds * 1000, tokenLimit: factory.budgets.defaults.tokens });
}

export function roleForStage(factory: FactoryConfig, stage: WorkflowStage): Role | null {
  return factory.graph.find((node) => node.stage === stage)?.role ?? null;
}
