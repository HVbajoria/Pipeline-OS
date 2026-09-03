# Security Policy

PipelineOS processes recruiting information and exposes HTTP, MCP, WebMCP, authentication, authorization, and persistence surfaces. Please report security issues responsibly and do not disclose sensitive details publicly.

## Supported versions

| Version | Supported |
| --- | --- |
| `1.x` | Yes |
| `< 1.0` | No |

Support status may change while the project is in active development.

## Report privately

**Do not open a public GitHub issue for a suspected vulnerability.** Use GitHub’s private vulnerability reporting or a private security advisory for this repository when available. If that option is unavailable, contact the repository owner privately through their GitHub profile and request a secure reporting channel.

Do not include secrets or personal data in the initial report. If sensitive evidence is necessary, describe how it can be shared securely instead of attaching it to a public issue or pull request.

## What to include

Please provide:

- A concise description of the issue and its security impact.
- The affected version, commit, deployment, or endpoint.
- Reproduction steps or a minimal proof of concept that does not access real data.
- The roles, tenant boundary, resource type, or MCP/API surface involved.
- Any logs, traces, or screenshots after removing credentials, tokens, candidate data, resumes, email addresses, and other personal information.
- A suggested mitigation, if you have one.

Useful report categories include authentication or token validation failures, authorization or tenant-isolation bypasses, MCP tool abuse, sensitive-data disclosure, injection or SSRF, secret exposure, dependency vulnerabilities, and unsafe deployment configuration.

## If a secret is exposed

Treat an exposed credential as compromised immediately:

1. Revoke or rotate it with the provider.
2. Disable or restrict the affected account, key, token, or service account.
3. Preserve only the minimum evidence needed for investigation.
4. Remove it from the working tree and Git history through the approved maintainer process.
5. Check deployment logs, CI logs, artifact stores, and access logs for use of the credential.
6. Do not paste the secret into an issue, chat, commit message, or pull request.

Removing a secret from the latest commit does not make it safe if it exists in repository history. Contact a maintainer before rewriting shared history.

## Response process

Maintainers will acknowledge a report when practical, assess severity and affected versions, coordinate remediation, and communicate a fix or mitigation. Disclosure timing will be determined with the reporter based on exploitability, affected users, and release readiness.

Please do not perform destructive testing, access other users’ data, bypass consent or approval controls, or test against production without explicit written authorization.
