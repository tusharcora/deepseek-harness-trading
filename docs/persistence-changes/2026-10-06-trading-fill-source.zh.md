---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-06-trading-fill-source

[English](2026-10-06-trading-fill-source.md) | 中文

## 概述

新增 trading-fill 消息来源类型，用于交易执行器注入给提出订单的 agent 的成交通知。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-06-trading-fill-source
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-09-21-user-question-reply"
    after: "248976b32676a5954d77de45041401a928bd30a20aef5845e3f02d890e02a0b4"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-09-21-user-question-reply"
    after: "f98f58198cad118852f2c4628831d5cc679c46cea0d23aa5ff9e8cd7cf70e491"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-09-21-user-question-reply"
    after: "89edc396c1fd10fe264d9dc49cf152d6c440216302b53bc19d98b07a7c065759"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-09-21-user-question-reply"
    after: "34c7563bb69c619963a3b5b474b173704a7f9527f0308e524c1a4dec6d79de97"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有记录仍然有效。该类型仅用于归属：读取方无需交易包即可保留 trading-fill 消息及其 JSON 元数据，且没有读取方据此校验、回放或授权。只有实验性交易 profile 的会话会写入它。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/experimental/tool-trading：126 个测试通过；trading-desk Web 快照回放的会话中，成交通知带有该类型。

<a id="dev-note"></a>
## 开发备注

无。
