#!/bin/sh
set -eu
umask 077
bundle_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
/usr/bin/cc -static -fPIE -pie -Wl,--build-id=none \
	-o "$bundle_dir/bin/nexus-cf-broker.new" "$bundle_dir/launcher.c"
/usr/bin/chmod 0555 "$bundle_dir/bin/nexus-cf-broker.new"
/usr/bin/mv -f -- "$bundle_dir/bin/nexus-cf-broker.new" "$bundle_dir/bin/nexus-cf-broker"
if /usr/bin/ldd "$bundle_dir/bin/nexus-cf-broker" 2>&1 | /usr/bin/grep -q 'not a dynamic executable'; then
	exit 0
fi
echo 'launcher is not statically linked' >&2
exit 1
