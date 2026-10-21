# Merchant-payment-processing-platform
A merchant payment platform built as a technical exercise. A merchant logs
in, creates and captures payments, watches them settle, and refunds them after
settlement. A separate worker recovers uncertain outcomes and confirms
settlement. The design focuses on correctness: idempotent requests, an audit
trail for every state change, retries with a dead-letter state, and structured
logs, metrics and health checks. A payment provider makes success, decline
and timeout cases reproducible without external keys.
