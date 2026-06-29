# Release Process

This repository is released from `main` after CI and local release gates pass.

Before publishing or tagging a release:

1. Confirm `README.md`, `CHANGELOG.md`, `SECURITY.md`, contracts, and examples
   are current.
2. Run `npm audit`.
3. Run `npm run typecheck`.
4. Run `npm run build`.
5. Run `npm test`.
6. Run a current-source secret scan with `gitleaks dir --redact .`.
7. Confirm `npm pack --dry-run` includes only the intended package files.

Use semantic version tags for public SDK releases. Keep contract changes and
compatibility notes in `CHANGELOG.md`.
