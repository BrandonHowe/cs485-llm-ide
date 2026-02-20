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
)
STARTUP_TIMEOUT_SECONDS="${DEV_STARTUP_TIMEOUT_SECONDS:-900}"

cleanup() {
	if [[ -n "${WATCH_PID}" ]] && kill -0 "${WATCH_PID}" >/dev/null 2>&1; then
		echo ""
		echo "Stopping watcher (${WATCH_PID})..."
		kill "${WATCH_PID}" >/dev/null 2>&1 || true
	fi
}

trap cleanup EXIT INT TERM

wait_for_artifact() {
	local artifact_path="$1"
	local started_at="$2"

	while [[ ! -f "${artifact_path}" ]]; do
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

		sleep 2
	done
}

echo "Starting TypeScript watchers..."
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
