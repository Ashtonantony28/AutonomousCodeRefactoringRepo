# Autonomous Code Refactoring System

A multi-agent pipeline that points Claude at a Git repo, finds tech debt, validates
refactoring proposals with hybrid AI + AST logic, applies the safe ones, runs the
test suite, and learns from the outcomes.

## Architecture

```
Orchestrator
  ├── Analyzer  ─► proposals
  ├── Critic    ─► verdict (Claude)
  ├── AST checker ─► pattern_score
  ├── Hybrid validator ─► combined_confidence
  ├── RL gate (logistic regression, trained on past outcomes)
  ├── Executor  ─► applies + tests + reverts on failure
  └── Tracer + Dashboard ─► dashboard/dashboard.html
```

See [`CLAUDE.md`](./CLAUDE.md) for conventions, budgets, and the reward function.

## Setup

```bash
npm install
export ANTHROPIC_API_KEY=sk-ant-...
```

## Run

```bash
node src/orchestrator.js --repo /path/to/target/repo
node src/orchestrator.js --repo /path/to/target/repo --dry-run
node src/orchestrator.js --repo /path/to/target/repo --resume
```

After every run, open `dashboard/dashboard.html` in a browser.

## Layout

```
src/
  orchestrator.js
  agents/      analyzer.js  critic.js  executor.js
  validation/  ast-checker.js  hybrid-validator.js
  rl/          collector.js  classifier.js  reward.js
  interpretability/  tracer.js  probe.js  dashboard.js
  runner/      test-runner.js  reverter.js
  utils/       file-discovery.js  token-tracker.js  checkpoint.js
state/         session.json  rl-weights.json  proposals.json
dashboard/     dashboard.html
```
