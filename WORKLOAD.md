# Forge workload

Last reconciled: 2026-09-28 (America/Mexico_City)

## In progress

| ID | Outcome | Status | Next action | Blocked by | Evidence | Last verified |
|---|---|---|---|---|---|---|
| FORGE-003 | Make host-side CodexHarness available for Forge jobs while keeping Docker verification honest | blocked | Resolve the per-item token budget for live host Codex verification before another Planner run; preserve the three dead-lettered jobs and their plans | All three real Planner attempts exceeded the configured 30,000-token per-item cap (339,370; 134,954; 80,399); Forge dead-lettered them and recorded no gate approvals, including for the plan the user authorized | `pnpm test` (48 passed across 6 files); focused CodexHarness tests (11/11); Gitleaks clean; `GET /api/health` on `127.0.0.1:8789` reported Docker up, Codex logged-in, harness codex; runs and plans retained in `.forge`; latest verification logs under `Projects/.memory/workspace-git-sync/verification/20260928T092528-software-factory-full-final/`, `20260928T092628-software-factory-security-final/`, and `20260928T092720-forge-final-bounded-run/` | 2026-09-28 |

## Recently completed

| ID | Outcome | Evidence | Completed |
|---|---|---|---|
| FORGE-001 | Build the Forge software-factory vertical slice | `pnpm test` (25 tests); CLI `run` and `status` at the plan gate; focused gate, lease, budget, worktree, provenance, and packaging-recovery tests | 2026-09-27. Docker Desktop process started, but its service could not be opened with the current account; live Docker-backed execution remains unverified. |
| FORGE-002 | Add a local browser control room for Forge | `pnpm test` (30 tests across 5 files); browser JS syntax check; host refusal for `0.0.0.0`; live `forge serve` at `127.0.0.1:8787`; board and item detail read back in Codex browser; governance validation `valid: true` | 2026-09-27. Docker is down on this host; an unintended plan approval during visual inspection moved pre-existing item `forge-20260927-a5b6ccd9` to queued at `independent-review` (retry 1/2). Its recorded Docker error and candidate evidence remain; no merge approval was recorded. Await owner direction before further action on that item. |
