# RL Reward Decision Examples

These files are tracked seed examples for issue #907. They live under `docs/ops/examples/` because repository-level `runtime-artifacts/` is gitignored and has no tracked convention files.

Every example is a proposal only. None of these files accepts a reward change, authorizes training promotion, or permits official MMO writes.

Validate the examples with:

```bash
python3 scripts/validate_rl_reward_decisions.py docs/ops/examples/rl-reward-decisions
```

Current examples:

- `RD-0001-defense-construction.json`
- `RD-0002-worker-load-efficiency.json`
- `RD-0003-stuck-actionless-creeps.json`
- `RD-V3-004-constructionNeglectPenalty.json`
- `RD-V3-005-onlineReliabilityRollbackPenalty.json`
