# OpenLinker JS 全 TypeScript 测试与示例迁移设计

日期：2026-07-18  
状态：已批准，待实施

## 背景

`openlinker-js` 的生产源码已经全部位于 `src/**/*.ts`，并通过 `strict`、`noUncheckedIndexedAccess` 和 `exactOptionalPropertyTypes` 检查。仓库剩余的手写 JavaScript 是 9 个 `test/*.test.mjs` 测试文件和 1 个 `examples/runtime-echo.mjs` 示例，共 6,775 行。

现有测试先将 SDK 编译到 `dist/`，再由 Node 原生测试器加载 `dist/*.js`。这一点必须保留，因为测试需要验证真实的发布边界，而不只是直接执行 `src/`。

对现有 MJS 文件执行与生产源码相同的严格检查，会报告 663 个类型错误。其中大多数来自未类型化的测试桩、可空值未收窄和可选客户端方法；少数错误来自故意构造非法协议数据的负向测试。这些错误不是当前测试失败，但说明简单改后缀无法形成可信的 TypeScript 测试层。

## 目标

- 仓库内所有手写的可执行源文件使用 TypeScript。
- 测试和示例采用与生产源码相同的严格类型规则。
- 测试继续针对构建后的 `dist/*.js` 和 `dist/*.d.ts` 执行。
- 保持 `engines.node >= 20`，不引入 TypeScript 运行时加载器。
- 保持公开包的导出、运行时行为和发布内容不变。
- 所有现有测试继续通过，并让类型检查覆盖测试和示例。

## 非目标

- 不把 JSON 合约、YAML 工作流、Markdown 文档或 `package.json` 改为 TypeScript。
- 不取消 `dist/*.js`；JavaScript 仍是 Node、浏览器和 Edge 的发布运行产物。
- 不改变 SDK 的公共 API、Runtime 协议或业务行为。
- 不借迁移机会重构生产源码或扩大测试覆盖范围。
- 不通过 `strict: false`、全文件 `@ts-nocheck` 或大面积 `any` 规避类型问题。

## 方案选择

采用独立 TypeScript 编译配置，而不是 `tsx` 或 Node 原生类型擦除：

- `tsconfig.json` 继续只负责编译 `src/` 到 `dist/`。
- `tsconfig.test.json` 将 `test/**/*.ts` 编译到 `.test-dist/`。
- `tsconfig.examples.json` 将 `examples/**/*.ts` 编译到 `.example-dist/`。
- Node 原生测试器运行 `.test-dist/*.test.js`。

这样没有新增运行依赖，也不会把最低 Node 版本从 20 提升到 22 或 26。测试编译目录与源码目录平级，因此测试中的 `../dist`、`../contracts` 和 `../src` 相对路径在编译后仍指向原有目标。

## 文件与构建结构

迁移后结构如下：

```text
src/**/*.ts                    生产源码
test/**/*.test.ts              测试
test/helpers.ts                共享的类型化测试桩和工厂
examples/runtime-echo.ts       Runtime 示例
dist/                          生产构建产物
.test-dist/                    临时测试构建产物
.example-dist/                 临时示例构建产物
tsconfig.json                  生产编译
tsconfig.test.json             测试编译
tsconfig.examples.json         示例编译
```

`.test-dist/` 和 `.example-dist/` 必须加入 `.gitignore`，并由 `npm run clean` 删除。`package.json.files` 继续只发布合约、`dist/`、README 和包元数据，因此临时编译产物不能进入 npm 包。

## 类型设计

### 共享测试辅助代码

重复出现的测试桩集中到 `test/helpers.ts`，至少提供：

- 泛型 `deferred<T>()`。
- 类型化的延迟与 AbortSignal 处理。
- Runtime UUID、Attempt identity、Ready payload 和 assignment 工厂。
- `RuntimeClient`、transport 和 WebSocket 测试替身的公共类型。
- JSON/HTTP response 辅助函数需要的精确参数与返回类型。

