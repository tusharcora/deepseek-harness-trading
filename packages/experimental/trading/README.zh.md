---
description: "浏览器安全的交易领域库：为实验性交易台提供标的、技术指标、实时 K 线、订单校验、风险检查与价格上限。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-trading

[English](README.md) | 中文

## 概述

`dsh-experimental-trading` 承载交易台的纯领域逻辑：规范化标的、时间周期、技术指标（SMA、EMA、RSI、MACD、Bollinger）、实时 K 线构建、Alpaca 订单校验、风险策略，以及带有按方向区分价格上限的提交规划。它不执行 I/O，也不注册服务，因此交易提供方、订单执行器和浏览器图表导入的是同一批函数，显示的数值也完全一致。它以实验性名称发布，不附带稳定性承诺。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

任何需要交易判定或图表数值的交易包或浏览器组件都可以导入它：

```ts
import { checkRisk, parseSymbol, planSubmission, rsi, validateOrder } from '@deepseek-ai/dsh-experimental-trading'
```

一笔订单依次经过三次调用。`validateOrder(order, asset)` 返回订单违反的券商规则。`checkRisk(order, snapshot, limits)` 返回每项限额检查、订单是否只减少持仓，以及审批卡片上显示的参考价格与预估金额。`planSubmission(order, approvedPrice, tolerance, reduceOnly, priceIncrement)` 返回发往券商的订单类型、价格与有效期：增加敞口的按数量市价单会变为限价单，买入时上限为批准价格加容差，卖出时为批准价格减容差；平仓单和名义金额订单保持为市价单。

技术指标函数返回与输入对齐的序列，预热期内为 `null`。`applyTrade(lastBar, trade, timeframe)` 把一笔实时成交折叠进正在形成的 K 线，对属于更早时间桶的成交返回 `undefined`。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 源码地图

| 文件 | 作用 |
|---|---|
| [`src/types.ts`](src/types.ts) | 领域类型，以及品牌化的提议 id、券商订单 id 与客户端订单 id |
| [`src/symbol.ts`](src/symbol.ts) | 规范化标的解析 |
| [`src/timeframe.ts`](src/timeframe.ts) | 时间周期判定与日内时间桶长度 |
| [`src/indicators.ts`](src/indicators.ts) | SMA、EMA、Wilder RSI、MACD、Bollinger |
| [`src/candles.ts`](src/candles.ts) | 把成交折叠进正在形成的 K 线 |
| [`src/validation.ts`](src/validation.ts) | Alpaca 静态订单规则 |
| [`src/risk.ts`](src/risk.ts) | 限额、预留与仅减仓的净额计算 |
| [`src/submission.ts`](src/submission.ts) | 面向券商的订单规划与价格上限 |
| — | 不发布运行时不变量配套模块；这个纯函数库不拥有事件流或可变运行时数据；其行为由单元测试固定。 |

### 为什么要对仅减仓做净额计算

平仓按持仓减去未成交卖单和待审批的卖出提议来计算，因此同时提议的两笔平仓不会卖出超过持仓的数量而开出空头。

### 为什么价格上限随方向变化

买入限价高于批准价格、卖出限价低于批准价格，二者都会越过买卖价差，在正常市场中像市价单一样成交，同时限制成交价格。平仓保持为市价单，因为带上限的平仓在快速行情中可能无法成交。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [交易台 Agent Note](../../../.agents/notes/proposed/feature/2026-10-05-trading-desk.zh.md)——这些函数所实现的设计。

-----

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

- **仅支持美元账户**——估算与限额假定账户以美元计价；以 BTC 或 USDT 计价的加密货币交易对按其计价货币计算规模，不做换算。
- **日内时间桶按 UTC 对齐**——`1D` 与 `1W` K 线必须来自提供方；`applyTrade` 只更新它们。

-----

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

None.

</details>
