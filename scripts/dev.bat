@echo off
setlocal EnableExtensions EnableDelayedExpansion

title VSCode Dev

pushd %~dp0\..
set "ROOT=%CD%"
set "APP_EXECUTABLE=%ROOT%\.build\electron\Code - OSS.exe"

if "%DEV_STARTUP_TIMEOUT_SECONDS%"=="" (
	set "DEV_STARTUP_TIMEOUT_SECONDS=900"
)

if "%DEV_STARTUP_PROGRESS_INTERVAL_SECONDS%"=="" (
	set "DEV_STARTUP_PROGRESS_INTERVAL_SECONDS=15"
)

set "REQUIRED_BUILD_ARTIFACTS=out\main.js;extensions\github-authentication\out\extension.js;extensions\emmet\out\node\emmetNodeMain.js;extensions\git-base\out\extension.js;extensions\merge-conflict\out\mergeConflictMain.js"

where npm >nul 2>&1
if errorlevel 1 (
	echo npm is required but was not found in PATH.
	popd
	exit /b 1
)

if "%VSCODE_DEV_BAT_DRY_RUN%"=="1" (
	rem This escape hatch gives us a cheap syntax/parse check without starting long-lived tools.
	echo dev.bat dry run succeeded.
	popd
	exit /b 0
)

call :bootstrapIfNeeded
if errorlevel 1 (
	popd
	exit /b 1
)

rem Once the one-time bootstrap has succeeded, keep `code.bat` from repeating that expensive
rem work while this helper is already managing the watch-driven rebuild loop.
set "VSCODE_SKIP_PRELAUNCH=1"

echo Starting TypeScript watchers in a separate window...
for /f %%I in ('powershell -NoProfile -Command "$p = Start-Process -FilePath $env:ComSpec -WorkingDirectory ''%ROOT:''=''%'' -ArgumentList ''/c'',''title VSCode Watch & npm run watch'' -PassThru; $p.Id"') do (
	set "WATCH_PID=%%I"
)

if not defined WATCH_PID (
	echo Failed to start npm run watch.
	popd
	exit /b 1
)

echo Waiting for initial build artifacts...
call :getUnixTime STARTED_AT
for %%A in ("%REQUIRED_BUILD_ARTIFACTS:;=" "%") do (
	call :waitForArtifact "%%~A" !STARTED_AT!
	if errorlevel 1 (
		popd
		exit /b 1
	)
)

echo Initial build artifacts are ready.
echo Launching dev app...
echo The watcher is running in its own window. Close that window when you are done developing.
call "%ROOT%\scripts\code.bat" %*
set "EXIT_CODE=%ERRORLEVEL%"

popd
exit /b %EXIT_CODE%

:bootstrapIfNeeded
call :artifactsPresent BOOTSTRAP_READY
if "%BOOTSTRAP_READY%"=="1" (
	rem Reuse an already-bootstrapped workspace so repeated launches stay fast.
	exit /b 0
)

echo Bootstrapping Electron and the initial compile...
node build\lib\preLaunch.ts
if errorlevel 1 (
	echo Prelaunch bootstrap failed.
	exit /b 1
)

call :artifactsPresent BOOTSTRAP_READY
if "%BOOTSTRAP_READY%"=="1" (
	exit /b 0
)

echo Prelaunch completed, but required build artifacts are still missing.
exit /b 1

:artifactsPresent
set "%~1=1"

if not exist "%APP_EXECUTABLE%" (
	set "%~1=0"
	exit /b 0
)

for %%A in ("%REQUIRED_BUILD_ARTIFACTS:;=" "%") do (
	if not exist "%ROOT%\%%~A" (
		set "%~1=0"
		exit /b 0
	)
)

exit /b 0

:waitForArtifact
set "ARTIFACT_REL=%~1"
set "LAST_PROGRESS_REPORT_AT=%~2"

:waitLoop
call :artifactExists "%ARTIFACT_REL%"
if not errorlevel 1 (
	exit /b 0
)

call :watchProcessIsRunning WATCH_RUNNING
if not "!WATCH_RUNNING!"=="1" (
	echo Watch process exited before required build artifacts were ready.
	echo Review watcher errors in the watch window, then retry.
	exit /b 1
)

call :getUnixTime NOW
set /a ELAPSED=NOW-%~2
if !ELAPSED! GEQ %DEV_STARTUP_TIMEOUT_SECONDS% (
	echo Timed out after %DEV_STARTUP_TIMEOUT_SECONDS%s waiting for %ARTIFACT_REL%.
	echo Try running: npm run watch
	exit /b 1
)

set /a SINCE_PROGRESS=NOW-LAST_PROGRESS_REPORT_AT
if !SINCE_PROGRESS! GEQ %DEV_STARTUP_PROGRESS_INTERVAL_SECONDS% (
	call :printPendingArtifacts %~2
	set "LAST_PROGRESS_REPORT_AT=!NOW!"
)

timeout /t 2 /nobreak >nul
goto waitLoop

:printPendingArtifacts
set "PENDING="
for %%A in ("%REQUIRED_BUILD_ARTIFACTS:;=" "%") do (
	call :artifactIsReady "%%~A" %~1
	if errorlevel 1 (
		if defined PENDING (
			set "PENDING=!PENDING! %%~A"
		) else (
			set "PENDING=%%~A"
		)
	)
)

if defined PENDING (
	rem Surfacing the specific missing files makes the first watch build feel alive instead of hung.
	echo Still building. Waiting on: !PENDING!
)

exit /b 0

:artifactExists
if exist "%ROOT%\%~1" (
	exit /b 0
)

exit /b 1

:watchProcessIsRunning
set "%~1=0"
for /f %%I in ('powershell -NoProfile -Command "if (Get-Process -Id %WATCH_PID% -ErrorAction SilentlyContinue) { 1 } else { 0 }"') do (
	set "%~1=%%I"
)
exit /b 0

:getUnixTime
for /f %%I in ('powershell -NoProfile -Command "[DateTimeOffset]::UtcNow.ToUnixTimeSeconds()"') do (
	set "%~1=%%I"
)
exit /b 0