测试文件可以保留本地、场景专用的桩，但必须通过 `satisfies` 或显式接口证明其形状符合 SDK 类型。不能为了复用而把行为不同的桩强行合并。

### 负向测试

协议拒绝测试会故意传递错误字段、错误 union 分支或非法 JSON 值。此类位置使用紧邻表达式的 `@ts-expect-error`，并附一句说明预期违反的类型约束。

不使用 `@ts-ignore`。如果生产 API 接受 `unknown` 后在运行时校验，则测试应使用该真实 `unknown` 边界，而不是制造无关的类型逃逸。

### 可空值和异步桩

- 使用 `assert.ok(value)`、显式 guard 或断言辅助函数收窄可能为空的结果。
- 回调预期返回 `void` 时使用代码块，避免把 `array.push()` 的数字结果误当成回调返回值。
- 测试替身中的可选方法在调用前必须收窄，或让工厂返回完整的必需接口。
- 对需要覆盖的测试私有状态，优先通过公开状态或专用测试替身观察；仅在无法替代时使用局部、具名的窄类型断言。

## 脚本数据流

`npm test`：

1. 清理 `dist/`、`.test-dist/` 和 `.example-dist/`。
2. 用生产配置构建 `dist/` 和声明文件。
3. 用测试配置严格编译到 `.test-dist/`。
4. 运行 `node --test .test-dist/*.test.js`。

`npm run typecheck`：

1. 构建或确认 `dist/*.d.ts` 可用。
2. 对生产源码执行无输出检查。
3. 对测试执行无输出严格检查。
4. 对示例执行无输出严格检查。

示例提供独立的构建脚本，将 `runtime-echo.ts` 编译到 `.example-dist/runtime-echo.js`。示例文档和命令只引用生成后的 JavaScript，不要求使用者安装 TS 运行器。

## 错误处理

- 任一 TypeScript 编译错误必须阻止测试执行。
- 测试编译使用 `noEmitOnError`，不能留下部分输出后继续运行旧文件。
- 清理脚本必须在目录不存在时也能成功。
- 负向测试的 `@ts-expect-error` 在被测类型收宽或错误消失时应令 TypeScript 报错，防止失效断言长期残留。

## 迁移顺序

1. 增加测试和示例编译配置、清理规则与脚本，但先保持原测试入口可运行。
2. 迁移并类型化 Runtime 示例。
3. 迁移体量较小的 contract、boundary、store、node transport 和 WebSocket 测试。
4. 迁移 client、runtime 和 command delegation 测试。
5. 最后迁移 3,480 行的 runtime worker 测试，并抽取公共测试桩。
6. 切换 `npm test` 到编译后的 TypeScript 测试，删除全部 `.mjs`。
7. 更新 README 中的开发和示例命令。

每一步都必须保持当前行为测试通过；不允许同时修改 Runtime 生产行为来迁就测试类型。

## 验证与完成标准

完成时必须满足：

- `git ls-files '*.js' '*.jsx' '*.mjs' '*.cjs'` 不返回手写源码、测试或示例文件。
- `npm run typecheck` 对源码、测试和示例零错误。
- `npm run build` 成功并生成既有 JS 与声明文件。
- `npm test` 的现有 146 项测试全部通过。
- `npm pack --dry-run` 不包含 `.test-dist/`、`.example-dist/`、测试源码或示例源码。
- `npm` 包的 `main`、`exports`、文件清单和公开类型入口与迁移前一致。
- `git diff --check` 通过，工作树没有误提交的生成文件。

## 风险控制

- 最大风险集中在 `runtime-worker.test` 的大型测试桩。通过先定义公共接口和工厂、再逐段迁移控制差异规模。
- 类型修复可能意外改变负向测试输入。迁移时必须对照原测试断言，确保非法输入仍实际进入运行时校验路径。
- 编译目录变化可能破坏 `import.meta.url` 相对路径。独立 `rootDir`/`outDir` 布局和 contract/boundary 测试会固定这些路径。
- 不升级 Node、不更改发布导出，避免把内部工程改进变成消费者破坏性变更。
