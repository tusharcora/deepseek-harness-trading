# Agent Note: 交易台——由 agent 提议的股票与加密货币订单及实时图表

Status: proposed

[English](2026-10-05-trading-desk.md) | 中文

## 问题

DeepSeek Harness 的 agent（智能体）能够读取、编写和运行代码，却无法观察市场，也无法在市场中行动。用户若想要一个对话式交易助手——让 agent 分析某个标的、看到与 agent 相同的图表、并由它下达股票或加密货币订单——会发现 harness 中没有行情数据来源、没有券商连接、没有图表，也没有订单安全机制。下单是 harness 中第一项出错会直接造成资金损失的能力，因此订单限额必须由执行器代码强制执行，而不是依赖模型指令；并且在订单到达券商之前，用户必须看到订单本身、下单理由及其风险。

## 提案

第一阶段新增一个由对话驱动的交易台，作为可选启用的 `trading` profile，由八个 `packages/experimental/` 包构成。一个 agent 通过工具分析市场并提议订单——可以是应用内的 dsh agent，也可以是用户自己在交易台终端中运行、并通过 MCP 连接的 Claude Code CLI（命令行界面）；用户在审批卡片上逐笔批准订单；右侧边栏的 Trading 面板显示实时图表、agent 的成交与提议、持仓和订单。第二阶段（另一份 Agent Note）新增多 agent 交易台——分析员、策略员、风险审查员——原样复用第一阶段的工具。被委派的 subagent 以固定为 `never` 的审批策略运行（`subagent/src/child-agent.ts`），因此第二阶段只有主会话能下单；subagent 负责分析和建议。

已确定的决策：

- 先做模拟盘交易。实盘资金的代码路径存在但保持锁定；e2e 与人工验证只使用 Alpaca 模拟盘账户。
- 每一笔订单和撤单都需要逐次的人工审批。自主交易不在范围内。
- 第一阶段 Alpaca 是唯一的提供方，覆盖美股与加密货币，同时提供行情数据和订单执行。
- 图表使用 TradingView `lightweight-charts` v5（Apache-2.0），叠加层由 harness 绘制。不使用需要授权的 Advanced Charts 库，也不使用 iframe 小组件。

### 包拓扑

所有包均为 `@deepseek-ai/dsh-experimental-*`，按 `packages/experimental/` 的策略默认发布，只通过可选启用的 profile 进入产品组合。

| 包 | 职责 | 对外提供 |
|---|---|---|
| `trading` | 共享类型与纯逻辑；无 I/O | `Symbol`、`Bar`、`Timeframe`、`Quote`、`Order`、`Position`、`Account` 类型；面向交易场所的类型（账户、持仓、券商订单、订单更新）；技术指标（SMA、EMA、RSI、MACD、Bollinger）；成交到 K 线的聚合；`checkRisk` |
| `trading-venue` | 交易场所的 Service Definition | 位于 `ctx.tradingVenue` 的抽象 `TradingVenueGateway` 服务（账户、持仓、订单、资产、报价、K 线、提交、撤单、平仓、清仓、暂停、订单更新订阅、按 client order id 查询订单、账户模式）以及 `VenueError` |
| `trading-alpaca` | 交易场所的 Alpaca 提供方 | 注册 `ctx.tradingVenue`；REST 历史数据与订单 API；每个资产类别共享一条 WebSocket；通过 `ctx.credentials` 读取密钥；`mode: paper \| live`，默认 `paper` |
| `tool-trading` | 面向模型的工具与订单执行器 | `get_quote`、`get_bars`、`get_account`、`get_positions`、`list_orders`、`place_order`、`cancel_order`；风险检查、审批、复核、幂等提交、交易日志 |
| `trading-gateway` | 供客户端使用的类型化远程服务 | `bars(symbol, tf, before?)`、`streamBars(symbol, tf)`、`streamAccount()`、自选列表读写、暂停/清仓 |
| `trading-mcp` | 面向外部 agent 的 MCP 端点 | dsh 宿主上的 Streamable-HTTP MCP 服务器，通过同一个订单执行器暴露同样的七个工具；按会话签发的 bearer token |
| `bundle-trading` | profile 组合包 | `trading` profile 补丁与 `trader` agent 预设（其 `agent.cordis.yml`） |
| `ui-trading` | 浏览器端 | 右侧边栏 Trading 标签页；在 `tool.call.toolview` slot 中注册的交易工具视图；Trading 设置卡片 |

