#!/usr/bin/env bash
set -euo pipefail

# Isolate user resources, credentials, temporary files, and tool configuration.
temp_parent="${TMPDIR:-/tmp}"
temp_parent="${temp_parent%/}"
test_root="$(mktemp -d "$temp_parent/allweave-test.XXXXXX")"
git_askpass="$(type -P false)"
readonly temp_parent test_root git_askpass

mkdir -p "$test_root/home/.config" "$test_root/tmp" "$test_root/cache/npm"
# Mark the generated root so cleanup can verify ownership before deleting it.
touch "$test_root/.allweave-test-owned" "$test_root/npm-userconfig" "$test_root/npm-globalconfig"

# Only remove the marked directory created above, never an unverified path.
cleanup() {
	local status=$?
	trap - EXIT

	case "$test_root" in
		"$temp_parent"/allweave-test.*)
			if [[ -d "$test_root" && ! -L "$test_root" && -f "$test_root/.allweave-test-owned" ]]; then
				# Windows browser cache handles can outlive a just-closed test process.
				for attempt in 1 2 3 4 5; do
					if rm -rf -- "$test_root" 2>/dev/null; then break; fi
					sleep 1
				done
				if [[ -e "$test_root" ]]; then
					printf 'Failed to remove test directory: %s\n' "$test_root" >&2
					[[ $status -ne 0 ]] || status=1
				fi
			else
				printf "Refusing to remove unverified test directory: %s\n" "$test_root" >&2
				[[ $status -ne 0 ]] || status=1
			fi
			;;
		*)
			printf "Refusing to remove unexpected test directory: %s\n" "$test_root" >&2
			[[ $status -ne 0 ]] || status=1
			;;
	esac

	exit "$status"
}
trap cleanup EXIT

# Native Node preserves USERPROFILE literally; MSYS-style slashes otherwise
# disagree with paths returned by node:path and break home-prefix comparisons.
native_test_path() {
	if command -v cygpath >/dev/null 2>&1; then
		cygpath -w "$1"
	else
		printf '%s' "$1"
	fi
}

# Resource discovery walks ancestors. A fake HOME under the real user home
# still inherits project skills from that real home; use a neutral TMPDIR.
temp_ancestor="$(native_test_path "$temp_parent")"
temp_ancestor="${temp_ancestor//\\//}"
while [[ "$temp_ancestor" != "." ]]; do
	if [[ -d "$temp_ancestor/.agents/skills" ]]; then
		printf 'Test temporary files inherit resources from %s/.agents/skills. Set TMPDIR to a neutral directory.\n' "$temp_ancestor" >&2
		exit 1
	fi
	next_ancestor="$(dirname "$temp_ancestor")"
	[[ "$next_ancestor" != "$temp_ancestor" ]] || break
	temp_ancestor="$next_ancestor"
done

# Start from an empty environment and allow only required platform and test settings.
test_env=(
	"PATH=$PATH"
	"PWD=$PWD"
	"HOME=$(native_test_path "$test_root/home")"
	"USERPROFILE=$(native_test_path "$test_root/home")"
	"TMPDIR=$(native_test_path "$test_root/tmp")"
	"TMP=$(native_test_path "$test_root/tmp")"
	"TEMP=$(native_test_path "$test_root/tmp")"
	"XDG_CONFIG_HOME=$test_root/home/.config"
	"XDG_CACHE_HOME=$test_root/cache"
	"LANG=C"
	"LC_ALL=C"
	"TZ=UTC"
	"GIT_CONFIG_NOSYSTEM=1"
	"GIT_CONFIG_GLOBAL=/dev/null"
	"GIT_TERMINAL_PROMPT=0"
	"GIT_ASKPASS=$git_askpass"
	"GIT_EDITOR=true"
	"GIT_SEQUENCE_EDITOR=true"
	"NPM_CONFIG_USERCONFIG=$test_root/npm-userconfig"
	"NPM_CONFIG_GLOBALCONFIG=$test_root/npm-globalconfig"
	"NPM_CONFIG_CACHE=$test_root/cache/npm"
	"ALLWEAVE_NO_LOCAL_LLM=1"
	"AWS_EC2_METADATA_DISABLED=true"
)

# Native Windows needs these inherited values to launch child processes.
for name in SystemRoot SYSTEMROOT WINDIR COMSPEC PATHEXT LOCALAPPDATA PROGRAMFILES ProgramFiles 'ProgramFiles(x86)'; do
	value="$(printenv "$name" || true)"
	[[ -z "$value" ]] || test_env+=("$name=$value")
done

# Preserve CI detection only for runner behavior and test reporting.
for name in CI GITHUB_ACTIONS; do
	value="${!name-}"
	[[ -z "$value" ]] || test_env+=("$name=$value")
done

echo "Running tests without API keys in isolated home: $test_root/home"
env -i "${test_env[@]}" npm test
