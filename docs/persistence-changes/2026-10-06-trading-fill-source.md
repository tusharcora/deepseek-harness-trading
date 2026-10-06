---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-06-trading-fill-source

English | [中文](2026-10-06-trading-fill-source.zh.md)

## Summary

Adds the trading-fill message source kind for the fill notices the trading executor injects into the proposing agent.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

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
## Compatibility

Existing records remain valid. The kind is attribution-only: readers preserve a trading-fill message and its JSON metadata without the trading packages, and no reader validates, replays, or authorizes by it. Only sessions of the experimental trading profile write it.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/experimental/tool-trading: 126 tests passed; the trading-desk web snapshot replays a session whose fill notice carries the kind.

<a id="dev-note"></a>
## Dev Note

None.
