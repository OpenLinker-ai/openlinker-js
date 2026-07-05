# Security Policy

Do not open public issues for vulnerabilities.

Use GitHub private vulnerability reporting when available. If it is not
available, contact the maintainers through the published OpenLinker
security/support channel. Include the affected repository, commit or release,
reproduction steps, impact, and whether any live token, public endpoint, or
customer data is involved.

中文提示：安全漏洞不要发公开 Issue。请使用 GitHub 私密漏洞报告或项目公布的安全联系
方式，并删除 user token、agent token、callback secret、浏览器截图中的隐私信息和
私有 URL。

## Supported Versions

`@openlinker/sdk` is pre-1.0. Security fixes target the current `main` branch
and the latest published package version when available. Older versions may not
receive backports unless maintainers explicitly announce support for a release
line.

## Security-Sensitive Areas

- authorization header handling
- callback signature creation and verification
- webhook raw-body handling
- runtime WebSocket and pull connectors
- browser/server token handling examples
- A2A push notification credentials
- accidental token exposure in errors or bundled examples

## Reporting Guidance

Please include:

- the affected SDK version or commit
- Node.js, browser, or edge runtime version when relevant
- a minimal reproduction
- whether the issue is client-side, callback, runtime connector, or A2A
- whether any live secret was exposed

Never include real third-party secrets in public reports, tests, screenshots, or
logs. If a token was exposed, rotate it before sharing details.

## Disclosure

Maintainers will triage reports as quickly as practical. Please avoid public
disclosure until a fix, mitigation, or coordinated disclosure timeline is
available.
