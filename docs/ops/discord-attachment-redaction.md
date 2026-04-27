# Discord attachment redaction guard

Last updated: 2026-04-28

## Problem

Hermes gateway responses can treat a specially formatted media attachment directive as an instruction to upload a file. If an assistant includes such a directive verbatim while merely explaining logs, the current Discord thread can receive an unintended image attachment.

## Guardrail

For all Screeps agents, reporters, schedulers, reviewers, and docs updates:

1. Do not quote a complete attachment directive in owner-facing prose, examples, logs, code fences, or final responses unless the intended action is to attach that file.
2. When discussing a prior directive, redact or split the trigger prefix and describe it as "a media attachment line" plus the path or artifact name.
3. Prefer channel names, artifact paths, cron job IDs, and message IDs as evidence; do not include the complete upload directive.
4. Keep roadmap/reporting cron cadence unchanged. This guard only changes explanatory text and process documentation.
5. If gateway code later learns to ignore quoted directives safely, keep this document as a conservative no-surprise reporting rule unless the owner explicitly relaxes it.

## Verification for issue #102

A docs/process PR satisfies the immediate operational guard if it updates `AGENTS.md` and this runbook without reproducing a complete attachment directive. A deeper gateway parser fix can supersede this guard later, but agents must still avoid leaking secrets and accidental upload directives in owner-visible text.
