# Heartbeat Orchestrator

The heartbeat is an autonomous inbox processing pipeline. It does NOT run as an agent prompt.

## Pipeline
1. Intake: pull pending items, run value-extraction triage (GLM)
2. Research: quick scan investigate items, check contextual signals, auto deep dive on strong signals
3. Knowledge Integration: write NotePlan notes with [[wikilinks]], update theme clusters
4. Surfacing: compose Telegram digest, surface items needing user decisions

## Configuration
- Interval: 30 minutes
- Quiet hours: 23:00 - 08:00
- Maintenance tasks: moved to separate "System Maintenance" cron job

## References
- Workflow manifest: knowledge/WORKFLOW.md
- Interest profile: knowledge/INTERESTS.md
- Design doc: docs/plans/2026-03-23-heartbeat-orchestrator-design.md
