## Linked issues

Intentional PR-body closing linkage:
- <!-- Use a GitHub closing keyword only in this PR body, and only when this PR satisfies ALL original acceptance criteria for the issue at merge time. Example: Fixes #123. Commit messages must not contain GitHub closing keywords for tracked issues. -->

Related / non-closing linkage:
- <!-- Use wording such as "Related to issue 123" for enabling work, post-merge validation, owner-action blockers, live service/process proof, successors, or partial fixes. Do not use negated close-keyword phrases such as "does not close #123" in the PR body or commit messages. -->

## Domain / Kind

- Domain: <!-- Agent OS / Change-control / Runtime monitor / Release/deploy / Bot capability / Combat / Territory/Economy / Gameplay Evolution / RL flywheel / Docs/process -->
- Kind: <!-- bug / ops / docs / test / code / review / research / qa -->

## Summary

- 

## Verification

- [ ] Local check: <!-- command/result -->
- [ ] GitHub Project issue/PR fields are current (`Status`, `Evidence`, `Next action`; plus `Blocked by` when blocked).
- [ ] Automated review has no blocking findings and review threads are resolved/outdated/non-blocking.
- [ ] QA gate: <!-- PASS / not required with reason -->
- [ ] No secrets, unsafe local paths, or owner-facing raw attachment trigger lines are included.

## Issue closure gate

For every issue linked above in the PR body with a closing keyword:

- [ ] #<!-- issue number -->: <!-- checked evidence that all original issue acceptance criteria are satisfied now, before merge -->
- [ ] No closed issue still needs post-merge validation, runtime/process proof, owner action, successor/follow-up work, partial-fix completion, or any other blocker.

## Runtime / deployment impact

- [ ] No gameplay/runtime/deployment impact.
- [ ] Gameplay/runtime/deployment impact; Deployment Floor evidence or HELD blocker is recorded.

## Notes

- Review/merge gates: wait at least 15 minutes after PR creation, require green checks, and keep linked GitHub issue/PR/Project state current until merged or explicitly closed.
- Commit messages must not contain GitHub closing keywords for tracked issues; intentional closure must happen in the PR body with the Issue closure gate, or not at all.
