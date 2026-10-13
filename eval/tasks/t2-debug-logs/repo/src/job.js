const { dailySummary } = require("./report.js");

function runJob(teams) {
  return teams.map((t) => dailySummary(t.name, t.commits));
}

module.exports = { runJob };
