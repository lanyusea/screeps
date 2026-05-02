# Rules Remediation Baseline

Date: 2026-05-01
Tracking issue: https://github.com/lanyusea/screeps/issues/427

This is a lightweight baseline snapshot, not a system freeze. It preserves rollback/QA context for the rules/domain remediation requested by the owner.

## Current canonical facts

- Current official target: `main / shardX / E26S49`.
- GitHub active source of truth: Issues, PRs, Milestones, and Project `screeps` #3.
- Repo baseline HEAD at capture: `0235a3a`.
- Open issues captured: 16.
- Open PRs captured: 2.
- Project fields captured: 21.
- Latest E26S49 runtime artifact: `/root/screeps/runtime-artifacts/screeps-monitor/cron-check-shardX-E26S49-20260501T080144Z`.

## Known drift being remediated

- Gameplay Evolution review/archive prompts still referenced old room targets in prior audit evidence.
- P0 monitor expected-job table referenced old cadence/schedule assumptions.
- GitHub issue/PR templates still used old roadmap/category language and title parsing.
- Project `Domain` is the single primary classification field; no separate Track field will be added.
- Domain progress display in GitHub Pages and Discord roadmap/image channel must use the final minimal Domain set.
- Historical `E48S28` / `E48S29` evidence must be preserved as historical/superseded, not treated as current target state.

## Baseline artifact locations

Local baseline files captured under `/tmp/screeps-rules-baseline/`:

- `git.txt`
- `project-fields.json`
- `open-issues.json`
- `open-prs.json`
- `runtime.json`

These files are not committed because they contain bulky live snapshots; this process note records the key counts and current target facts.

## Git status excerpt

