# NightZero Control Panel 🌌
### Real-Time Autonomous SRE Command Center & Human Approval Gate

[![Live Dashboard](https://img.shields.io/badge/Live%20Dashboard-nightzero.web.app-38bdf8?style=for-the-badge&logo=firebase)](https://nightzero.web.app)
[![Tech Stack](https://img.shields.io/badge/React%2019-Vite%20%2B%20TypeScript-61DAFB?style=for-the-badge&logo=react)](https://react.dev)
[![Hosting](https://img.shields.io/badge/Firebase-Hosting%20%2B%20Auth-FFCA28?style=for-the-badge&logo=firebase)](https://firebase.google.com)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg?style=for-the-badge)](LICENSE)

---

## 📌 Overview

**NightZero Control Panel** is the real-time SRE operator interface for NightZero. It provides:
1. **Live Incident Feed**: Visualizes real-time incident telemetry, severity classification, and automated triage deduplication.
2. **Forensic Intelligence Explorer**:
   - **Timeline Trail**: Chronological event sequence (Precursor commit → Error Trigger → Failure Point → Detection).
   - **Culprit Attribution**: Offending commit hash, author blame avatar, and timestamp.
   - **AST Unified Diff Visualizer**: Side-by-side syntax comparison of the original code vs. sandbox-verified patch.
   - **CI/CD Prevention Gaps**: Synthesized preventative test suites to close testing blindspots permanently.
   - **Audit Trail & Identity Feed**: Live log stream of every subagent action with cryptographic SPIFFE signatures.
3. **Enterprise Human Approval Gate**: Verified single-click authorization to trigger isolated GitHub branch creation and Draft Pull Request generation.
4. **Vertex AI Model Selector**: Dynamically toggle between `gemini-2.5-flash`, `gemini-2.5-pro`, and preview agent models.

---

## 🔑 Live Demo Access for Hackathon Judges

- **Live URL**: [**https://nightzero.web.app**](https://nightzero.web.app)
- **Authentication Options**:
  - **Google Sign-In**: Click "Sign in with Google"
  - **Demo Reviewer Credentials**:
    - **Email**: `nightzero-judges@asuracore.com`
    - **Password**: `nightzero-demo`

---

## 🛠️ Local Setup & Development

```bash
# 1. Install dependencies
npm install

# 2. Run unit test suite
npm test

# 3. Start local development server
npm run dev

# 4. Build for production
npm run build
```

---

## 📜 License
Licensed under the [Apache License 2.0](LICENSE).
