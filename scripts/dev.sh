#!/usr/bin/env bash

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if ! command -v npm >/dev/null 2>&1; then
	echo "npm is required but was not found in PATH."
	exit 1
fi

WATCH_PID=""
MAIN_ENTRYPOINT="$ROOT/out/main.js"
REQUIRED_BUILD_ARTIFACTS=(
	"$MAIN_ENTRYPOINT"
	"$ROOT/extensions/github-authentication/out/extension.js"
	"$ROOT/extensions/emmet/out/node/emmetNodeMain.js"
	"$ROOT/extensions/git-base/out/extension.js"
	"$ROOT/extensions/merge-conflict/out/mergeConflictMain.js"
	# The workbench controllers import generated Preact entrypoints from `out/`, so startup must
	# wait for the currently mounted VSClone surfaces instead of any stale bundles left by older
	# ports. The thread rail replaced the old chat history rail, so the launcher has to watch the
	# new emitted module or it can wait forever on an artifact that the build no longer refreshes.
	"$ROOT/out/vs/workbench/contrib/vsclone/browser/preact/out/thread-rail/index.js"
	"$ROOT/out/vs/workbench/contrib/vsclone/browser/preact/out/model-switcher/index.js"
	"$ROOT/out/vs/workbench/contrib/vsclone/browser/preact/out/unified-conversation-surface/index.js"
)
STARTUP_TIMEOUT_SECONDS="${DEV_STARTUP_TIMEOUT_SECONDS:-900}"
STARTUP_PROGRESS_INTERVAL_SECONDS="${DEV_STARTUP_PROGRESS_INTERVAL_SECONDS:-15}"

cleanup() {
	if [[ -n "${WATCH_PID}" ]] && kill -0 "${WATCH_PID}" >/dev/null 2>&1; then
		echo ""
		echo "Stopping watcher (${WATCH_PID})..."
		kill "${WATCH_PID}" >/dev/null 2>&1 || true
	fi

}

trap cleanup EXIT INT TERM

print_pending_artifacts() {
	local pending=()

	# The first watch build is often quiet for a while, so we surface the specific
	# files still missing to make it obvious that startup is progressing rather than hung.
	for artifact in "${REQUIRED_BUILD_ARTIFACTS[@]}"; do
		if [[ ! -f "${artifact}" ]]; then
			pending+=("${artifact#"$ROOT"/}")
		fi
	done

	if (( ${#pending[@]} > 0 )); then
		printf 'Still building. Waiting on: %s\n' "${pending[*]}"
	fi
}

artifact_mtime_seconds() {
	local artifact_path="$1"

	if [[ "$OSTYPE" == "darwin"* ]]; then
		stat -f '%m' "${artifact_path}"
	else
		stat -c '%Y' "${artifact_path}"
	fi
}

artifact_is_ready() {
	local artifact_path="$1"
	local started_at="$2"

	if [[ ! -f "${artifact_path}" ]]; then
		return 1
	fi

	# `npm run watch` cleans previous outputs before rebuilding them. Requiring a
	# fresh mtime prevents the launcher from racing ahead on stale artifacts from an
	# older watch session and makes startup reflect the current source tree.
	local artifact_mtime
	artifact_mtime="$(artifact_mtime_seconds "${artifact_path}")"
	(( artifact_mtime >= started_at ))
}

wait_for_artifact() {
	local artifact_path="$1"
	local started_at="$2"
	local last_progress_report_at="$started_at"

	while ! artifact_is_ready "${artifact_path}" "${started_at}"; do
		if ! kill -0 "${WATCH_PID}" >/dev/null 2>&1; then
			echo "Watch process exited before required build artifacts were ready."
			echo "Review watcher errors above, then retry."
			exit 1
		fi

		local now elapsed
		now="$(date +%s)"
		elapsed="$((now - started_at))"
		if (( elapsed >= STARTUP_TIMEOUT_SECONDS )); then
			echo "Timed out after ${STARTUP_TIMEOUT_SECONDS}s waiting for ${artifact_path}."
			echo "Try running: npm run watch"
			exit 1
		fi

		if (( now - last_progress_report_at >= STARTUP_PROGRESS_INTERVAL_SECONDS )); then
			print_pending_artifacts
			last_progress_report_at="$now"
		fi

		sleep 2
	done
}

# `npm run watch` now includes the VSClone Preact bundle watcher, so the launcher only needs one
# long-lived process and can treat its emitted artifacts as part of the normal boot contract.
echo "Starting watchers..."
npm run watch &
WATCH_PID=$!

if [[ -z "${VSCODE_SKIP_PRELAUNCH+x}" ]]; then
	# Standard local workflow: keep watch running and skip duplicate prelaunch compile.
	export VSCODE_SKIP_PRELAUNCH=1
fi

echo "Waiting for initial build artifacts..."
STARTED_AT="$(date +%s)"
for artifact in "${REQUIRED_BUILD_ARTIFACTS[@]}"; do
	wait_for_artifact "${artifact}" "${STARTED_AT}"
done
echo "Initial build artifacts are ready."

echo "Launching dev app..."
"$ROOT/scripts/code.sh" "$@"