`tool-trading` 拥有订单执行器（校验、快照、风险检查、审批、复核、提交、交易日志），并将其作为服务暴露，供自身工具与 `trading-mcp` 调用。执行器是交易工具提供的唯一券商路径；下文的「执行边界」一节说明了还存在哪些其他路径，以及它们如何被关闭或约束。领域库命名为 `trading` 而不是 `trading-core`，因为包命名规则以能力命名，其风险判定是函数 `checkRisk`。行情数据与订单执行共用一个 Service Definition，即位于 `ctx.tradingVenue` 的 `TradingVenueGateway`，因为同一交易场所的数据 API 与订单 API 共用一个账户和一组密钥，且一个服务包只默认导出一个服务类。

`bundle-trading` 中的 `trading` profile 补丁组合其余七个包，保留 Web 应用的用户终端（`terminal-controller`、`ui-sidebar-terminal`），选择 `trader` agent 预设，并在系统提示词中加入一段交易说明。`web` 是固定别名，会拒绝 `--profile`，因此交易台按 Agent Teams 的方式创建：`dsh --profile trading --from-default-profile web` 初始化 profile，`dsh plugin --profile trading add` 安装交易包；默认 profile 保持不变。`packages/api/remotes` 是发布包，不能导入 experimental 类型，因此 `ui-trading` 参照 `client-ui-agent-team`，自行组装 `trading-gateway` 命名空间及其转发事件的 Remote。工具和网关只依赖 `TradingVenueGateway` 服务，因此后续的提供方（Binance、IBKR）只是一个新的提供方包，消费方无需改动。`trading` 是否拆分为类型包和风险包，遵循 [adding-a-package](../../../../docs/cookbook/adding-a-package.zh.md) 中的角色词命名规则；由实施计划决定。

实盘模式要求提供方配置中的 `mode: live` 与启动环境变量 `DSH_TRADING_LIVE=1` 同时存在；只有其中之一时，提供方拒绝以实盘模式启动。实盘模式在面板和每张订单卡片上持续显示红色 LIVE 徽标。

### 执行边界

只有当交易 agent 没有其他途径到达券商时，审批卡片才是真正的关卡。默认工具集提供了两条这样的途径：

- **Shell。** 沙箱只限制文件写入；读取和网络不在沙箱策略的表达范围内（`sandbox-policy` README）。拥有 shell 的 agent 可以读取 `$DSH_HOME/.credentials.yaml`，并用 `curl` 向 Alpaca 发送订单，在 `workspace-write` 下没有任何审批步骤。
- **运行时插件。** 随附的 `tool-cordis` 与 cordis runner 允许模型定义宿主插件，这些插件可以直接调用 `ctx.tradingVenue`，或注册一个审批应答器。

第一阶段为应用内 agent 关闭这两条途径，并在券商侧约束剩余的风险：

1. **`trader` agent 预设，工具白名单。** 交易工具只在 `trader` 预设的声明中注册（即交易层插入的一行 `@deepseek-ai/dsh-agent-preset`），从不作为 profile 行注册，因此其他预设的 agent 无法将交易工具与 shell 组合。`trading` profile 还禁用随附的 `standard`、`ptc`、`cordis`、`minimal` 预设声明，并将 `agent-preset-registry` 的默认值设为 `trader`，使其他预设都不可选。`trader` agent 的工具是白名单：七个交易工具、`web_search` 与 `web_fetch`（不暴露请求头或方法）。其余一切均不存在，包括 shell、终端、文件读写工具（`fs-sandbox` 的读取不受限制）、`run_code`、工作流、subagent 委派、MCP 客户端工具、`tool-cordis` 和扩展工具。该 profile 禁用 cordis 宿主端与客户端 runner 以及宿主端 inspect 提供方。
2. **券商侧账户配置。** 启动时，`trading-alpaca` 通过 Alpaca 的账户配置 API 设置并校验 `no_shorting: true` 与 `max_margin_multiplier: "1"`，若无法完成配置则拒绝启动。暂停（Halt）会设置 `suspend_trade: true`。这些设置只能约束仅会下单的 agent；持有 Alpaca 密钥的 agent 可以把它们改回去。因此 `trading-alpaca` 会定时重新读取这三项（默认每 60 秒，为一个 `Config` 字段）；任何偏离预期值的变化都会暂停交易台，并在面板上显示指明被改设置的警告。启动时，若已持久化的暂停标志或 Alpaca 的 `suspend_trade` 任一被设置，交易台以暂停状态启动。
3. **自带 shell 的外部 agent。** Claude Code 有自己的 Bash 工具，以同一个操作系统用户运行，可以读取凭据文件并直接调用 Alpaca；dsh 审批无法拦住这条路径。上述券商侧配置依然有效。Claude Code 的沙箱只覆盖其 shell 命令，因此「连接 Claude Code」说明建议同时使用三项 Claude Code 设置：对 dsh 凭据文件的 `Read` 权限拒绝规则、列出 Alpaca API 与数据主机的 `network.deniedDomains`，以及 `allowUnsandboxedCommands: false`，使被拦截的命令无法在沙箱之外重试；dsh 审批是经由 `trading-mcp` 的订单的关卡，而不是对具备 shell 能力的 agent 的保证。

