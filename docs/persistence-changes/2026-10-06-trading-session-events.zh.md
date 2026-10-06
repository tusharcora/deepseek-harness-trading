---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-06-trading-session-events

[English](2026-10-06-trading-session-events.md) | 中文

## 概述

新增交易台的仅日志会话事件：trading/proposal（已检查的下单或撤单提议）、trading/order（发送已批准提议的结果）与 trading/fill（交易台订单的一次成交）。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-06-trading-session-events
baseline: false
changes:
  - root: "event:trading/fill"
    previous: null
    after: "001494b3088098f5cc4bea0df40f134f454e7a85f37f345fc2d50b3367115eab"
    decision: same-version
  - root: "event:trading/order"
    previous: null
    after: "6ef40fbf2c8b71fb169e62952b12383b9ec42c0f086bc9e3b83015335dd615ef"
    decision: same-version
  - root: "event:trading/proposal"
    previous: null
    after: "24bd74b50348acfaa583b692e03dabaa6eb7bf5a63ce85b3362bbf7af285cf27"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

仅由实验性交易 profile 的会话写入的新增必读事件类型；不含这些事件的日志不受影响，早于它们的构建会拒绝包含它们的日志，与任何新增仓库内事件类型相同。

<a id="verification"></a>
## 验证

tool-trading 的 executor、pipeline、fill 与 composition 测试会追加并读取每种事件；trading-desk Web 快照回放包含全部三种事件的会话。

<a id="dev-note"></a>
## 开发备注

无。
