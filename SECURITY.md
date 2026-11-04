# Security Policy

AllWeave Build is a local, single-user workbench. The service binds to
`127.0.0.1`, runs with the permissions of the user that starts it, and is not
designed for public exposure or multi-tenant isolation.

The local user account, the workspace, and files writable by that account are
inside the same trust boundary as the AllWeave process. If an attacker can
modify the workspace, shell startup files, environment, or AllWeave data
directory, they can generally influence the workbench or other local developer
tools. Reports that require this prior local write access are not security
boundary violations unless they show AllWeave granting access across an OS
privilege boundary.

AllWeave loads model providers, MCP servers, skills, and application plugins
chosen by the user. Only use trusted providers, MCP servers, repositories, and
manifests. Prompt injection through repository files or model output is expected
input, not a vulnerability.

## Reporting a Vulnerability

Report privately through GitHub Security Advisories for this repository. Include:

- a description of the issue and its impact;
- steps to reproduce, a proof of concept, or relevant logs;
- the affected package, version, commit, or configuration;
- any known mitigations.

Do not open a public issue for a security-sensitive report.

## Scope

- Repository code, published `@allweave/*` packages, and the desktop application.
- Authentication and authorization boundaries inside the workbench.
- File, command, model, MCP, browser, and sandbox isolation bugs.
- Credential handling and accidental credential disclosure.
- Dependency vulnerabilities reachable through the shipped runtime.

## Out of Scope

- Prompt injection or malicious model output.
- Behavior of user-installed skills, MCP servers, plugins, or models.
- Risks from working in untrusted repositories or opening untrusted documents.
- Local code execution or host-tool behavior that the user approved.
- Missing OS-level sandboxing: the embedded QuickJS sandbox limits script
  memory, output, and time, but host tools run with the user's permissions.
- Public internet exposure or multi-user isolation; the server is loopback-only.
- Reports requiring the ability to modify local files, environment variables,
  shell configuration, or the AllWeave data directory, unless they show a
  privilege boundary bypass.
- Denial-of-service claims that require trusted local input or configuration.

## Notes for Reporters

The most useful reports show a current, reproducible boundary bypass with
demonstrated impact. Include the exact path, package version or commit,
configuration, and a proof of concept against the latest release or `main`.
For dependency reports, include evidence that the shipped dependency is
affected and reachable through AllWeave.
