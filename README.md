# NightZero Control Panel

The Control Panel is the React/TypeScript operations console for NightZero. It displays Agent availability, incident lifecycle progress, RCA evidence, sandbox verification, and the human approval action. It communicates only with the NightZero Agent REST API; it does not clone repositories or manage GitHub pull requests.

## Run locally

From this repository, install dependencies and start the Vite development server:

```bash
npm install
VITE_NIGHTZERO_API_URL=http://localhost:8080 npm run dev
```

In another terminal, start `NightZero-Agent` with `NIGHTZERO_CORS_ORIGIN=http://localhost:5173`. The console polls `/health` and `/api/v1/incidents` every five seconds. Select an incident to view its RCA, diff, and fail-before/pass-after sandbox output.

For a local demo approval, enter a reviewer name and the Agent's demo token, `nightzero-demo`. The token is submitted directly to the Agent API and is never stored by the Control Panel.

## Validation

```bash
npm test
npm run build
npm run lint
```

## Configuration and safety

`VITE_NIGHTZERO_API_URL` is the only frontend configuration value. Use an HTTPS Agent API URL for a deployed console. Never set GitHub credentials, SSH keys, or a write-capable repository token in this project: GitHub automation belongs exclusively to `NightZero-Agent`.
