# Contributing to PipelineOS

Thank you for helping improve PipelineOS. This project is released under the [MIT License](LICENSE), and contributions are welcome under the terms described below.

## Before you start

- Read the [LICENSE](LICENSE), [Code of Conduct](CODE_OF_CONDUCT.md), and [Security Policy](SECURITY.md).
- For a substantial change, open a proposal or discuss the design with a maintainer first.
- Never include credentials, service-account files, access tokens, candidate data, resumes, production records, or other private information in an issue, commit, test fixture, screenshot, or pull request.
- Do not report suspected vulnerabilities in a public issue. Follow [SECURITY.md](SECURITY.md).

## Development setup

Requirements:

- Node.js 20, 21, or 22
- npm 10.8.2 or a compatible npm 10 release

Install and run the deterministic demo:

```bash
npm ci
npm run dev
```

The development server runs at `http://localhost:3000` unless `PORT` is set. Use `PERSISTENCE_BACKEND=memory` for local demo work. Keep real credentials in an untracked `.env` file; `.env.example` contains placeholders only.

## Required checks

Before opening a pull request, run the checks relevant to your change. For normal source changes, run all three:

```bash
npm run lint
npm test
npm run build
```

Tests use Vitest in one-shot mode. Do not commit generated `dist/`, coverage output, logs, local `.env` files, or service-account keys.

## Architecture expectations

- Route UI, WebMCP, MCP, and compatibility calls through the canonical operation registry and `OperationService`; do not add a second business-logic path.
- Keep authorization, tenant checks, consent, approval, validation, idempotency, lifecycle transitions, and audit behavior at their existing centralized boundaries.
- Preserve actor/resource-scoped projections and fail-closed behavior in production.
- Treat candidate and recruiter data as sensitive. Redact private inputs, credentials, consent evidence, and tokens at transport and logging boundaries.
- Keep operation schemas and outputs JSON-serializable and update the shared registry when adding an operation.
- Prefer deterministic, isolated tests with injected clocks, IDs, repositories, and principals.
- Do not weaken authorization or security controls to make a test or demo pass.

## Pull requests

Use the repository pull-request template. A good pull request should:

1. Explain the problem and the intended behavior.
2. Describe affected operations, roles, tenants, APIs, MCP tools, and UI flows.
3. Include tests or explain why a test is not applicable.
4. Include migration, deployment, configuration, and rollback notes where relevant.
5. Call out security, privacy, data-retention, or backward-compatibility implications.
6. Keep unrelated refactors out of the change.

Maintainers may request revisions, additional tests, documentation, or security review before merging.

## Commit guidance

Use concise, imperative commit messages, for example:

```text
Add tenant scope to candidate projection
Fix MCP approval-card redaction
```

Do not commit secrets. Review `git diff --cached` before committing, and use secret scanning or a local scanner when available.

## Reporting problems

Use the bug or feature issue forms for normal product and engineering feedback. For vulnerabilities, exposed credentials, authorization bypasses, tenant isolation failures, or personal-data exposure, use the private process in [SECURITY.md](SECURITY.md).
