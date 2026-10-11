#!/bin/bash
set -euo pipefail
umask 077

readonly INSTALL_ROOT=/opt/nexus-cloudflare-broker
readonly MANIFEST_SHA256_OLD=913954ca1500e38b1f6a175830e5a817520d0d23e19462aff1654535daf5dea9
readonly MANIFEST_SHA256_NEW=7f9de0af9ceff3b9cd26c6504a27f6756b14689b7d06b642754e5dbdc6adb1a7

if [[ "$(/usr/bin/id -u)" != 0 ]]; then
	echo "rollback must be run by the operator as root" >&2
	exit 77
fi
if [[ ! -d "$INSTALL_ROOT" || -L "$INSTALL_ROOT" || "$(/usr/bin/stat -c %u "$INSTALL_ROOT")" != 0 ]]; then
	echo "dedicated installation root is absent or not a root-owned directory" >&2
	exit 1
fi
manifest="$INSTALL_ROOT/share/trusted-object-manifest.json"
manifest_digest=$(/usr/bin/sha256sum "$manifest" | /usr/bin/awk '{print $1}')
if [[ "$manifest_digest" != "$MANIFEST_SHA256_OLD" && "$manifest_digest" != "$MANIFEST_SHA256_NEW" ]]; then
	echo "installed manifest is not a recognized rollback target" >&2
	exit 1
fi
/usr/bin/python3.12 -I -S "$(/usr/bin/dirname -- "$(/usr/bin/readlink -f -- "$0")")/verify-install.py" \
	--root "$INSTALL_ROOT" --manifest "$manifest" --manifest-sha256 "$manifest_digest"
/usr/bin/rm -rf --one-file-system -- "$INSTALL_ROOT"
if [[ -e "$INSTALL_ROOT" || -L "$INSTALL_ROOT" ]]; then
	echo "rollback did not remove the dedicated installation root" >&2
	exit 1
fi
echo "removed only $INSTALL_ROOT; user Node/cf installations and Cloudflare auth state were untouched"