### 行情数据

标的为 `{ assetClass: 'equity' | 'crypto', ticker }`（`AAPL`、`BTC/USD`）；工具与界面接受任一写法并推断资产类别。K 线为 `{ t, o, h, l, c, v }`，`t` 为 UTC 纪元毫秒。时间周期为 `1m 5m 15m 1h 4h 1D 1W`。

- 历史数据来自 Alpaca REST K 线端点（股票与加密货币端点分开），分页获取。
- 实时数据来自每个资产类别一条 WebSocket。订阅在图表、自选列表和 agent 工具之间按引用计数共享；最后一个消费方释放时，上游订阅关闭。
- 股票数据源可配置（`feed: iex | sip`，免费计划默认 `iex`）。界面会标注数据源，避免把 IEX 价格误认为合并行情。
- `trading-alpaca` 负责两类 Alpaca socket：账户的成交更新 socket，以及（随 Trading 面板交付的）每个资产类别一条、订阅按引用计数共享并以退避方式重连的行情 socket。行情 socket 重连后，交易场所报告一次缺口；拥有图表 K 线序列的 `trading-gateway` 通过 REST K 线回补缺口，并在收到新的报价前将该标的标记为陈旧。
- 技术指标与 K 线聚合是 `trading` 中的纯函数，`get_bars` 与图表都使用它们，因此 agent 与用户看到完全一致的数值。

`get_bars` 返回一段摘要（最新价、区间、所请求指标的最新值、近期波段高低点），外加以紧凑表格呈现的最近 N 根 K 线，默认 100 根、上限 500 根，以限制模型上下文。

### 订单流程

`place_order` 参数：`symbol`、`side`（`buy | sell`）、`qty` 与 `notional` 二者恰好其一、`type`（`market | limit | stop | stop_limit`）及其所需的 `limit_price` 与 `stop_price`、`time_in_force`、可选的仅限股票的括号单（`take_profit`、`stop_loss`），以及必填的 `rationale`——一到三句话，显示在审批卡片上。

每个提议在第 1 步获得一个由执行器生成的提议 id（品牌类型）；MCP 调用没有工具调用 id，因此两条路径都以它作为提议、审批和 `client_order_id` 的键，应用内路径将其 `callId` 映射到提议 id。执行器对每个账户持有一把锁，只覆盖两段短临界区，从不跨越审批等待：第 2–3 步（快照、检查、预留）与第 5–7 步（重新快照、复核、提交）。第一段临界区中的预留使并发提议彼此可见，因此在用户处理第一张卡片时，同一条模型消息中的多个 `place_order` 调用会互相校验。第 1–4 步在 `tool-trading` 的 `tools/pre-execute` 监听器中运行，因为该 waterfall（瀑布式事件）在工具主体之前运行；第 5–8 步在审批后于工具主体中运行。`trading-mcp` 以相同顺序调用相同的执行器函数。

工具主体默认拒绝。排在 `tool-trading` 之前的监听器可能返回 `allow` 或 `ask`，从而跳过校验、快照和风险检查（当某个 Claude Code 钩子要求询问时，`hooks-claude-code` 返回 `ask`），而工具主体仍会运行。因此，工具主体只有在找到该调用提议 id 对应的、由自己写入的 `trading/proposal` 事件，以及该调用的 `allowed-once` 审批决定时才会提交；否则以 "no checked proposal for this call" 拒绝。

