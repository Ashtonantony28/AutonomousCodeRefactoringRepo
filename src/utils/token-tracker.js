'use strict';

const CONTEXT_BUDGET = 80_000;
const SATURATION_WARN = 0.70;

class TokenTracker {
  constructor(session) {
    this.session = session;
    if (!session.token_usage) session.token_usage = { analyzer: 0, critic: 0, executor: 0 };
    if (!session.context_saturation) session.context_saturation = { analyzer: 0, critic: 0, executor: 0 };
  }

  record(agent, usage = {}) {
    const tokens = (usage.input_tokens || 0) + (usage.output_tokens || 0);
    this.session.token_usage[agent] = (this.session.token_usage[agent] || 0) + tokens;
    const saturation = Math.min(1, this.session.token_usage[agent] / CONTEXT_BUDGET);
    this.session.context_saturation[agent] = saturation;
    return { tokens, saturation, exceeded: saturation >= SATURATION_WARN };
  }

  saturationOf(agent) {
    return this.session.context_saturation[agent] || 0;
  }

  shouldPrune(agent) {
    return this.saturationOf(agent) >= SATURATION_WARN;
  }

  static get CONTEXT_BUDGET() { return CONTEXT_BUDGET; }
  static get SATURATION_WARN() { return SATURATION_WARN; }
}

module.exports = { TokenTracker, CONTEXT_BUDGET, SATURATION_WARN };
