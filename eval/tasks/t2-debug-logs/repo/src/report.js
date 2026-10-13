// Builds the daily summary line for a team.
function topContributor(commits) {
  const counts = {};
  for (const c of commits) counts[c.author] = (counts[c.author] || 0) + 1;
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return { name: sorted[0][0], commits: sorted[0][1] };
}

function dailySummary(team, commits) {
  const top = topContributor(commits);
  return `${team}: ${commits.length} commits, top ${top.name} (${top.commits})`;
}

module.exports = { dailySummary, topContributor };