1. **校验。** 资产可交易性；资产类别允许的有效期（加密货币：`gtc`、`ioc`）；资产类别允许的订单类型（加密货币没有普通 `stop`，只有 `market`、`limit`、`stop_limit`）；碎股与 `notional` 股票订单只能为 `day`；括号单要求整股数量的股票订单。无效输入返回工具错误。
2. **快照。** 报价、账户权益与购买力、当前持仓、未成交订单、待审批提议预留的敞口、今日订单数，以及相对 Alpaca `last_equity` 的今日盈亏。
3. **风险检查。** `checkRisk(order, snapshot, limits)` 返回通过或违规列表，并将未成交订单与预留敞口视为已成交计入。任何违规都会在不询问用户的情况下拒绝调用，并把原因返回给模型。通过检查的提议会预留其敞口，直到被拒绝、过期、失败或成交。限额只能在设置中修改，绝不能通过对话修改。
4. **审批。** 监听器追加一条以提议 id 与 `callId` 为键的 `trading/proposal` 会话事件（订单、报价、预估成本、占权益百分比、每项风险结果、来源、模式），并返回 `{ kind: 'ask', reason }`。`ctx.approval.request` 只携带工具名、调用 id 和原因，因此卡片通过 `callId` 读取提议事件。`ui-chat` 已占用唯一的 `conversation.approval.detail` slot，因此 `ui-trading` 以更高优先级为交易审批注册自己的 `conversation.composer` 条目：方向、数量、标的、类型、预估成本、占权益百分比、买卖报价、理由、每项风险检查以及 PAPER/LIVE 徽标。卡片待处理期间，提议价格在图表上显示为一条线。
5. **复核。** 审批后执行器重新快照。若预估成本偏移超过容差（默认 1%），或任一限额此时不再满足，调用以 "price moved; propose again" 拒绝。
6. **价格上限。** 增加敞口的按数量 `market` 订单会以可立即成交的 `limit` 订单发送（加密货币 `ioc`，股票 `day`），买入价为批准价格加上偏移容差，卖出价为批准价格减去容差，从而即使订单隔夜排队，券商也会强制执行批准的名义金额。仅减仓的平仓单以真正的 `market` 订单发送，使平仓在快速行情中也能成交。`notional` 订单保持 `market`，因为名义金额本身已限制成本。普通 `stop` 触发的是价格上限无法覆盖的市价单，因此增加敞口的订单必须使用 `stop_limit`；普通 `stop` 只接受用于仅减仓的平仓。卡片会说明价格上限，或说明为何不适用。
7. **提交**，`client_order_id` 为 dsh 会话 id 与提议 id 的哈希；提供方的调用 id 在会话之间不唯一，而 MCP 调用根本没有调用 id。订单 id 与客户端订单 id 均为品牌类型（`Branded<B>`），从不使用裸字符串。
8. **回报。** 工具返回订单 id 与状态。成交通过账户流到达，更新图表标记和持仓面板，并记录为 `trading/fill` 会话事件。成交发生在任何工具调用之外，因此账户流处理器查找该会话的根 agent，并把成交注入该 agent 的下一次请求；注入不会唤醒空闲的 agent，因此 agent 会在用户下一条消息时看到成交。Claude Code 只能通过工具结果或调用 `list_orders` 看到成交。Alpaca 不会补发成交更新 socket 断开期间错过的订单更新，因此每次重连后以及流停止时，交易场所都会报告一次缺口，消费方随即重新读取未成交订单与持仓。

无论会话的权限模式如何，交易工具总是询问。当审批策略为 `never`（包括 `DSH_PERMISSION_MODE=danger-full-access`）或没有可用的审批服务（无界面运行）时，`place_order` 与 `cancel_order` 被拒绝，绝不会被自动批准。`cancel_order` 需要审批，因为撤销保护性止损会增加风险。

### 风险限额

每项限额、复核偏移容差、报价陈旧窗口，以及 `get_bars` 的默认值与上限，都是 `tool-trading` 经过校验的 `Config` 字段；trading profile 设置这些默认值，Trading 设置卡片负责编辑：

