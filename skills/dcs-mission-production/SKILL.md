---
name: dcs-mission-production
description: Use when creating, revising, or preparing a playable DCS mission, or when resuming mission work that needs validation and flight evidence.
---

# DCS mission production

Carry the user's mission intent through a durable project, immutable revisions and revision-specific evidence. Use the connected DCS Sortie MCP server; no external AI service is required.

## Start or resume

Read dcs://guide/conventions. If a project already exists, call dcs_production_status and continue its next actions. Otherwise record the objective, theatre, player/start, forces, outcomes, dependencies and assumptions. Resolve only missing decisions that materially affect the mission; use stated constraints and reasonable defaults for routine choices.

Check exact types, installed dependencies, terrain/footprints, aircraft coverage and historical scope before promising fidelity. dcs_authoring_coverage_audit distinguishes available records from missing evidence. Generic layouts, unsupported pairings and missing service dates stay explicit.

Create the project with dcs_production_create. Define named checks that establish the intended behavior: relevant spawn, scenario_outcome (victory/failure) for generated objectives or an explicit flag/event, plus any landing destination/service requirements. A generic LAND event does not prove landing on the requested carrier: include place. Qualitative dialogue/tactics checks use manual and remain unknown to automatic evaluation.

## Generate, validate, revise

Use dcs_production_generate with a validated scenario, or import an existing unmarked editing session with dcs_production_revise at expectedRevision=0. Inspect the returned exact mission path, digest, validation errors and warnings. Explain material unknowns and address errors before flight.

Open the current revision with dcs_miz_open for supported edits. Checkpoint using dcs_production_revise with the current expectedRevision and specific change notes. Use the new returned revision; older .miz files remain intact. dcs_production_validate checks the saved archive bytes. Embedded generation reports describe their original generation and can be stale after edits.

## Fly and collect

When flight testing is authorized, launch/load the exact revision path using available DCS/desktop capabilities. The bridge cannot reliably start a cold-menu mission; loading requests alone do not prove a swap. Observe the actual running mission. Preserve existing user simulator work and shut down task-started DCS when requested.

Call dcs_production_capture while that revision runs. It saves native observations and a bounded log tail only when the unique mission name and latest production marker match. Repeat for missing observable events; retention gaps are not proof that an event never happened. Successful orbit serialization does not prove AWACS/tanker service.

## Deliver or continue

Read dcs_production_status. Report the exact revision/file, offline result, observed declared checks, and unresolved qualitative/data limits. declared_checks_observed means those checks were seen, not universal playability. Every new revision starts without flight evidence: old logs, CI and a prior sortie cannot verify changed loadouts, tasks or outcomes.

For schemas and examples, read [tool contracts](references/workflow.md), exposed to MCP clients as dcs://skills/mission-production/contracts.
