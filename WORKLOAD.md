# Forge workload

Last reconciled: 2026-09-27 (America/Mexico_City)

## In progress

| ID | Outcome | Status | Next action | Blocked by | Evidence | Last verified |
|---|---|---|---|---|---|---|
| FORGE-003 | Make host-side CodexHarness available for Forge jobs while keeping Docker verification honest | blocked | Start Docker Desktop until `docker info` returns server details, then restart the existing loopback server with `FORGE_HARNESS=codex` before the live New Job flow | Docker daemon is down; the preserved listener at `127.0.0.1:8787` still reports the older Stub API | `pnpm test` (37 passed); `pnpm typecheck`; `codex login status`; `README.md` | 2026-09-27 |

## Recently completed

| ID | Outcome | Evidence | Completed |
|---|---|---|---|
| FORGE-001 | Build the Forge software-factory vertical slice | `pnpm test` (25 tests); CLI `run` and `status` at the plan gate; focused gate, lease, budget, worktree, provenance, and packaging-recovery tests | 2026-09-27. Docker Desktop process started, but its service could not be opened with the current account; live Docker-backed execution remains unverified. |
| FORGE-002 | Add a local browser control room for Forge | `pnpm test` (30 tests across 5 files); browser JS syntax check; host refusal for `0.0.0.0`; live `forge serve` at `127.0.0.1:8787`; board and item detail read back in Codex browser; governance validation `valid: true` | 2026-09-27. Docker is down on this host; an unintended plan approval during visual inspection moved pre-existing item `forge-20260927-a5b6ccd9` to queued at `independent-review` (retry 1/2). Its recorded Docker error and candidate evidence remain; no merge approval was recorded. Await owner direction before further action on that item. |
