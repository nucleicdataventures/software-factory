# Example work request

## Goal

Add a `GET /health` endpoint to the demo API.

## Acceptance criteria

- `GET /health` returns HTTP 200 and JSON `{ "status": "ok" }`.
- Existing todo API behavior stays green.
- The change is verified in a fresh sandbox.

## Constraints

- Keep the endpoint in `demo-app`.
- Do not commit or merge the patch.
