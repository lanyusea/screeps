# Git Archival Process Note

Date: 2026-04-25

## Why this matters

We want every meaningful Screeps artifact to be preserved with git so the project has a clean history and the material can later be reused for writing.

## What we set up

- A repo-local archival script: `scripts/git-archive.sh`
- A recurring archive job that commits and pushes changes on a schedule
- A remote configured for SSH-based GitHub authentication

## Why this is useful for a blog later

- It demonstrates disciplined project archival instead of ad-hoc note taking.
- It shows how a small team can maintain a clean documentation history.
- It gives a concrete example of treating project notes as reusable assets.

## Notes for future writing

Potential blog angle:
- why recurring git archival reduces lost context
- how to preserve research/process notes while iterating quickly
- how the combination of docs classification + git history improves long-term maintainability
