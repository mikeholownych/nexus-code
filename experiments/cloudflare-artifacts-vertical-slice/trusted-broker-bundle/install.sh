#!/bin/bash
set -euo pipefail
umask 077

readonly INSTALL_ROOT=/opt/nexus-cloudflare-broker
readonly PRIOR_MANIFEST_SHA256=7f9de0af9ceff3b9cd26c6504a27f6756b14689b7d06b642754e5dbdc6adb1a7
readonly PRIOR_INSTALL_ROOT=/opt/nexus-cloudflare-broker-previous-7f9de0af9cef
readonly CAPABILITY_ROOT=/etc/nexus-cloudflare-broker
readonly NODE_VERSION=24.21.0
readonly NODE_ARCHIVE="node-v${NODE_VERSION}-linux-x64.tar.xz"
readonly NODE_SHA256=fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6
readonly NODE_SIGNER=5BE8A3F6C8A5C01D106C0AD820B1A390B168D356
readonly MANIFEST_SHA256=b55ae32adce161f23176acbe1a8a048dd1165a076c95756823cc90e6d892df5a
readonly CF_VERSION=1.0.0-beta.10
readonly PROTECTED_ROOT=/opt

if [[ "$(/usr/bin/id -u)" != 0 ]]; then
	echo "installation must be run by the operator as root" >&2
	exit 77
fi

if [[ ! -d "$PROTECTED_ROOT" || -L "$PROTECTED_ROOT" || "$(/usr/bin/stat -c %u "$PROTECTED_ROOT")" != 0 ]]; then
	echo "protected parent /opt must be a root-owned real directory" >&2
	exit 1