| 限额 | 默认值 |
|---|---|
| 单笔订单最大名义金额 | $1,000 |
| 最大持仓规模 | 权益的 20% |
| 每日亏损限额 | 开盘权益的 3%；触及后阻止增加敞口的订单 |
| 每日最多订单数 | 20 |
| 卖空 | 禁用 |
| 保证金 | 禁用；买入以现金为上限 |
| 标的白名单 / 黑名单 | 空 |
| 报价陈旧 | 交易时段内 30 秒内无报价则拒绝市价单 |

仅减仓或平掉现有持仓的订单绕过这些限额（仍需审批），因此始终可以平仓。仅减仓的判断扣除了未成交卖单和待审批的卖出提议，因此平仓永远不会超卖成空头；在 Alpaca 设置了 `no_shorting` 后，券商也会拒绝超卖。

**紧急停止。** 暂停会注册一个 `ctx.tools.guard()`，拒绝 `place_order` 与 `cancel_order`；guard 只能拒绝，无法被前置的 `tools/pre-execute` 监听器覆盖。执行器对 `trading-mcp` 调用检查同一暂停状态，暂停还会设置 Alpaca 的 `suspend_trade: true`。暂停一直持续到用户恢复。「全部撤单并清仓」在单独确认后撤销未成交订单并平掉所有持仓。逐个持仓的「平仓」与「全部撤单并清仓」是暂停期间唯一允许的订单；两者都由用户发起且仅减仓。发送这些订单时，交易台先在日志中记录一个打开的清仓窗口，然后解除 `suspend_trade`、提交订单，并在关闭窗口前恢复 `suspend_trade`。启动时若存在打开的清仓窗口，说明在窗口内发生了崩溃：交易台恢复 `suspend_trade`、以暂停状态启动并显示警告。没有任何工具能让 agent 恢复交易。

**审计。** 每个提议、风险结果、审批决定、提交和成交都记录在会话日志中（审批决定本来就会记录），并追加到存储服务中的交易日志。面板的「今日交易」标签页读取交易日志，并把每笔交易链接到提议它的对话消息。

### Trading 面板与工具视图

Trading 标签页注册在对话旁边的右侧边栏中。自上而下：

1. 账户栏：PAPER/LIVE 徽标、权益、当日盈亏、购买力、暂停；「全部撤单并清仓」位于其菜单中。
2. 自选列表：实时最新价、涨跌幅、市场状态；可添加和移除；可折叠；通过设置持久化。
3. 图表工具栏：标的搜索、时间周期按钮、指标菜单。
4. 图表：带成交量柱状图的 K 线；价格窗格上的 SMA、EMA 与 Bollinger；独立窗格中的 RSI 与 MACD；十字光标 OHLC 图例；向左滚动时加载历史；市场状态标签与数据源标注；agent 叠加层，包括成交（标记）、当前持仓（带未实现盈亏的平均成本虚线）、未成交的限价与止损单，以及待审批的提议。
5. 底部标签页：持仓（带需要确认、由用户发起的「平仓」）、订单（可撤单）、今日交易。

「跟随 agent」默认开启，会把图表切换到 agent 最近一次 `get_bars` 或 `place_order` 调用的标的与时间周期。第一阶段没有手动下单面板；开仓通过 agent，平仓通过 agent 或「平仓」按钮。

工具视图：`get_bars` 渲染迷你 K 线图与指标摘要，点击后在面板中打开该标的；`place_order` 渲染审批详情，提交后渲染订单状态标签，跟踪已提交 → 部分成交 → 已成交或已取消；`get_positions` 与 `get_account` 渲染紧凑表格；拒绝结果连同原因一起渲染。所有界面文案都经过中英文本地化词典。窄视口下面板隐藏，工具视图保留。如果右侧边栏无法加宽到足以使用图表，面板会增加一个加宽开关；全屏交易台视图推迟实现。

### 错误处理

| 情况 | 行为 |
|---|---|
| 缺少 Alpaca 密钥 | 工具返回 "Alpaca keys not configured — add them in Settings → Trading"；面板显示链接到设置卡片的设置卡片 |
| 401 / 403 | 向模型和面板返回明确的认证错误；不重试 |
| 订单被拒（422 等） | 把 Alpaca 给出的原因返回给模型 |
| 429 | 读取以退避方式重试；提交从不盲目重试 |
| 提交期间网络错误或 5xx | 结果视为未知；执行器在报告前按 `client_order_id` 查询订单，未经查询绝不重新提交 |
| 流断开 | 退避重连、REST 回补，在新数据到达前显示陈旧徽标 |
| 股票市场休市 | 卡片注明 "queued until market open"；盘前盘后交易推迟实现 |
| 审批待处理时 agent 被中断 | 请求取消；不提交任何订单 |
| 重启 | 以券商状态为真源；持仓与订单从 Alpaca 重新加载；交易日志与之对账 |

