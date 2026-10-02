@echo off
rem Run the 7-spot quick-canon build + collection-mileage tally, keeping Windows awake for the
rem duration. Writes saves\7_spot_master_quick.sprout, 7_spot_quick_reductions.csv, and
rem n7_run.log (summary line, or any error) next to this file. Double-click to run.
cd /d "%~dp0"
powershell -NoProfile -Command ^
  "Add-Type -Namespace W -Name P -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint f);';" ^
  "[W.P]::SetThreadExecutionState(0x80000001) | Out-Null;" ^
  "$p = Start-Process -FilePath '.\build\quick_reduction_counts.exe' -ArgumentList '7','7_spot_quick_reductions.csv','--master','saves\7_spot_master_quick.sprout' -RedirectStandardError 'n7_run.log' -NoNewWindow -PassThru;" ^
  "$p.WaitForExit(); [W.P]::SetThreadExecutionState(0x80000000) | Out-Null"
echo.
echo Finished. Summary:
type n7_run.log
pause
