# Release Process

Chinese documentation: [RELEASE.zh-CN.md](./RELEASE.zh-CN.md)

`@openlinker/sdk` releases are cut from `main` after CI and local release gates
pass. Public SDK releases should use semantic version tags and npm package
versions that match the release tag.

## Pre-Release Checklist

1. Confirm `README.md` and `README.zh-CN.md` describe the same Core/Hosted,
   Client/Runtime, Agent Node Adapter, and installation boundaries, and that
   `CONTRIBUTING`, `SECURITY`, `SUPPORT`, contracts, and examples are current.
2. Confirm `CHANGELOG.md` describes public API changes, compatibility notes,
   and any Core version assumptions.
3. Confirm `package.json` and `package-lock.json` use the same version, and that
   `v<package version>` exactly matches the intended GitHub release tag.
4. Do not advertise `npm install @openlinker/sdk` as an available installation
   path until the intended public version is visible through `npm view`.
5. Run `npm audit` and review the result.
6. Run `npm run typecheck`.
7. Run `npm run build`.
8. Run `npm test`.
9. Run `npm pack --dry-run` and confirm the package contains only intended
   files.
10. Run a current-source secret scan on a clean checkout, for example
   `gitleaks dir --redact .`.
11. Confirm `.env` files, coverage output, local build artifacts outside `dist`,
   and private logs are not tracked.

## Publishing

When maintainers intentionally publish to npm:

```bash
npm version <major|minor|patch|prerelease>
npm publish --access public
npm view "@openlinker/sdk@$(node -p 'require("./package.json").version')" version
git push origin main --follow-tags
```

Pre-1.0 releases may include breaking changes, but they must be called out in
`CHANGELOG.md`.
