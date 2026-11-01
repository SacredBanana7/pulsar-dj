# Records raw MIDI from the DDJ-SX via winmm (no browser needed) and can light
# LEDs for a quick output test. Usage:
#   powershell -File midi-capture.ps1 -Seconds 90 -Out capture.txt [-LedTest]
param([int]$Seconds = 60, [string]$Out = "midi-capture.txt", [switch]$LedTest)

Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Collections.Concurrent;
using System.Runtime.InteropServices;
public static class Mm {
  public delegate void MidiInProc(IntPtr h, uint msg, IntPtr inst, IntPtr p1, IntPtr p2);
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]
  public struct MIDIINCAPS { public ushort wMid, wPid; public uint vDriverVersion;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string szPname; public uint dwSupport; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]
  public struct MIDIOUTCAPS { public ushort wMid, wPid; public uint vDriverVersion;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string szPname;
    public ushort wTechnology, wVoices, wNotes, wChannelMask; public uint dwSupport; }
  [DllImport("winmm.dll")] public static extern uint midiInGetNumDevs();
  [DllImport("winmm.dll")] public static extern uint midiOutGetNumDevs();
  [DllImport("winmm.dll", CharSet = CharSet.Auto)] public static extern uint midiInGetDevCaps(UIntPtr id, out MIDIINCAPS caps, uint size);
  [DllImport("winmm.dll", CharSet = CharSet.Auto)] public static extern uint midiOutGetDevCaps(UIntPtr id, out MIDIOUTCAPS caps, uint size);
  [DllImport("winmm.dll")] public static extern uint midiInOpen(out IntPtr h, uint id, MidiInProc cb, IntPtr inst, uint flags);
  [DllImport("winmm.dll")] public static extern uint midiInStart(IntPtr h);
  [DllImport("winmm.dll")] public static extern uint midiInStop(IntPtr h);
  [DllImport("winmm.dll")] public static extern uint midiInClose(IntPtr h);
  [DllImport("winmm.dll")] public static extern uint midiOutOpen(out IntPtr h, uint id, IntPtr cb, IntPtr inst, uint flags);
  [DllImport("winmm.dll")] public static extern uint midiOutShortMsg(IntPtr h, uint msg);
  [DllImport("winmm.dll")] public static extern uint midiOutClose(IntPtr h);
  public static ConcurrentQueue<string> Q = new ConcurrentQueue<string>();
  public static MidiInProc Cb = (h, msg, inst, p1, p2) => {
    if (msg == 0x3C3) { // MIM_DATA
      uint d = (uint)p1.ToInt64();
      Q.Enqueue(String.Format("{0,8} {1:x2} {2:x2} {3:x2}", (uint)p2.ToInt64(), d & 0xFF, (d >> 8) & 0xFF, (d >> 16) & 0xFF));
    }
  };
  public static string InName(uint i) { MIDIINCAPS c; midiInGetDevCaps((UIntPtr)i, out c, (uint)Marshal.SizeOf(typeof(MIDIINCAPS))); return c.szPname; }
  public static string OutName(uint i) { MIDIOUTCAPS c; midiOutGetDevCaps((UIntPtr)i, out c, (uint)Marshal.SizeOf(typeof(MIDIOUTCAPS))); return c.szPname; }
}
"@

$inId = $null; $outId = $null
for ($i = 0; $i -lt [Mm]::midiInGetNumDevs(); $i++) { $n = [Mm]::InName($i); "IN  $i : $n"; if ($n -match 'DDJ') { $inId = $i } }
for ($i = 0; $i -lt [Mm]::midiOutGetNumDevs(); $i++) { $n = [Mm]::OutName($i); "OUT $i : $n"; if ($n -match 'DDJ') { $outId = $i } }
if ($null -eq $inId) { "Kein DDJ-SX MIDI-Eingang gefunden"; exit 1 }

$h = [IntPtr]::Zero
$r = [Mm]::midiInOpen([ref]$h, $inId, [Mm]::Cb, [IntPtr]::Zero, 0x30000)  # CALLBACK_FUNCTION
if ($r -ne 0) { "midiInOpen Fehler $r (Gerät evtl. von anderem Programm belegt)"; exit 1 }
[Mm]::midiInStart($h) | Out-Null

$oh = [IntPtr]::Zero
if ($null -ne $outId -and [Mm]::midiOutOpen([ref]$oh, $outId, [IntPtr]::Zero, [IntPtr]::Zero, 0) -eq 0) {
  # ask the controller to report all knob/fader positions
  [Mm]::midiOutShortMsg($oh, 0x7F089B) | Out-Null
  if ($LedTest) {
    foreach ($ch in 0..1) {
      foreach ($note in 0x0B, 0x0C, 0x58, 0x1A, 0x0D, 0x40, 0x54) { [Mm]::midiOutShortMsg($oh, (0x7F -shl 16) -bor ($note -shl 8) -bor (0x90 + $ch)) | Out-Null }
      foreach ($pad in 0..7) { [Mm]::midiOutShortMsg($oh, (0x7F -shl 16) -bor ($pad -shl 8) -bor (0x97 + $ch)) | Out-Null }
      [Mm]::midiOutShortMsg($oh, (0x24 -shl 16) -bor ($ch -shl 8) -bor 0xBB) | Out-Null   # jog ring
      [Mm]::midiOutShortMsg($oh, (0x60 -shl 16) -bor (0x02 -shl 8) -bor (0xB0 + $ch)) | Out-Null  # VU
    }
  }
}

$lines = New-Object System.Collections.Generic.List[string]
$end = (Get-Date).AddSeconds($Seconds)
while ((Get-Date) -lt $end) {
  $s = $null
  while ([Mm]::Q.TryDequeue([ref]$s)) { $lines.Add($s) }
  Start-Sleep -Milliseconds 50
}
[Mm]::midiInStop($h) | Out-Null
[Mm]::midiInClose($h) | Out-Null
if ($oh -ne [IntPtr]::Zero) { [Mm]::midiOutClose($oh) | Out-Null }
$lines | Set-Content -Encoding utf8 $Out
"$($lines.Count) Nachrichten nach $Out geschrieben"
