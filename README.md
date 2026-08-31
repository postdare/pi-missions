# pi-missions

Factory-style **Missions** for [pi](https://github.com/earendil-works/pi-coding-agent):
validation-contract-driven, milestone-gated multi-agent orchestration for work that is
too big for one session — built on top of
[pi-subagents](https://github.com/nicobailon/pi-subagents).

Inspired by [Factory Missions](https://factory.ai/news/missions-architecture):
an orchestrator decomposes a goal into a **validation contract** (behavioral
assertions written *before* any implementation), **milestones**, and bounded
**features**; fresh-context workers implement features test-first; independent
validators gate every milestone; validation failures trigger bounded fix cycles.

```
/mission "migrate the CLI to TypeScript"
   │  planning dialogue (you ↔ LLM, guided by the mission-planning skill)
   ▼
mission_submit_plan tool  →  .pi/missions/<id>/{mission.json, contract.md}
   │
   ▼
/mission-start            →  approve → async runner workflow spawns
   │
   ▼  per milestone:
   │    mission-worker × N features (test-first, structured report)
   │    mission-scrutiny + mission-usertest (parallel validators, structured verdict)
   │    on issues → mission-fix-planner → fix workers → re-validate (≤ N rounds)
   ▼
mission complete / blocked → control handed back to you
```

## Install

```bash
pi install /path/to/pi-missions            # local path
pi install git:github.com/<you>/pi-missions@v0.1.0
```

Requires **pi-subagents** (`pi install npm:pi-subagents`) — pi-missions drives its
orchestration runtime over the in-process RPC bridge.

## Usage

| Command | What it does |
|---|---|
| `/mission <goal>` | Start the planning dialogue for a new mission |
| `/mission-start [id]` | Approve the plan and launch (or resume) execution |
| `/mission-status [id]` | Show ledger + live progress of one or all missions |
| `/mission-steer <msg>` | Inject guidance into the running workflow |
| `/mission-stop [id]` | Stop the running workflow (resume later with `/mission-start`) |

While a mission runs, a footer status line shows live feature/milestone progress
(updated every 15s from the workflow's durable state).

## How it works

- **Planning is LLM work; execution is code.** The planning dialogue produces a
  structured plan (contract + milestones + features) stored as a ledger under
  `.pi/missions/<id>/`. `/mission-start` compiles the ledger into a deterministic
  pi-subagents `workflowScript` (saved to `.pi/missions/<id>/runner.js` for
  inspection) and launches it as one async workflow.
- **Roles are separate agents** (`agents/`): `mission-worker` (implements,
  test-first, never judges), `mission-scrutiny` (adversarial code review against
  the contract), `mission-usertest` (black-box app driving via smoke commands),
  `mission-fix-planner` (turns issues into ≤5 bounded fix specs).
- **Structured handoffs.** Every role reports via `outputSchema`; the runner
  checkpoints progress into the workflow's durable `state`, which the extension
  reads for the status line and for resume.
- **Resume.** A crashed/stopped mission restarts with `/mission-start <id>`:
  the script is regenerated from the ledger, skipping features already done.
  Note: the workflow interpreter lives in the pi process, so keep the session
  alive while a mission runs (running children survive, the loop does not).

## Model routing

Agents inherit your default model unless overridden. Per-role routing via
pi-subagents settings (user or project):

```json
{
  "subagents": {
    "agentOverrides": {
      "mission-worker":    { "model": "anthropic/claude-sonnet-4" },
      "mission-scrutiny":  { "model": "openai/gpt-5", "thinking": "high" },
      "mission-usertest":  { "model": "anthropic/claude-haiku-4-5" }
    }
  }
}
```

## Layout

```
package.json          # pi package manifest (extensions + skills + pi-subagents agents)
extensions/index.ts   # commands, mission_submit_plan tool, status line, RPC client wiring
src/ledger.ts         # mission schema + .pi/missions/<id>/ persistence
src/runner-script.ts  # mission ledger → workflowScript compiler (the execution loop)
src/rpc.ts            # pi-subagents RPC bridge client + live-progress reader
src/runtime-agents.ts # fallback agent registration when loaded via `pi -e`
agents/*.md           # the four role agents
skills/mission-planning/SKILL.md  # planning discipline for the LLM planner
```

## Known limits (MVP)

- Validators registered via the runtime fallback (when using `pi -e` instead of
  a proper install) lose frontmatter-only settings such as `completionGuard`.
- Serial feature execution within a milestone (deliberate: one writer per repo).
- No worktree isolation yet — missions write to the current checkout.
- User-testing validator is shell-based (curl/CLI/smoke commands), no GUI
  computer-use.
- `state.json` discovery scans `~/.pi/agent/missions/projects/*/`; cross-host or
  customized mission directories are not found.
