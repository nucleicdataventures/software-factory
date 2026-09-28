# Forge memory

Scope: this repository
Kind: semantic
Status: active
Last updated: 2026-09-28 (America/Mexico_City)
Sensitivity: publishable

## Durable decisions

- Forge is a self-hosted, MIT-licensed monorepo. Humans own specs and gate approvals; trusted control-plane code packages patches; agents never merge.
- `factory.yaml` is the workflow contract. Keep the six specified roles and the CLI-only inlet.
- The first implementation uses a deterministic `StubHarness`; the `HarnessAdapter` boundary allows existing coding agents later without building a new harness.
- `CodexHarness` runs Planner, Test Author, Implementer, and Independent Reviewer on the host against per-role job work directories. Keep `stub` as the default and let `FORGE_HARNESS` select `codex` for one serve process. Host Codex login never enters Docker; Docker remains the test and verification executor with its existing safe environment allowlist.
- Verified 2026-09-28: host executable discovery is centralized in `packages/worker/src/binaries.ts`. Health and CodexHarness share the resolved absolute Codex path; Docker health and sandbox execution use the resolved absolute Docker path. Windows `.cmd` and `.bat` launches go through `cmd.exe` with temporary environment references so literal `%NAME%` path components and shell metacharacters survive.
- The host Codex Planner uses low reasoning effort and a bounded, no-scan plan prompt under the configured per-item token cap. Keep budget enforcement fail-closed: live Planner attempts that exceed `factory.yaml`'s cap are dead-lettered and must not receive a gate approval; resolve the cap mismatch before retrying live verification.
- Keep the Reviewer context directory empty; its prompt contains only the spec, candidate diff, and test output. Use Codex read-only sandbox mode for that role.
- Gate decisions are transactional, stage leases stay owner-fenced, and harness usage is validated and recorded even when a lease is lost. Failed runs count toward the wall-clock budget; fresh worktrees start without tracked file contents.
- Nucleic Data Ventures is isolated from Trust23. Do not reuse its credentials, tenants, or environment identifiers.
- The browser control room is a local view over the existing Orchestrator and Ledger. `forge serve` binds only to `127.0.0.1`; the UI does not add a workflow inlet, change `factory.yaml`, or replace the CLI.
- The browser API returns allowlisted item/run fields, serves evidence as text from the item evidence directory, and keeps reviewer material to the spec, candidate diff, and verification output. Docker availability is observational; a failed Docker-backed stage remains at its recorded retryable or dead-letter state.
