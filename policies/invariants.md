# Factory invariants

1. The spec and persisted work item are authoritative. Chats and sessions are disposable.
2. `factory.yaml` declares the workflow, exactly six LLM roles, harnesses, budgets, image, gates, and merge policy.
3. The control plane is CODE. It claims leases, advances the graph, checks gates, starts sandboxes, and packages evidence.
4. Workers receive no raw cloud keys, Forge secrets, host credentials, `.env` files, or unrestricted host environment.
5. Test Author, Implementer, and Independent Reviewer are separate runs. Reviewer input contains only spec, diff, and test output.
6. Every station uses a fresh sandbox. Implement and verify sandbox IDs are distinct; verification is a new worktree.
7. Only the control plane writes a patch/draft-PR bundle. The MVP never commits to main, pushes, force-pushes, or merges.
8. Merge approval is refused until verification is green and review is approved. A human still approves the merge gate.
9. SQLite leases prevent two workers from claiming one item at the same time. Expired leases can be reclaimed.
10. Token, USD, retry, and wall-clock budgets are finite. Exhaustion moves work to dead-letter.
11. Every candidate bundle records work ID, role, harness, model, prompt hash, sandbox IDs, and evidence paths.
12. Persist stage results before advancing. On restart, resume from the last durable stage, not from a chat transcript.
13. Self-improvement can only add a gated skill/rule PR; no agent edits the trusted control plane silently.
