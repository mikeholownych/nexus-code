#!/bin/bash
# fresh isolated env
S=${S:-/tmp/nexus-tui-audit}
rm -rf $S/home $S/ws $S/state; mkdir -p $S/home $S/ws $S/state
cd $S/ws && git init -q && git config user.name t && git config user.email t@t.invalid
echo base > base.txt; printf '# Demo\n\nA small repository.\n' > README.md; echo '{"name":"demo","scripts":{"test":"echo ok"}}' > package.json
git add . && git commit -qm base
[ "$1" = trust ] && { mkdir -p $S/home/.config/nexus; echo "{\"trustedPaths\":[\"$(realpath $S/ws)\"]}" > $S/home/.config/nexus/trusted_workspaces.json; }
true