### Claude Code 作为交易 agent

用户可以使用自己的 Claude Code 订阅进行交易：在交易台的终端标签页或任意外部终端中运行未经修改的 `claude` CLI，并将 `trading-mcp` 端点配置为 MCP 服务器。Claude Code 通过 Anthropic 自己的流程登录；harness 从不读取、存储或转发 Claude Code 凭据，也从不使用该订阅发送模型请求。

- **端点。** `trading-mcp` 在 dsh 宿主的 `/mcp/trading` 上提供 streamable HTTP。每个 token 由 Trading 设置卡片按 dsh 会话签发，并把每次调用绑定到该会话的日志和交易日志。设置中显示可复制的 `claude mcp add --transport http dsh-trading <url> --header "Authorization: Bearer <token>"` 命令行。`terminal-controller` 为新终端设置固定的 `env: { DSH_SESSION_ID }`，因此自动注入 URL 与 token 需要对该控制器做上游修改；第一阶段使用复制的命令行。
- **工具。** 相同的七个工具，描述与限额相同。只读工具无需审批，可以加入 Claude Code 的允许工具列表。
- **审批。** Trading 面板中的 dsh 审批是 MCP 订单与撤单的决定性检查。仅在 Claude Code 内批准永远不会下单，Claude Code 的权限绕过模式也不会跳过 dsh 审批。待处理的 MCP 审批显示在 Trading 面板顶部的「待审批」条中，用户处于其他标签页时 Trading 标签页显示角标。待处理的 MCP 审批在可配置的时限（默认 10 分钟）后过期，并按拒绝处理。`ctx.approval.request` 在没有 agent 和打开的轮次时会抛出异常，因此 MCP 审批使用交易模块自有的队列。该队列重新实现审批策略检查（`never` 或没有审批能力时拒绝），并在 `trading/proposal` 之外记录 `trading/approval-asked` 与 `trading/approval-decided` 会话事件。
- **长时间等待。** MCP 调用会阻塞直到做出决定。服务器立即打开 SSE 响应流，满足 Claude Code 对 HTTP 服务器的首字节计时器（默认 60 秒），并每 30 秒发送进度通知，使空闲计时器（默认 5 分钟）保持活跃。无需设置每服务器超时。
- **转入后台的调用。** 自 Claude Code v2.1.212 起，运行超过两分钟的 MCP 调用会转入后台，Claude 继续工作，因此它可能再次提议同一笔订单。执行器会去重：若某个 `place_order` 的标的、方向、数量或名义金额、类型及价格与同一会话中待处理的提议一致，则返回该提议的待处理状态，而不是创建第二张卡片。
- **来源标注。** 每张卡片和每条交易日志都标明来源：dsh agent 或 Claude Code（MCP）。

使用方式保持交互式：由人驱动 Claude Code 并批准每笔订单。基于 Claude 订阅的无人值守或定时交易不在范围内；后续的自主交易阶段使用 API 密钥认证。

## 曾考虑的替代方案

### 为什么不把交易作为默认产品的一部分？

在默认组合中加入一等公民的交易包分组，会让每次 `dsh` 启动都成为交易机器人。它会修改上游同样在编辑的默认组合，使每次合并上游都产生冲突，并为一个仍在变化的约定承担完整的发布义务。可选启用的 experimental profile 保持编程 agent 产品不变，并隔离交易相关部分。

### 为什么不使用仓库外的插件仓库？

外部插件与上游的分离最干净，但 slot 注册、`packages/api/remotes` 中的类型化远程命名空间、转发事件白名单以及客户端构建流水线都接入了本仓库的构建与生成器。图表面板会与这些接线相冲突。

### 为什么不使用 TradingView Advanced Charts 库或小组件？