fi
opt_mode=$(/usr/bin/stat -c %a "$PROTECTED_ROOT")
if (( (8#$opt_mode & 022) != 0 )); then
	echo "protected parent /opt is writable by group or other" >&2
	exit 1
fi

bundle_dir=$(/usr/bin/dirname -- "$(/usr/bin/readlink -f -- "$0")")
if [[ ! -d "$bundle_dir" || "$(/usr/bin/stat -c %u "$bundle_dir")" != 0 ]]; then
	echo "bundle must first be copied into a root-owned staging directory" >&2
	exit 1
fi
bundle_mode=$(/usr/bin/stat -c %a "$bundle_dir")
if (( (8#$bundle_mode & 022) != 0 )); then
	echo "bundle staging directory is writable by group or other" >&2
	exit 1
fi
if /usr/bin/find "$bundle_dir" -xdev ! -type d ! -type f -print -quit | /usr/bin/grep -q .; then
	echo "bundle staging tree may contain only regular files and directories" >&2
	exit 1
fi
while IFS= read -r -d '' object; do
	object_uid=$(/usr/bin/stat -c %u -- "$object")
	object_mode=$(/usr/bin/stat -c %a -- "$object")
	if [[ "$object_uid" != 0 ]] || (( (8#$object_mode & 022) != 0 )); then
		echo "bundle objects must be root-owned and not group/other writable" >&2
		exit 1
	fi
done < <(/usr/bin/find "$bundle_dir" -xdev -print0)
if [[ ! -d "$INSTALL_ROOT" || -L "$INSTALL_ROOT" ]]; then
	echo "expected prior protected installation is absent or not a real directory" >&2
	exit 1
fi
if [[ -e "$PRIOR_INSTALL_ROOT" || -L "$PRIOR_INSTALL_ROOT" ]]; then
	echo "fixed prior-installation hold path already exists; refusing replacement" >&2
	exit 1
fi
/usr/bin/python3.12 -I -S "$bundle_dir/verify-install.py" --root "$INSTALL_ROOT" \
	--manifest "$INSTALL_ROOT/share/trusted-object-manifest.json" --manifest-sha256 "$PRIOR_MANIFEST_SHA256"
if [[ ! -d "$CAPABILITY_ROOT" || -L "$CAPABILITY_ROOT" ]]; then
	echo "fixed capability directory custody is invalid" >&2
	exit 1
fi
capability_dir_uid=$(/usr/bin/stat -c %u "$CAPABILITY_ROOT")
capability_dir_gid=$(/usr/bin/stat -c %g "$CAPABILITY_ROOT")
capability_dir_mode=$(/usr/bin/stat -c %a "$CAPABILITY_ROOT")
if [[ "$capability_dir_uid" != 0 || "$capability_dir_gid" != 0 || "$capability_dir_mode" != 700 ]]; then
	echo "fixed capability directory custody is invalid" >&2
	exit 1
fi
for capability in artifacts-git.token worker.bearer; do
	capability_path="$CAPABILITY_ROOT/$capability"
	if [[ ! -f "$capability_path" || -L "$capability_path" ]]; then
		echo "required fixed demo capability is absent or invalid; refusing install" >&2
		exit 1
	fi
	capability_uid=$(/usr/bin/stat -c %u "$capability_path")
	capability_gid=$(/usr/bin/stat -c %g "$capability_path")
	capability_mode=$(/usr/bin/stat -c %a "$capability_path")
	capability_links=$(/usr/bin/stat -c %h "$capability_path")
	capability_size=$(/usr/bin/stat -c %s "$capability_path")
	if [[ "$capability_uid" != 0 || "$capability_gid" != 0 || "$capability_mode" != 400 || "$capability_links" != 1 ]] || (( capability_size < 16 || capability_size > 4096 )); then
		echo "fixed demo capability custody is invalid; refusing install" >&2
		exit 1
	fi
done

(cd "$bundle_dir" && /usr/bin/sha256sum --check --status BUNDLE.sha256)
/usr/bin/sha256sum --check --status < <(printf '%s  %s\n' "$MANIFEST_SHA256" "$bundle_dir/trusted-object-manifest.json")

stage_name=temporary_workspace_setup
work=$(/usr/bin/mktemp -d /opt/.nexus-cloudflare-broker-install.XXXXXXXX)
if ! diag_dir=$(/usr/bin/mktemp -d /opt/.nexus-cloudflare-broker-diagnostic.XXXXXXXX); then
	/usr/bin/rm -rf -- "$work" || true
	/usr/bin/printf 'installer_failure stage=diagnostic_directory_setup exit_status=1; temporary workspace removal attempted\n' >&2
	exit 1
fi
cleanup() {
	status=$?
	trap - EXIT HUP INT TERM
	if (( status != 0 )); then
		for log_name in npm-ci.log npm-signature-audit.log; do
			if [[ -f "$work/$log_name" ]]; then
				/usr/bin/tail -n 40 -- "$work/$log_name" >"$diag_dir/$log_name.tail" 2>/dev/null || true
			fi
		done
	fi
	if /usr/bin/rm -rf -- "$work"; then
		cleanup_result=removed
	else
		cleanup_result=failed
		status=1
	fi
	if (( status != 0 )); then
		for log_name in npm-ci.log npm-signature-audit.log; do
			if [[ -f "$work/$log_name" && ! -e "$diag_dir/$log_name.tail" ]]; then
				/usr/bin/tail -n 40 -- "$work/$log_name" >"$diag_dir/$log_name.tail" 2>/dev/null || true
			fi
		done
		{
			/usr/bin/printf 'installer_stage=%s\ninstaller_exit_status=%s\n' "$stage_name" "$status"
			/usr/bin/printf 'temporary_workspace_cleanup=%s\n' "$cleanup_result"
		} >"$diag_dir/summary.txt" 2>/dev/null || true
		/usr/bin/chmod 0600 "$diag_dir"/* 2>/dev/null || true
		/usr/bin/printf 'installer_failure stage=%s exit_status=%s diagnostics=%s\n' "$stage_name" "$status" "$diag_dir" >&2
		/usr/bin/printf 'diagnostic_cleanup=%s\n' "$cleanup_result" >&2
	else
		/usr/bin/rm -rf -- "$diag_dir"
	fi
	return "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
stage_name=exact_bundle_closure_verification
expected_files="$work/expected-files"
actual_files="$work/actual-files"
{ /usr/bin/awk '{path=$2; sub(/^\.\//, "", path); print path}' "$bundle_dir/BUNDLE.sha256"; /usr/bin/printf 'BUNDLE.sha256\n'; } | LC_ALL=C /usr/bin/sort >"$expected_files"
/usr/bin/find "$bundle_dir" -xdev -type f -printf '%P\n' | LC_ALL=C /usr/bin/sort >"$actual_files"
if ! /usr/bin/cmp -s "$expected_files" "$actual_files"; then
	echo "bundle contains missing or unindexed files" >&2
	exit 1
fi

stage_name=node_signature_verification
key_dir="$bundle_dir/upstream/node-v${NODE_VERSION}"
/usr/bin/gpgv --status-fd 3 --keyring "$key_dir/pubring.kbx" \
	"$key_dir/SHASUMS256.txt.sig" "$key_dir/SHASUMS256.txt" 3>"$work/gpg.status" 2>"$work/gpg.stderr"
/usr/bin/grep -Fq "VALIDSIG ${NODE_SIGNER} " "$work/gpg.status"

stage_name=node_archive_download
/usr/bin/curl --disable --fail --location --proto '=https' --tlsv1.2 --silent --show-error \
	--output "$work/$NODE_ARCHIVE" \
	"https://nodejs.org/dist/v${NODE_VERSION}/$NODE_ARCHIVE"
(cd "$work" && /usr/bin/sha256sum --check --status --ignore-missing "$key_dir/SHASUMS256.txt")
actual_node_sha=$(/usr/bin/sha256sum "$work/$NODE_ARCHIVE" | /usr/bin/awk '{print $1}')
[[ "$actual_node_sha" == "$NODE_SHA256" ]]

stage_name=node_archive_verification_and_extraction
/usr/bin/tar --extract --xz --file "$work/$NODE_ARCHIVE" --directory "$work" --no-same-owner --no-same-permissions
node_dist="$work/node-v${NODE_VERSION}-linux-x64"
node_source="$node_dist/bin/node"
npm_cli="$node_dist/lib/node_modules/npm/bin/npm-cli.js"
node_version=$(/usr/bin/env -i HOME=/ PATH=/usr/bin:/bin LANG=C.UTF-8 "$node_source" --version)
[[ "$node_version" == "v${NODE_VERSION}" ]]

stage_name=protected_tree_staging
stage="$work/nexus-cloudflare-broker"
/usr/bin/mkdir -m 0755 "$stage"
/usr/bin/mkdir -m 0755 "$stage/bin" "$stage/runtime" "$stage/cf-runtime" "$stage/broker" "$stage/share"
/usr/bin/install -o root -g root -m 0555 "$bundle_dir/bin/nexus-cf-broker" "$stage/bin/nexus-cf-broker"
/usr/bin/install -o root -g root -m 0555 "$node_source" "$stage/runtime/node"
/usr/bin/install -o root -g root -m 0444 "$bundle_dir/package.json" "$stage/cf-runtime/package.json"
/usr/bin/install -o root -g root -m 0444 "$bundle_dir/package-lock.json" "$stage/cf-runtime/package-lock.json"
for source in clean-start-check.mjs credential-probe-safe.mjs artifact-token-response.mjs linux-bound-exec.mjs credential-lifecycle.mjs demo-transport.mjs demo-transport-test.mjs; do
	/usr/bin/install -o root -g root -m 0444 "$bundle_dir/broker/$source" "$stage/broker/$source"
done
/usr/bin/install -o root -g root -m 0444 "$bundle_dir/trusted-object-manifest.json" "$stage/share/trusted-object-manifest.json"

empty_home="$work/empty-home"
/usr/bin/mkdir -m 0700 "$empty_home" "$work/npm-cache"
stage_name=npm_dependency_installation
/usr/bin/install -o root -g root -m 0600 /dev/null "$work/npm-globalconfig"
(cd "$stage/cf-runtime" && /usr/bin/env -i HOME="$empty_home" PATH=/usr/bin:/bin LANG=C.UTF-8 npm_config_userconfig=/dev/null npm_config_globalconfig="$work/npm-globalconfig" npm_config_cache="$work/npm-cache" \
	"$node_source" "$npm_cli" ci --ignore-scripts --no-audit --no-fund \
	--registry=https://registry.npmjs.org/ --userconfig=/dev/null --globalconfig="$work/npm-globalconfig") >"$work/npm-ci.log" 2>&1
stage_name=npm_signature_audit
(cd "$stage/cf-runtime" && /usr/bin/env -i HOME="$empty_home" PATH=/usr/bin:/bin LANG=C.UTF-8 npm_config_userconfig=/dev/null npm_config_globalconfig="$work/npm-globalconfig" npm_config_cache="$work/npm-cache" \
	"$node_source" "$npm_cli" audit signatures --userconfig=/dev/null --globalconfig="$work/npm-globalconfig") >"$work/npm-signature-audit.log" 2>&1
stage_name=cf_version_check
cf_version=$(cd / && /usr/bin/env -i HOME="$empty_home" PATH=/usr/bin:/bin LANG=C.UTF-8 NO_COLOR=1 \
	"$node_source" "$stage/cf-runtime/node_modules/cf/bin/cf" --version 2>/dev/null)
[[ "$cf_version" == *"v${CF_VERSION}"* ]]

stage_name=installed_tree_normalization_and_verification
/usr/bin/python3.12 -I -S "$bundle_dir/normalize-install.py" --root "$stage" --launcher bin/nexus-cf-broker --runtime runtime/node
/usr/bin/python3.12 -I -S "$bundle_dir/verify-install.py" --root "$stage" \
	--manifest "$stage/share/trusted-object-manifest.json" --manifest-sha256 "$MANIFEST_SHA256"

stage_name=atomic_installation
if [[ ! -d "$CAPABILITY_ROOT" ]]; then
	/usr/bin/install -d -o root -g root -m 0700 "$CAPABILITY_ROOT"
fi
capability_uid=$(/usr/bin/stat -c %u "$CAPABILITY_ROOT")
capability_gid=$(/usr/bin/stat -c %g "$CAPABILITY_ROOT")
capability_mode=$(/usr/bin/stat -c %a "$CAPABILITY_ROOT")
if [[ "$capability_uid" != 0 || "$capability_gid" != 0 || "$capability_mode" != 700 || -L "$CAPABILITY_ROOT" ]]; then
	echo "fixed capability directory custody is invalid" >&2
	exit 1
fi
/usr/bin/mv -- "$INSTALL_ROOT" "$PRIOR_INSTALL_ROOT"
if ! /usr/bin/mv -- "$stage" "$INSTALL_ROOT"; then
	/usr/bin/mv -- "$PRIOR_INSTALL_ROOT" "$INSTALL_ROOT"
	exit 1
fi
if ! /usr/bin/python3.12 -I -S "$bundle_dir/verify-install.py" --root "$INSTALL_ROOT" \
	--manifest "$INSTALL_ROOT/share/trusted-object-manifest.json" --manifest-sha256 "$MANIFEST_SHA256"; then
	failed_root="${INSTALL_ROOT}-failed-${MANIFEST_SHA256:0:12}"
	if [[ ! -e "$failed_root" && ! -L "$failed_root" ]]; then /usr/bin/mv -- "$INSTALL_ROOT" "$failed_root"; fi
	/usr/bin/mv -- "$PRIOR_INSTALL_ROOT" "$INSTALL_ROOT"
	exit 1
fi
echo "updated protected broker tree at $INSTALL_ROOT; prior installation retained at $PRIOR_INSTALL_ROOT; fixed capability files were metadata-validated and left unchanged"
