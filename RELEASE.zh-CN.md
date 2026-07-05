# 发布流程

English documentation: [RELEASE.md](./RELEASE.md)

`@openlinker/sdk` 从 `main` 发布，前提是 CI 和本地发布检查都通过。公共 SDK 版本应使用
语义化版本 tag，并让 npm package version 与 release tag 匹配。

## 发布前检查

1. 确认 `README.md`、`CONTRIBUTING.md`、`SECURITY.md`、`SUPPORT.md`、contracts 和示例是最新的。
2. 确认 `CHANGELOG.md` 描述了公共 API 变化、兼容性说明和 Core 版本假设。
3. 运行 `npm audit` 并审查结果。
4. 运行 `npm run typecheck`。
5. 运行 `npm run build`。
6. 运行 `npm test`。
7. 运行 `npm pack --dry-run` 并确认包内只有预期文件。
8. 在干净 checkout 上运行源码 secret scan，例如 `gitleaks dir --redact .`。
9. 确认 `.env`、覆盖率输出、`dist` 外的本地构建产物和私有日志没有被跟踪。

## 发布

维护者有意发布到 npm 时：

```bash
npm version <major|minor|patch|prerelease>
npm publish --access public
git push origin main --follow-tags
```

pre-1.0 版本可以包含 breaking change，但必须在 `CHANGELOG.md` 中说明。

发布前必须确认包里没有真实 user token、agent token、callback secret、私有 URL 或本地调试文件。