Advanced Charts 提供绘图工具和多得多的指标，但需要申请授权，且不能在开源仓库中再分发。iframe 小组件使用 TradingView 自己的数据，因此 agent 无法读取图表显示的内容，harness 也无法在其上绘制 agent 的订单。`lightweight-charts` 采用 Apache-2.0 许可，接受 harness 提供的数据，并支持叠加层所需的标记、价格线和窗格。

### 为什么不通过用户的 Claude Pro/Max 登录发送模型请求？

`llm-pi-ai` 可以借助其依赖库提供的 Claude Pro/Max OAuth 流程登录 Anthropic。Anthropic 的 Claude Code 法律与合规文档不允许第三方应用通过 Free、Pro 或 Max 计划凭据发送请求，也不允许收集或中转 Claude.ai 凭据；基于 Claude 构建的产品使用 API 密钥认证。用户以自己的订阅运行未经修改的 Claude Code 二进制是允许的，因此交易台把工具暴露给该二进制，而不是使用其凭据。

### 为什么不在订阅上使用 `subagent-claude-code` 后端？

该后端通过 Claude Agent SDK 运行 Claude Code，而 SDK 的指引是为基于 SDK 构建的 agent 使用 API 密钥认证，并且它以一次性方式运行、不向用户发出提示。它仍可在第二阶段配合 API 密钥使用，但不作为订阅路径。

### 为什么不使用 stdio MCP 服务器？

stdio 服务器会由 Claude Code 作为独立进程启动，这需要包的 bin 或临时启动器，而应用启动规则禁止这样做；并且它仍需访问正在运行的宿主的券商连接、风险状态、审批和交易日志。由宿主通过 HTTP 提供 MCP，可以保持单一执行器和单一状态来源。

### 为什么不先做多 agent 交易台？

专职 agent 带来第二意见和清晰的角色边界，但会成倍增加每个提议的 token 成本与延迟，并使糟糕的交易更难追溯。在逐笔人工审批下，用户本身已承担风险审查员的角色，而硬性限额无论如何都必须写在代码中。第二阶段在同一套工具之上增加多 agent 交易台。

### 为什么不在限额内自主交易？

自主执行会去掉对 harness 第一项花钱能力的人工检查。它会在审批流程、限额、紧急停止和交易日志都在模拟盘账户上运行过之后，作为一项独立且经过慎重考虑的设置推出。

### 为什么第一阶段不接入第二个加密货币交易所或 Interactive Brokers？

Alpaca 用一个模拟盘账户和免费行情数据覆盖两种资产类别。专门的交易所或 IBKR（需要本地运行 TWS 或 Gateway 进程）会在接口经过第一个提供方检验之前就使适配器工作量翻倍。

## 验收标准

