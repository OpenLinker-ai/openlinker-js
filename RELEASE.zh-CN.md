# 发布流程

English documentation: [RELEASE.md](./RELEASE.md)

`@openlinker/sdk` 从 `main` 发布，前提是 CI 和本地发布检查都通过。公共 SDK 版本应使用
语义化版本 tag，并让 npm package version 与 release tag 匹配。

## 发布前检查

1. 确认 `README.md` 与 `README.zh-CN.md` 对 Core/Hosted、Client/Runtime、Agent Node
   Adapter 和安装边界的描述一致，并确认 `CONTRIBUTING`、`SECURITY`、`SUPPORT`、
   contracts 和示例是最新的。
2. 确认 `CHANGELOG.md` 描述了公共 API 变化、兼容性说明和 Core 版本假设。
3. 确认 `package.json` 与 `package-lock.json` 版本一致，并且 `v<package version>` 与准备
   发布的 GitHub tag 完全一致。
4. 在目标公开版本能通过 `npm view` 查询到之前，不要把
   `npm install @openlinker/sdk` 写成已经可用的安装路径。
5. 运行 `npm audit` 并审查结果。
6. 运行 `npm run typecheck`。
7. 运行 `npm run build`。
8. 运行 `npm test`。
9. 运行 `npm pack --dry-run` 并确认包内只有预期文件。
10. 在干净 checkout 上运行源码 secret scan，例如 `gitleaks dir --redact .`。
11. 确认 `.env`、覆盖率输出、`dist` 外的本地构建产物和私有日志没有被跟踪。

## 发布

维护者有意发布到 npm 时：

```bash
npm version <major|minor|patch|prerelease>
npm publish --access public
npm view "@openlinker/sdk@$(node -p 'require("./package.json").version')" version
git push origin main --follow-tags
```

pre-1.0 版本可以包含 breaking change，但必须在 `CHANGELOG.md` 中说明。

发布前必须确认包里没有真实 user token、agent token、callback secret、私有 URL 或本地调试文件。
