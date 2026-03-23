@echo off

rem Keep the Windows launchers aligned with code.sh so repo-local OAuth credentials
rem flow into child processes without requiring each shell session to set them manually.
set "ROOT=%~1"
if "%ROOT%"=="" (
	exit /b 1
)

for %%F in ("%ROOT%\.env.vsclone" "%ROOT%\.env.local" "%ROOT%\.env") do (
	if exist "%%~fF" (
		call :loadEnvFile "%%~fF"
	)
)

exit /b 0

:loadEnvFile
rem Parse simple KEY=VALUE env files while ignoring blank lines and comment lines.
for /f "usebackq eol=# tokens=1,* delims==" %%A in ("%~1") do (
	if not "%%~A"=="" (
		set "%%~A=%%B"
	)
)
exit /b 0