- 使用 `dsh --profile trading --from-default-profile web` 创建并安装了交易包、配置了 Alpaca 模拟盘密钥的 profile，会显示 Trading 标签页：账户栏、自选列表、一只股票和一个加密货币标的的实时更新图表，以及空的持仓与订单。
- 让 agent 分析 `BTC/USD` 会产生一次 `get_bars` 调用，其工具视图显示迷你图表；开启「跟随 agent」时，面板图表切换到该标的和时间周期，且工具结果中的指标值与图表一致。
- 限额内的提议订单会显示带有理由、预估成本、占权益百分比和逐项限额检查的审批卡片，并在图表上绘制该提议。批准后提交一笔模拟盘订单；成交显示为图表标记、一行持仓，以及一条链接到提议消息的「今日交易」记录。
- 在审批卡片处拒绝、取消或中断都不会提交任何订单。
- 超过任一限额的订单在不显示审批卡片的情况下被拒绝，模型会收到被违反的限额。
- 在 `DSH_PERMISSION_MODE=danger-full-access` 下或没有审批服务时，`place_order` 与 `cancel_order` 被拒绝。
- 暂停期间，每个 `place_order` 与 `cancel_order` 都被工具 guard 和 MCP 执行器拒绝，Alpaca 账户报告 `suspend_trade: true`；agent 没有恢复交易的工具。
- `trader` agent 恰好暴露白名单中的工具；`trading` profile 中不能选择其他预设，其他预设的 agent 没有交易工具，cordis runner 处于禁用状态。
- 若某次 `place_order` 调用的 pre-execute 决定来自其他监听器（该调用没有 `trading/proposal`），工具主体会拒绝它。
- 交易台运行期间在 Alpaca 修改 `no_shorting`、`max_margin_multiplier` 或 `suspend_trade`，会使交易台暂停并显示警告；在 `suspend_trade` 已设置的情况下重启，交易台以暂停状态启动。
- 增加敞口的卖出市价单以低于批准价格的限价单到达 Alpaca；仅减仓的平仓单以市价单到达 Alpaca；普通 `stop` 买单在校验阶段被拒绝。
- 除非账户报告 `no_shorting: true` 与 `max_margin_multiplier: "1"`，否则 `trading-alpaca` 拒绝启动。
- 同一条模型消息中合计敞口超过限额的两个 `place_order` 调用，产生一张审批卡片和一次拒绝。
- 超过扣除未成交卖单后持仓数量的仅减仓卖单被拒绝。
- 批准的市价单以可立即成交的限价单到达 Alpaca，价格上限为批准价格加容差。
- 在第一笔仍待处理时重复的 Claude Code `place_order` 只产生一张卡片。
- 模拟的提交期间网络故障绝不会产生重复订单。
- 除非同时设置 `mode: live` 与 `DSH_TRADING_LIVE=1`，否则实盘模式拒绝启动。
- 使用 Trading 设置中的 `trading-mcp` 命令行配置的未经修改的 `claude` CLI 可以调用每个交易工具；其 `place_order` 以来源 Claude Code（MCP）显示在「待审批」条中，在做出决定前阻塞且不会触发 Claude Code 的空闲超时，批准后产生与应用内订单相同的成交、标记和交易日志记录。没有有效会话 token 的请求被拒绝。
- `trading` profile 中在 Trading 标签页旁提供终端标签页。
- 全部八个包通过逐文件 100% 覆盖率门禁；profile 有真实组合测试；注册表贡献有 HMR（热模块替换）释放测试；客户端文案通过 `verify-client-ui-i18n`。
- 一个无需密钥的快照测试，通过 trading profile 和伪造的券商提供方回放「分析 → 提议 → 批准 → 成交」会话。
- 一个可选的 e2e 测试针对 Alpaca 模拟盘下一笔最小的加密货币订单，然后撤单或平仓；没有 `ALPACA_*` 密钥时跳过。

## 风险

- **资金损失。** 风险引擎、幂等或审批接线中的缺陷可能下达非预期订单。缓解措施：仅模拟盘的阶段、锁定的实盘路径、默认拒绝的审批、执行器层级的限额、报告前的未知结果查询、紧急停止。实盘交易在解锁前需要单独审查。
- **数据保真度。** 免费的 IEX 数据源与合并行情不同，免费计划的标的数与速率限制约束了自选列表的规模。界面标注数据源，且可配置。
- **凭据暴露。** Alpaca 密钥存放在基于文件的凭据存储中，同一操作系统用户运行的任何进程都能读取。`trader` 预设移除了应用内 agent 的 shell，但 Claude Code 以及任何其他具备 shell 能力的外部 agent 仍可读取密钥并绕过 dsh 审批。券商侧的 `no_shorting`、保证金倍数 1 与 `suspend_trade` 只能约束不修改账户配置、只下单的 agent；偏移检查会在一个轮询周期内发现变化并暂停交易台，但无法阻止直接用密钥下达的订单。第一阶段的模拟盘密钥限制了影响范围；实盘模式上线前，需要交易 agent 所用操作系统用户无法读取的凭据。
- **模型过度自信。** agent 的理由可能听起来权威，实际却是错的。卡片把理由与风险检查并列显示，第一阶段不声称提供投资建议。
- **Claude 订阅条款。** 订阅的使用仅限于用户驱动未经修改的 Claude Code CLI；计划额度以普通个人使用为前提。harness 绝不能读取 Claude Code 凭据，自主交易必须使用 API 密钥。Anthropic 可能修改这些条款；MCP 端点本身与 agent 无关，可用于任何 MCP 客户端。
- **本地端点暴露。** MCP 端点可以下单，因此只接受按会话签发的 bearer token，绑定在宿主配置的地址上，并与应用内工具一样受审批和限额约束。
- **上游变动。** experimental 包依赖尚未稳定的 harness API（`tools/pre-execute`、slot、Typert remote），上游修改时需要随之更新。
- **第一阶段放弃的内容：** 绘图工具、多图表布局、期权、盘前盘后交易、手动下单面板、自主或定时交易、Alpaca 以外的提供方，以及实盘资金。