```text
## git status
## main
?? scripts/__pycache__/
## head
0235a3a
## worktrees
worktree /root/screeps
HEAD 0235a3adcfb11587f6e76d2930e94f995000118e
branch refs/heads/main

worktree /root/screeps-worktrees/affordable-worker-body-96
HEAD f6dd3722237b6af27c110dc57a8558a8f4e3b064
branch refs/heads/feat/affordable-worker-body-96

worktree /root/screeps-worktrees/alert-telemetry-32
HEAD a4f6ab163a8b6ba70cc171611f31eaa7e5987220
branch refs/heads/feat/alert-telemetry-32

worktree /root/screeps-worktrees/automate-private-smoke
HEAD 4a818515536915cd1c15dcae55cbfa163e172e7e
branch refs/heads/chore/private-smoke-harness-20260426

worktree /root/screeps-worktrees/autonomous-scheduler-78
HEAD a562b7da64e98555ce9c8542154fef1efc4a5669
branch refs/heads/docs/autonomous-scheduler-78

worktree /root/screeps-worktrees/capacity-worker-body-104
HEAD 07bb5c98415ed49bc7371cfb429ee1eb390ab908
branch refs/heads/feat/capacity-worker-body-104

worktree /root/screeps-worktrees/claim-target-scoring-189
HEAD 0a777954d4ec2ca5052251f1a6c67b39e0818d23
branch refs/heads/feat/claim-target-scoring-189

worktree /root/screeps-worktrees/construction-backlog-worker-bonus-253
HEAD d398718b64762ef5626b74cccc36355be67ac023
branch refs/heads/feat/construction-backlog-worker-bonus-253

worktree /root/screeps-worktrees/construction-priority-231
HEAD e9059bf35a2a63c9ce25218b08a3ddac6bde28ed
branch refs/heads/feat/construction-priority-231

worktree /root/screeps-worktrees/construction-worker-throughput-152
HEAD 2139eb0e523ada4ac3714873b547ba5ebde7961b
branch refs/heads/feat/construction-worker-throughput-152

worktree /root/screeps-worktrees/consume-occupation-recommendation-239
HEAD a9ebe8f0cbf8651a7f2f8361b38ed751ebc80725
branch refs/heads/feat/consume-occupation-recommendation-239

worktree /root/screeps-worktrees/controller-downgrade-guard-89
HEAD b1c82c8ef2126e99144acd733ccc7e336143d336
branch refs/heads/feat/controller-downgrade-guard-89

worktree /root/screeps-worktrees/controller-progress-sustain-106
HEAD 6593e6377c1923675c7a567c1a0fddb574478e15
branch refs/heads/feat/controller-progress-sustain-106

worktree /root/screeps-worktrees/controller-surplus-upgrade-147
HEAD a3cb488bbe329afcb14de84ebc2972381bfeedde
branch refs/heads/feat/controller-surplus-upgrade-147

worktree /root/screeps-worktrees/cron-qa-pr-110
HEAD 691a773ccc54108775df770077222d391e08bc51
detached

worktree /root/screeps-worktrees/cron-qa-pr-111
HEAD 6593e6377c1923675c7a567c1a0fddb574478e15
detached

worktree /root/screeps-worktrees/cron-qa-pr-112
HEAD 4340d13e2a54ed33356dc6ba5d32cd53461f6fae
detached

worktree /root/screeps-worktrees/docs-rl-self-evolution-232
HEAD 969faf9db08d31da58e398e177b49b9f6b937f0c
branch refs/heads/docs/rl-self-evolution-232

worktree /root/screeps-worktrees/dropped-resource-priority-148
HEAD c4c07a2ddea868573ff36ec5234602920471dbb7
branch refs/heads/feat/dropped-resource-priority-148

worktree /root/screeps-worktrees/early-road-planner-121
HEAD 80b886c1c7784cb409337178c87dba581380b25a
branch refs/heads/feat/early-road-planner-121

worktree /root/screeps-worktrees/economy-post338-340
HEAD 902d002a8c74e3247a6a9064e981b20bdaae2ae8
branch refs/heads/feat/economy-post338-340

worktree /root/screeps-worktrees/economy-post344-345
HEAD 2c07cdda44fd7775925d162b6b5912aa92be77cc
branch refs/heads/feat/economy-post344-345

worktree /root/screeps-worktrees/economy-post346-347
HEAD a98c9615144186dd4282ff7bbdc6e8c00b59061d
branch refs/heads/feat/economy-post346-347

worktree /root/screeps-worktrees/economy-post348-349
HEAD e10f5bb144d64d8b24ee16756c1d212cfb1dfa69
branch refs/heads/feat/economy-post348-349

worktree /root/screeps-worktrees/economy-post350-351
HEAD dd15a84854752764be944c2021140093f2c83541
branch refs/heads/feat/economy-post350-351

worktree /root/screeps-worktrees/economy-post352-353
HEAD 1f5f61aebed90799cbfcaeea074140e5072da924
branch refs/heads/feat/economy-post352-353

worktree /root/screeps-worktrees/economy-post354-356
HEAD dcbe29b114428180f26a59821680728d637b8b5e
branch refs/heads/feat/economy-post354-356

worktree /root/screeps-worktrees/economy-post366-367
HEAD 6d1ca07a70502121b045d4e8b2741d7b954b189f
branch refs/heads/feat/economy-post366-367

worktree /root/screeps-worktrees/economy-post370-372
HEAD 63192569a3463a54782e387a13e9bcecda294b25
branch refs/heads/feat/economy-post370-372

worktree /root/screeps-worktrees/economy-post374-376
HEAD bd7cde6d80f7a09e39019a5b84838b45a9c62e52
branch refs/heads/feat/economy-post374-376

worktree /root/screeps-worktrees/economy-post378-379
HEAD 54b5077eed1566def96c35cff871e8c1cca0d2bc
branch refs/heads/feat/economy-post378-379

worktree /root/screeps-worktrees/economy-post382-384
HEAD 492f3e94468095e8a599ba854d9540b2c156037a
branch refs/heads/feat/economy-post382-384

worktree /root/screeps-worktrees/economy-post386-387
HEAD 16b607817a0f641d188437eecfa1cda8661f9ab2
branch refs/heads/feat/economy-post386-387

worktree /root/screeps-worktrees/economy-post389-391
HEAD 3992a5a27cb3264a7b9a0ca8435b8837f72a1baf
branch
```
