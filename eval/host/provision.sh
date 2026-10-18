#!/usr/bin/env bash
# Provision the qualification host (eval/host/README.md). Run as root on the qualification host only:
#   sudo OPERATOR=<harness user> bash eval/host/provision.sh
# Idempotent. Touches only: the acl package, the nexus-eval system account and its home, one sudoers drop-in, one
# systemd mount unit for the tmpfs workspace root (and the root's parent directory if absent), and /opt/nexus-qual.
# Fail-closed on collisions: a pre-existing account, sudoers file, unit, runtime directory or mount that this procedure
# did not create stops the run unchanged. Every creation is first recorded as `pending <kind> <value>` in a root-only
# ledger and then confirmed, so an interrupted run can be resumed or rolled back; rollback.sh removes only resources the
# ledger names and that still verifiably belong to this procedure.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly HERE
readonly PROFILE="$HERE/resource-profile.json"
readonly ACCOUNT=nexus-eval
readonly ACCOUNT_HOME=/var/lib/nexus-eval
readonly SUDOERS=/etc/sudoers.d/99-nexus-eval
readonly LEGACY_SUDOERS=/etc/sudoers.d/90-nexus-eval
readonly RUNTIME=/opt/nexus-qual
readonly LEDGER_DIR=/var/lib/nexus-qual-host
readonly LEDGER="$LEDGER_DIR/ledger"
readonly MARKER="# Managed by nexus-code eval/host/provision.sh"
readonly RUNTIME_MARKER="$RUNTIME/.nexus-qual-managed"

