import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

interface RequestBase {
  workId: string;
  sandboxId: string;
  specText: string;
}

export interface PlannerRequest extends RequestBase {
  role: "Planner";
  stage: "plan";
  workspacePath: string;
}

export interface AuthorTestsRequest extends RequestBase {
  role: "Test Author";
  stage: "author-tests";
  workspacePath: string;
}

export interface ImplementRequest extends RequestBase {
  role: "Implementer";
  stage: "implement";
  workspacePath: string;
}

export interface ReviewerRequest {
  role: "Independent Reviewer";
  stage: "independent-review";
  workId: string;
  sandboxId: string;
  specText: string;
  diff: string;
  testOutput: string;
  workspacePath?: string;
}

export type HarnessRequest = PlannerRequest | AuthorTestsRequest | ImplementRequest | ReviewerRequest;

export interface HarnessResult {
  success: boolean;
  changedFiles: string[];
  tokensUsed: number;
  usdCost: number;
  summary: string;
  approved?: boolean | undefined;
  model?: string | undefined;
  promptHash?: string | undefined;
  errorCode?: string | undefined;
}

export interface HarnessAdapter {
  readonly name: string;
  run(request: HarnessRequest): Promise<HarnessResult>;
}

const HEALTH_TEST = `import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";

describe("generated health endpoint", () => {
  const app = buildApp();
  afterAll(async () => app.close());

  it("returns a healthy response", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
  });
});
`;

export class StubHarness implements HarnessAdapter {
  readonly name = "stub";

  async run(request: HarnessRequest): Promise<HarnessResult> {
    if (request.stage === "plan") {
      const title = request.specText.split(/\r?\n/).find((line) => line.trim())?.replace(/^#+\s*/, "").trim() || "Forge work item";
      const plan = [
        "# Plan: " + title,
        "",
        "## Task DAG",
        "",
        "1. Test Author: turn the acceptance criteria into a focused failing test.",
        "2. Implementer: make the test pass in a separate worktree.",
        "3. Independent Reviewer: inspect only the spec, diff, and test output.",
        "4. CODE: verify the candidate in a fresh sandbox.",
        "5. Integrator: package the patch and provenance after the human merge-gate approval.",
        "",
        "## Gate",
        "",
        "Waiting for human approval before any implementation work starts.",
        "",
      ].join("\n");
      writeFileSync(join(request.workspacePath, "plan.md"), plan, { flag: "wx" });
      return { success: true, changedFiles: ["plan.md"], tokensUsed: 1, usdCost: 0, summary: "Wrote the deterministic plan." };
    }

    if (request.stage === "author-tests") {
      if (!/GET\s+\/health/i.test(request.specText)) {
        return { success: false, changedFiles: [], tokensUsed: 0, usdCost: 0, summary: "StubHarness supports only the documented GET /health fixture." };
      }
      const target = join(request.workspacePath, "demo-app", "tests", "generated-health.test.ts");
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, HEALTH_TEST, { flag: "wx" });
      return {
        success: true,
        changedFiles: ["demo-app/tests/generated-health.test.ts"],
        tokensUsed: 1,
        usdCost: 0,
        summary: "Added the failing GET /health acceptance test from the spec.",
      };
    }

    if (request.stage === "implement") {
      if (!/GET\s+\/health/i.test(request.specText)) {
        return { success: false, changedFiles: [], tokensUsed: 0, usdCost: 0, summary: "StubHarness supports only the documented GET /health fixture." };
      }
      const relativePath = "demo-app/src/app.ts";
      const target = join(request.workspacePath, relativePath);
      const source = readFileSync(target, "utf8");
      if (source.includes('app.get("/health"')) {
        return { success: true, changedFiles: [], tokensUsed: 1, usdCost: 0, summary: "Health route already exists." };
      }
      const anchor = '  app.get<{ Reply: Todo[] }>("/todos", async () => todos);';
      if (!source.includes(anchor)) throw new Error("StubHarness could not find the demo todo route anchor");
      writeFileSync(target, source.replace(anchor, `  app.get("/health", async () => ({ status: "ok" }));\n\n${anchor}`));
      return {
        success: true,
        changedFiles: [relativePath],
        tokensUsed: 1,
        usdCost: 0,
        summary: "Added the deterministic GET /health implementation.",
      };
    }

    const approved = request.diff.includes("/health") && /pass|green|0 fail/i.test(request.testOutput);
    return {
      success: true,
      changedFiles: [],
      tokensUsed: 1,
      usdCost: 0,
      summary: approved ? "Diff and passing test output satisfy the spec." : "Review rejected: the diff or tests do not satisfy the spec.",
      approved,
    };
  }
}

export function reviewerInput(request: ReviewerRequest): ReviewerRequest {
  // Construct a new object so no implementer transcript or execution metadata can leak into review.
  return {
    role: "Independent Reviewer",
    stage: "independent-review",
    workId: request.workId,
    sandboxId: request.sandboxId,
    specText: request.specText,
    diff: request.diff,
    testOutput: request.testOutput,
  };
}

export function workspaceFileExists(workspacePath: string, relativePath: string): boolean {
  return existsSync(join(workspacePath, relativePath));
}
