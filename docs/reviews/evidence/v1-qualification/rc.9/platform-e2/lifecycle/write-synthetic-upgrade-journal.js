const fs = require('node:fs');
const path = require('node:path');
const prefix = process.env.PREFIX;
const id = 'rc9-recovery-synthetic';
const sourceVersion = 'v0.1.0-alpha.2';
const targetVersion = 'v1.0.0-rc.9';
const lib = path.join(prefix, 'lib', 'nexus');
const now = '2026-10-26T18:54:00.000Z';
const entry = {
  formatVersion: 1, id, state: 'switched', sourceVersion,
  sourceInstallDir: path.join(lib, sourceVersion),
  sourceSymlinkTarget: path.join(lib, sourceVersion, 'bin', 'nexus'),
  targetVersion, targetInstallDir: path.join(lib, targetVersion),
  stagingDir: path.join(lib, '.tmp-upgrade-rc9-recovery'),
  prefix, binPath: path.join(prefix, 'bin', 'nexus'), startedAt: now, updatedAt: now,
};
fs.writeFileSync(path.join(lib, '.upgrade-journal.json'), JSON.stringify(entry), { mode: 0o600 });
