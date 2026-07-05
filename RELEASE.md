# Release Process

`@openlinker/sdk` releases are cut from `main` after CI and local release gates
pass. Public SDK releases should use semantic version tags and npm package
versions that match the release tag.

## Pre-Release Checklist

1. Confirm `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, `SUPPORT.md`,
   contracts, and examples are current.
2. Confirm `CHANGELOG.md` describes public API changes, compatibility notes,
   and any Core version assumptions.
3. Run `npm audit` and review the result.
4. Run `npm run typecheck`.
5. Run `npm run build`.
6. Run `npm test`.
7. Run `npm pack --dry-run` and confirm the package contains only intended
   files.
8. Run a current-source secret scan on a clean checkout, for example
   `gitleaks dir --redact .`.
9. Confirm `.env` files, coverage output, local build artifacts outside `dist`,
   and private logs are not tracked.

## Publishing

When maintainers intentionally publish to npm:

```bash
npm version <major|minor|patch|prerelease>
npm publish --access public
git push origin main --follow-tags
```

Pre-1.0 releases may include breaking changes, but they must be called out in
`CHANGELOG.md`.

中文提示：发布前必须确认包里没有真实 user token、agent token、callback secret、私有
URL 或本地调试文件。
