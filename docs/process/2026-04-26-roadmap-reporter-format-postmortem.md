# Roadmap reporter format postmortem

Date: 2026-04-26

## Trigger

The owner reported that the scheduled `Screeps roadmap fanout reporter` posted to `#roadmap` using the wrong format after the roadmap snapshot format had been corrected.

## Expected format

`#roadmap` should use a rendered visual snapshot, not prose-heavy Markdown.

Required structure:

1. Upper section: compact domain cards with goal, next milestone, and completed key item.
2. Lower section: verified data board.
3. Lower section: milestone checklist, one item per row; checked means complete, empty means incomplete.
4. No date-based Gantt/timeline chart.
5. No raw Markdown table, Mermaid, code block, or verbose bullet report.

## What happened

The old cron job `Screeps roadmap fanout reporter` still had a text-summary prompt. When PR #12 merged and changed roadmap state, the reporter correctly detected a roadmap-relevant change but produced a prose/bullet roadmap update instead of a rendered image.

## Root cause

The format correction had been applied manually in the live Discord thread, but the scheduled reporter prompt still encoded the older output contract: changed blocker, milestone, current next slice, open PR/gate, and owner decision. It did not contain the newer hard requirement to render and attach a PNG snapshot.

A second contributing issue was state coupling: the reporter state file tracked commit/output changes, but not a `format_version`, so a visual-format contract change did not automatically force a compliant regenerated report.

## Corrective actions

- Paused and removed the old text-summary reporter job.
- Created a replacement same-name `Screeps roadmap fanout reporter` job with a hard visual contract.
- Added external Hermes renderer script `~/.hermes/scripts/render-screeps-roadmap.js` for local PNG generation; this is managed as agent runtime configuration rather than a version-controlled repository file.
- New external reporter state file is separate: `~/.hermes/screeps-reporters/roadmap-visual-state.json`.
- New prompt uses `format_version=roadmap-visual-no-gantt-v3` as part of change detection.
- Patched the reusable Screeps planning skill (`screeps-research-and-planning`) so future agents do not reintroduce Markdown/Mermaid/date-Gantt roadmap output.
- Sent a corrected rendered roadmap PNG to `#roadmap`.

## Verification

- Renderer produced `/tmp/screeps-roadmap-snapshot.png` as a valid PNG.
- Vision verification confirmed no clipping and confirmed the requested structure: upper domain cards, lower data board, lower checklist, and no date/Gantt.
- New cron job is enabled, named `Screeps roadmap fanout reporter`, and delivers to `discord:#roadmap`.

## Anti-regression rule

Any future `#roadmap` fanout reporter change must preserve the visual media contract. If Discord rendering fidelity matters, render an artifact and send it as media; do not depend on Discord Markdown table or Mermaid rendering.
