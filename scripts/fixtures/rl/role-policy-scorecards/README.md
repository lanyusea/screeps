# Role-Policy Scorecard Fixtures

These deterministic fixtures lock the issue #1585 output contract for the first
role-scoped RL policy lanes. They are offline/private/shadow evidence shape
fixtures only: no live compute was run, `liveEffect` is `false`, and
`officialMmoWrites` is `false`.

Each JSON file represents one rejected candidate-vs-baseline scorecard lane:

- `role.worker-task.scorecard.json`
- `role.source-harvester.scorecard.json`
- `role.defender-micro.scorecard.json`

Top-level `construction-priority` or `top.construction` canary evidence must not
be counted as satisfying these role-policy fixtures.
