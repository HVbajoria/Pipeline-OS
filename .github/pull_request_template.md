## Summary

<!-- What problem does this change solve? What behavior is changing? -->

## Change type

- [ ] Bug fix
- [ ] New feature
- [ ] Refactor or maintenance
- [ ] Documentation or governance
- [ ] Dependency or security update
- [ ] Deployment or configuration change

## Scope and impact

<!-- Describe affected UI flows, operations, HTTP routes, MCP tools, roles, tenants, resources, and compatibility behavior. -->

### Affected users and surfaces

- Audiences: <!-- candidate / recruiter / hiring manager / interviewer / agent / operator -->
- Surfaces: <!-- UI / HTTP API / MCP / WebMCP / persistence / deployment / docs -->
- Operations or routes: <!-- list names, or N/A -->

### Security and privacy

<!-- Explain authorization, tenant isolation, consent, approval, audit, redaction, retention, or data-access implications. -->

- [ ] I considered authentication and authorization impact.
- [ ] I considered tenant/resource-scope isolation.
- [ ] I considered candidate/recruiter privacy and audit implications.
- [ ] I did not weaken fail-closed behavior, approval gates, consent checks, or redaction.
- [ ] This PR does not contain credentials, tokens, service-account files, personal data, resumes, or production records.

## Implementation notes

<!-- Describe important design decisions, migrations, compatibility concerns, or follow-up work. -->

## Validation

<!-- Include commands and relevant results. -->

- [ ] `npm run lint`
- [ ] `npm test`
- [ ] `npm run build`
- [ ] Manual smoke test completed where applicable.
- [ ] Tests were added or updated for changed behavior, or the reason no test is needed is documented below.

Validation notes:

## Deployment and rollback

<!-- Include environment variables, persistence changes, migrations, rollout considerations, and rollback steps. Use placeholders; never include secret values. -->

- Configuration or migration required: <!-- none / describe -->
- Deployment notes: <!-- none / describe -->
- Rollback plan: <!-- describe -->

## Checklist

- [ ] I read [CONTRIBUTING.md](../../CONTRIBUTING.md), [SECURITY.md](../../SECURITY.md), and the [Code of Conduct](../../CODE_OF_CONDUCT.md).
- [ ] The change is compatible with the MIT License and the project’s contribution guidelines.
- [ ] I kept unrelated changes out of this PR.
- [ ] I reviewed the staged diff and checked for secrets before pushing.
- [ ] Documentation, schemas, operation descriptors, or deployment instructions were updated where needed.
- [ ] This PR is ready for maintainer review.
