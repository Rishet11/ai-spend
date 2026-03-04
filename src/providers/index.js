const codex = require('./codex');
const claudeCode = require('./claude-code');
const antigravity = require('./antigravity');
const cursor = require('./cursor');

const providers = {
  codex,
  'claude-code': claudeCode,
  antigravity,
  cursor
};

module.exports = providers;
