---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-06-trading-session-events

English | [中文](2026-10-06-trading-session-events.zh.md)

## Summary

Add the trading desk's log-only session events: trading/proposal (a checked order or cancellation proposal), trading/order (the outcome of sending an approved proposal), and trading/fill (one fill of a desk order).

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

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
## Compatibility

New required-on-read event types written only by sessions of the experimental trading profile; logs without them are unchanged, and builds that predate them refuse logs that contain them, as for any new in-repo event type.

<a id="verification"></a>
## Verification

tool-trading executor, pipeline, fill, and composition specs append and read each event; the trading-desk web snapshot replays a session containing all three.

<a id="dev-note"></a>
## Dev Note

None.