[[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 2; }
: "${OPERATOR:?set OPERATOR to the account that runs eval/run.mjs}"
[[ "$OPERATOR" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || { echo "operator name is not a plain user name" >&2; exit 2; }
id -u "$OPERATOR" >/dev/null 2>&1 || { echo "operator $OPERATOR does not exist" >&2; exit 2; }
[[ "$OPERATOR" != "$ACCOUNT" && "$OPERATOR" != root ]] || { echo "operator must be a separate, non-root account" >&2; exit 2; }
command -v jq >/dev/null || { echo "jq is required to read $PROFILE" >&2; exit 2; }
workspace_root=$(jq -er .workspaceRoot "$PROFILE")
storage_bytes=$(jq -er .storageBytes "$PROFILE")
[[ "$workspace_root" =~ ^/srv/[a-z0-9-]+/[a-z0-9-]+$ && "$storage_bytes" =~ ^[0-9]+$ ]] || { echo "unexpected profile values" >&2; exit 2; }
workspace_parent="$(dirname "$workspace_root")"
unit="$(systemd-escape -p --suffix=mount "$workspace_root")"
unit_file="/etc/systemd/system/$unit"
op_uid=$(id -u "$OPERATOR"); op_gid=$(id -g "$OPERATOR")

if [[ -e "$LEDGER_DIR" || -L "$LEDGER_DIR" ]]; then
  [[ ! -L "$LEDGER_DIR" && -d "$LEDGER_DIR" && "$(stat -c %u:%g:%a "$LEDGER_DIR")" == "0:0:700" ]] || { echo "unsafe ledger directory $LEDGER_DIR" >&2; exit 1; }
fi
for f in "$LEDGER_DIR/lock" "$LEDGER"; do
  if [[ -e "$f" || -L "$f" ]]; then
    [[ ! -L "$f" && -f "$f" && "$(stat -c %u:%g "$f")" == "0:0" ]] || { echo "unsafe ledger file $f" >&2; exit 1; }
  fi
done
install -d -o root -g root -m 0700 "$LEDGER_DIR"
exec 9>"$LEDGER_DIR/lock"
flock -n 9 || { echo "another provision or rollback is running" >&2; exit 1; }
touch "$LEDGER"; chmod 0600 "$LEDGER"
has() { grep -qxF "$1" "$LEDGER"; }
sha() { sha256sum "$1" | cut -d' ' -f1; }
pending() { has "pending $1" || printf 'pending %s\n' "$1" >> "$LEDGER"; }
# Rewrite the ledger without line $1 (atomic, root-only).
drop() { local tmp; tmp="$(mktemp "$LEDGER_DIR/.ledger.XXXXXX")"; grep -vxF "$1" "$LEDGER" > "$tmp" || true; chmod 0600 "$tmp"; mv "$tmp" "$LEDGER"; }
confirm() { drop "pending $1"; has "$1" || printf '%s\n' "$1" >> "$LEDGER"; }
# A written file is recorded with its digest; earlier digests for the same path are replaced.
record_file() {
  local tmp; tmp="$(mktemp "$LEDGER_DIR/.ledger.XXXXXX")"
  # Exact field comparison via ENVIRON (paths contain backslashes, e.g. systemd's \x2d escapes).
  P="$1" awk '!(($1 == "file" && $2 == ENVIRON["P"]) || ($1 == "pending" && $2 == "file" && $3 == ENVIRON["P"]))' "$LEDGER" > "$tmp"
  printf 'file %s sha256=%s\n' "$1" "$(sha "$1")" >> "$tmp"; chmod 0600 "$tmp"; mv "$tmp" "$LEDGER"
}
account_line() { printf 'account %s uid=%s home=%s' "$ACCOUNT" "$(id -u "$ACCOUNT")" "$ACCOUNT_HOME"; }
ours_account() {   # recorded (or pending from an interrupted run) and still the same account
  id -u "$ACCOUNT" >/dev/null 2>&1 || return 1
  has "$(account_line)" && return 0
  has "pending account $ACCOUNT" && [[ "$(getent passwd "$ACCOUNT" | cut -d: -f6,7)" == "$ACCOUNT_HOME:/usr/sbin/nologin" ]]
}
# A file is ours only if it is a regular file with the marker whose content is what we last wrote (or was in flight).
ours_file() {
  [[ -f "$1" && ! -L "$1" ]] && head -n 1 "$1" | grep -qxF "$MARKER" || return 1
  has "file $1 sha256=$(sha "$1")" || has "pending file $1"
}
# A directory is ours only once confirmed; a pending entry never adopts a directory that exists.
ours_dir() { has "dir $1"; }
# Collision checks first: nothing is changed unless every resource is absent or verifiably ours.
problems=()
if id -u "$ACCOUNT" >/dev/null 2>&1 && ! ours_account; then problems+=("account $ACCOUNT exists but was not created by this procedure"); fi
if [[ -e "$ACCOUNT_HOME" ]] && ! id -u "$ACCOUNT" >/dev/null 2>&1 && has "pending account $ACCOUNT"; then
  problems+=("an interrupted run left $ACCOUNT_HOME without the $ACCOUNT account; inspect it, remove it by hand, then re-run")
elif [[ -e "$ACCOUNT_HOME" ]] && ! ours_account; then problems+=("$ACCOUNT_HOME exists but was not created by this procedure"); fi
for file in "$SUDOERS" "$unit_file"; do
  if [[ -e "$file" || -L "$file" ]] && ! ours_file "$file"; then problems+=("$file exists (or is a symlink) and is not this procedure's"); fi
done
for dir in "$workspace_parent" "$workspace_root"; do
  if [[ -L "$dir" ]] || { [[ -e "$dir" ]] && [[ "$(realpath "$dir")" != "$dir" ]]; }; then problems+=("$dir is or passes through a symlink"); fi
done
if findmnt --mountpoint "$workspace_root" >/dev/null && ! ours_file "$unit_file"; then problems+=("$workspace_root is already a mount point not made by this procedure"); fi
if [[ -e "$LEGACY_SUDOERS" || -L "$LEGACY_SUDOERS" ]] && ! ours_file "$LEGACY_SUDOERS"; then problems+=("$LEGACY_SUDOERS exists (or is a symlink) and is not this procedure's"); fi
if [[ -e "$workspace_root" ]] && ! ours_dir "$workspace_root" && [[ -n "$(ls -A "$workspace_root" 2>/dev/null)" ]]; then problems+=("$workspace_root exists and is not empty"); fi
if [[ -e "$RUNTIME" ]] && ! ours_dir "$RUNTIME"; then problems+=("$RUNTIME exists but was not created by this procedure"); fi
if ((${#problems[@]})); then printf 'refusing to provision (no changes made):\n' >&2; printf '  - %s\n' "${problems[@]}" >&2; exit 1; fi

# Drop stale pending directory entries only after every collision check succeeds.
while IFS= read -r line; do
  path="${line#pending dir }"
  [[ -e "$path" || -L "$path" ]] && drop "$line"
done < <(grep '^pending dir ' "$LEDGER" || true)
if ours_file "$LEGACY_SUDOERS"; then legacy_sha=$(sha "$LEGACY_SUDOERS"); rm -f "$LEGACY_SUDOERS"; drop "file $LEGACY_SUDOERS sha256=$legacy_sha"; drop "pending file $LEGACY_SUDOERS"; fi

# 1. setfacl, which the harness uses to grant the evaluator uid access to each disposable run directory.
if ! command -v setfacl >/dev/null; then
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install --yes --no-install-recommends acl
  confirm "package acl"
fi

# 2. The evaluator account: a system user with no login shell and a private home it never needs for runs.
if ! id -u "$ACCOUNT" >/dev/null 2>&1; then
  free_uid=""
  for u in $(seq 985 -1 900); do
    if ! id -u "$u" >/dev/null 2>&1 && ! pgrep -u "$u" >/dev/null 2>&1; then free_uid="$u"; break; fi
  done
  [[ -n "$free_uid" ]] || { echo "no free system uid in 900..985" >&2; exit 1; }
  pending "account $ACCOUNT"
  useradd --system --uid "$free_uid" --home-dir "$ACCOUNT_HOME" --create-home --shell /usr/sbin/nologin "$ACCOUNT"
fi
if has "pending account $ACCOUNT"; then confirm "$(account_line)"; drop "pending account $ACCOUNT"; fi
chmod 0700 "$ACCOUNT_HOME"

# 3. The only privilege: the operator may run Bubblewrap as the evaluator account, without a password. The harness
#    invokes exactly `sudo -n -u nexus-eval -- /usr/bin/bwrap …` (eval/validate.mjs asUser).
tmp="$(mktemp)"
printf '%s\n%s ALL=(%s) !ALL\n%s ALL=(%s) NOPASSWD: /usr/bin/bwrap\n' "$MARKER" "$OPERATOR" "$ACCOUNT" "$OPERATOR" "$ACCOUNT" > "$tmp"
visudo -cqf "$tmp"
pending "file $SUDOERS"
install -o root -g root -m 0440 "$tmp" "$SUDOERS"
rm -f "$tmp"
# The whole configuration must still parse; never leave a drop-in that breaks sudo.
visudo -cq || { rm -f "$SUDOERS"; echo "sudoers no longer parses with $SUDOERS; removed it" >&2; exit 1; }
record_file "$SUDOERS"

# 4. The size-capped tmpfs workspace root, owned by the operator. Mode 0711 lets the evaluator traverse to the per-run
#    directories the harness creates (0700, random names, evaluator ACL) without listing the root; it persists across
#    remounts, unlike an ACL on the tmpfs root.
for dir in "$workspace_parent" "$workspace_root"; do
  if [[ ! -e "$dir" ]]; then pending "dir $dir"; mkdir "$dir"; confirm "dir $dir"; fi
done
pending "file $unit_file"
rm -f "$unit_file"   # never write through a link
cat > "$unit_file" <<EOF
$MARKER
[Unit]
Description=Nexus qualification workspace root (size-capped tmpfs)

[Mount]
What=tmpfs
Where=$workspace_root
Type=tmpfs
Options=size=$storage_bytes,mode=0711,uid=$op_uid,gid=$op_gid,nosuid,nodev

[Install]
WantedBy=local-fs.target
EOF
record_file "$unit_file"
systemctl daemon-reload
systemctl enable "$unit" >/dev/null
# start, never restart: remounting a tmpfs would discard any run in progress.
systemctl start "$unit"
live="$(findmnt -n -b -o FSTYPE,SIZE --mountpoint "$workspace_root" | tr -s " ") $(stat -c '%u %a' "$workspace_root")"
[[ "$live" == "tmpfs $storage_bytes $op_uid 711" ]] || { echo "mounted $workspace_root is '$live', not 'tmpfs $storage_bytes $op_uid 711'; run rollback.sh, then provision again" >&2; exit 1; }

# 5. Root-owned, world-readable home for the installed RC and peer agents (sandboxRuntimeRoots); filled per RC.
if [[ ! -e "$RUNTIME" ]]; then pending "dir $RUNTIME"; install -d -o root -g root -m 0755 "$RUNTIME"; : > "$RUNTIME_MARKER"; confirm "dir $RUNTIME"; fi

printf 'operator=%s\naccount=%s\nunit=%s\nprofile_sha256=%s\nat=%s\n' "$OPERATOR" "$ACCOUNT" "$unit" \
  "$(sha256sum "$PROFILE" | cut -d' ' -f1)" "$(date -u +%FT%TZ)" > "$LEDGER_DIR/state"
echo "provisioned: $ACCOUNT, $SUDOERS, $unit ($storage_bytes bytes), $RUNTIME; ledger $LEDGER"
