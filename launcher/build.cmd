@echo off
rem Builds "Pulsar DJ.exe" next to the app folder with the .NET Framework compiler that ships with Windows.
cd /d "%~dp0"
"%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /nologo /target:winexe /optimize+ /win32icon:pulsar.ico /out:"..\Pulsar DJ.exe" /r:System.Windows.Forms.dll PulsarLauncher.cs
