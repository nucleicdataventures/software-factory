# Forge

Forge is a self-hosted software factory: a ticket or spec becomes an isolated, verified patch with evidence. Humans own the spec and approvals. Workers never merge code or receive cloud keys.

## Run the demo

Use Node 22 and pnpm 10, then run `pnpm install` and `pnpm test`. Start a work item with:

```sh
pnpm --filter cli exec forge run "add a GET /health endpoint to demo-app"
```

Forge writes specs/<id>.md, records the work item in .forge/forge.db, writes a plan, and stops at the required plan gate. Inspect it with forge status <id> and resume with forge approve <id> plan. The deterministic StubHarness remains the default and needs no API account. Approving the plan runs candidate and fresh-verification tests in Docker, so Docker Desktop must be running. forge approve <id> merge releases a local patch/draft-PR bundle only. It never merges.

## How to test in the browser

Run `pnpm build`, then `pnpm --filter cli exec forge serve --host 127.0.0.1 --port 8787` and open [http://127.0.0.1:8787](http://127.0.0.1:8787); the browser is the factory floor for creating work, inspecting evidence, and approving the plan and merge gates, while the factory itself remains the orchestrator that owns state, leases, sandboxes, and stage execution.

## How a request becomes a patch

`factory.yaml` is the contract. The CLI creates a durable work item, then the explicit graph runs Intake → Planner → plan approval → Test Author → Implementer → Independent Reviewer → fresh verification → merge approval → Integrator. Test authoring, implementation, and verification use separate worktrees and sandbox IDs. Review input is limited to the spec, candidate diff, and test output. Every stage records its run and evidence so work can resume after a process exits.

Forge ships the deterministic StubHarness and the host-side CodexHarness. Codex runs against the job worktree using the host login; Docker remains the test and verification executor and receives only the existing safe environment allowlist. See [policies/invariants.md](policies/invariants.md) for the enforcement rules.

## Live harness (Codex)

The Codex harness runs Planner, Test Author, Implementer, and Independent Reviewer with codex exec against each isolated job worktree on the host. Plus login stays on the host. Docker verifies. Humans still own plan and merge.

The default remains stub. Run `codex login status` on the host; if it reports logged out, run `codex login` there. The health strip shows the selected harness and Codex login state. To launch a Codex session in PowerShell, stop an older `forge serve` process from its terminal, then run:

```powershell
$env:FORGE_HARNESS = "codex"
pnpm --filter cli exec forge serve --host 127.0.0.1 --port 8787
```

Set `FORGE_CODEX_BIN` or `FORGE_DOCKER_BIN` to override executable discovery.

On Windows, open Start → Docker Desktop, then wait for its dashboard to report that the engine is running. In PowerShell, run `docker info` and confirm it prints the Server section before approving a plan. If Docker is down, Forge keeps the last good stage and reports the Docker error; it does not skip verification.
