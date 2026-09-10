' AutoPost keep-alive — invisible launcher.
' wscript runs this with NO window, and Run(..., 0, False) starts PowerShell with a hidden console from the very
' first instant (window style 0). This avoids the console FLASH you get from "powershell -WindowStyle Hidden",
' which briefly shows a black window each time Task Scheduler starts it.
Option Explicit
Dim sh, ps
Set sh = CreateObject("WScript.Shell")
ps = sh.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\AutoPost\keep-alive.ps1"
sh.Run "powershell.exe -NonInteractive -ExecutionPolicy Bypass -File """ & ps & """", 0, False
