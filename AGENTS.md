# Forge agent rules

Forge's control plane owns work state, approvals, leases, sandbox creation, and evidence. Workers are untrusted and may only edit their assigned job worktree.

- Keep `factory.yaml` as the executable contract and `workflows/default.yaml` in sync with it.
- Use exactly six LLM roles: Intake, Planner, Test Author, Implementer, Independent Reviewer, Integrator. The orchestrator is CODE, not an LLM role.
- Keep Test Author and Implementer as distinct runs. Never pass a worker's private reasoning or conversation to another role.
- Independent Reviewer receives only the spec, candidate diff, and verification output.
- Give each station a fresh sandbox. Implement and verify sandbox IDs must differ.
- Pass only an explicit safe environment allowlist into a sandbox. Never pass API keys, Forge secrets, `.env` files, SSH material, or host credentials.
- Only the trusted control plane may create a local patch or draft-PR bundle. Workers never merge, push, force-push, or write to `demo-app` main.
- Require both passing fresh-sandbox verification and independent review before opening the merge gate. A human approves the gate; the Integrator packages evidence and never merges in the MVP.
- Persist a checkpoint after every stage. Enforce token, USD, retry, and wall-clock limits; exhausted work goes to dead-letter.
- Keep code and tests in this repository. Do not add Temporal, NATS, Firecracker, Dolt, Slack, Linear, or Sigstore in pass 1.
