# 贡献 @openlinker/sdk

English documentation: [CONTRIBUTING.md](./CONTRIBUTING.md)

感谢你改进 `@openlinker/sdk`，这是 OpenLinker Core API、浏览器/Edge 友好 A2A
transport、runtime helper 和 callback 校验的 TypeScript SDK。

## 开发环境

```bash
npm install
npm run typecheck
npm run build
npm test
```

测试和示例只能使用占位 token。不要提交真实 user token、agent token、callback secret、
私有 endpoint 或捕获的客户数据。

## 范围边界

可以放在这里：

- 开源 Core API 的 TypeScript wrapper
- runtime pull/WebSocket connector helper
- callback 创建和签名校验 helper
- 浏览器安全的 A2A JSON-RPC、HTTP+JSON 和 SSE client 行为
- 支持的 Core API surface 契约测试

不要放在这里：

- 原生 gRPC client 依赖；gRPC 请使用 `openlinker-go` 或单独的 Node-only generated client
- Cloud 钱包、计费、Stripe、提现和商业 Dashboard API
- 托管市场排序或私有推荐内部逻辑
- command、Codex、OpenClaw、本地后端 runner 等进程级 Agent adapter

## PR 要求

- 导出的 API 变化要小且有文档说明。
- client、callback、runtime helper 或 A2A transport 行为变化需要测试。
- 公共行为变化要更新 `README.md`、contracts 和 `CHANGELOG.md`。
- 保持浏览器安全：除非明确隔离，否则导出路径不要依赖 Node-only API。
- 除非明确说明 pre-1.0 breaking behavior，否则尽量保持向后兼容。

## 检查

```bash
npm run typecheck
npm run build
npm test
```

发布前也要运行：

```bash
npm pack --dry-run
```

## 安全

不要公开提交漏洞 Issue。请按照 [SECURITY.zh-CN.md](./SECURITY.zh-CN.md) 处理。

## 许可证

贡献即表示你同意贡献内容使用本仓库的 Apache-2.0 许可证。
