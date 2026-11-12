// Sound mixer + Bluetooth for the Sound widget.
//
// Windows: one long-lived PowerShell worker (like tasks.js) with Core Audio
// through COM - output devices, the default one, master volume and mute,
// and every app's audio session (volume, mute) - plus Bluetooth through the
// classic Bluetooth API (paired devices, connected or not; connect and
// disconnect by turning the device's audio services on and off, as Windows
// Settings does) and WinRT for the radio switch.
// Linux: pactl (PulseAudio / PipeWire-pulse) and bluetoothctl.
const { spawn, execFile } = require('child_process');

const AUDIO_CS = `
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

namespace AeroSound {
  public enum EDataFlow { eRender, eCapture, eAll }
  public enum ERole { eConsole, eMultimedia, eCommunications }

  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] public class MMDeviceEnumeratorCo {}
  [ComImport, Guid("870af99c-171d-4f9e-af0d-e63df40c2bc9")] public class PolicyConfigCo {}

  [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IMMDeviceEnumerator {
    [PreserveSig] int EnumAudioEndpoints(EDataFlow dataFlow, int stateMask, out IMMDeviceCollection devices);
    [PreserveSig] int GetDefaultAudioEndpoint(EDataFlow dataFlow, ERole role, out IMMDevice device);
    [PreserveSig] int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice device);
  }
  [Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IMMDeviceCollection {
    [PreserveSig] int GetCount(out int count);
    [PreserveSig] int Item(int index, out IMMDevice device);
  }
  [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IMMDevice {
    [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
    [PreserveSig] int OpenPropertyStore(int access, out IPropertyStore store);
    [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
    [PreserveSig] int GetState(out int state);
  }
  [Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IPropertyStore {
    [PreserveSig] int GetCount(out int count);
    [PreserveSig] int GetAt(int index, out PROPERTYKEY key);
    [PreserveSig] int GetValue(ref PROPERTYKEY key, out PROPVARIANT value);
  }
  [StructLayout(LayoutKind.Sequential)] public struct PROPERTYKEY { public Guid fmtid; public int pid; }
  [StructLayout(LayoutKind.Explicit, Size = 24)] public struct PROPVARIANT { [FieldOffset(0)] public short vt; [FieldOffset(8)] public IntPtr ptr; }

  [Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IAudioEndpointVolume {
    [PreserveSig] int RegisterControlChangeNotify(IntPtr notify);
    [PreserveSig] int UnregisterControlChangeNotify(IntPtr notify);
    [PreserveSig] int GetChannelCount(out uint count);
    [PreserveSig] int SetMasterVolumeLevel(float level, ref Guid ctx);
    [PreserveSig] int SetMasterVolumeLevelScalar(float level, ref Guid ctx);
    [PreserveSig] int GetMasterVolumeLevel(out float level);
    [PreserveSig] int GetMasterVolumeLevelScalar(out float level);
    [PreserveSig] int SetChannelVolumeLevel(uint ch, float level, ref Guid ctx);
    [PreserveSig] int SetChannelVolumeLevelScalar(uint ch, float level, ref Guid ctx);
    [PreserveSig] int GetChannelVolumeLevel(uint ch, out float level);
    [PreserveSig] int GetChannelVolumeLevelScalar(uint ch, out float level);
    [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid ctx);
    [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
  }
  [Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IAudioSessionManager2 {
    [PreserveSig] int GetAudioSessionControl(IntPtr guid, int flags, out IntPtr control);
    [PreserveSig] int GetSimpleAudioVolume(IntPtr guid, int flags, out IntPtr volume);
    [PreserveSig] int GetSessionEnumerator(out IAudioSessionEnumerator sessions);
  }
  [Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IAudioSessionEnumerator {
    [PreserveSig] int GetCount(out int count);
    [PreserveSig] int GetSession(int index, out IAudioSessionControl2 session);
  }
  [Guid("bfb7ff88-7239-4fc9-8fa2-07c950be9c6d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IAudioSessionControl2 {
    [PreserveSig] int GetState(out int state);
    [PreserveSig] int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string name);
    [PreserveSig] int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string name, ref Guid ctx);
    [PreserveSig] int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string path);
    [PreserveSig] int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string path, ref Guid ctx);
    [PreserveSig] int GetGroupingParam(out Guid param);
    [PreserveSig] int SetGroupingParam(ref Guid param, ref Guid ctx);
    [PreserveSig] int RegisterAudioSessionNotification(IntPtr n);
    [PreserveSig] int UnregisterAudioSessionNotification(IntPtr n);
    [PreserveSig] int GetSessionIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id);
    [PreserveSig] int GetSessionInstanceIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id);
    [PreserveSig] int GetProcessId(out uint pid);
    [PreserveSig] int IsSystemSoundsSession();
  }
  [Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface ISimpleAudioVolume {
    [PreserveSig] int SetMasterVolume(float level, ref Guid ctx);
    [PreserveSig] int GetMasterVolume(out float level);
    [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid ctx);
    [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
  }
  [Guid("f8679f50-850a-41cf-9c72-430f290290c8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IPolicyConfig {
    [PreserveSig] int GetMixFormat(IntPtr a, IntPtr b);
    [PreserveSig] int GetDeviceFormat(IntPtr a, int b, IntPtr c);
    [PreserveSig] int ResetDeviceFormat(IntPtr a);
    [PreserveSig] int SetDeviceFormat(IntPtr a, IntPtr b, IntPtr c);
    [PreserveSig] int GetProcessingPeriod(IntPtr a, int b, IntPtr c, IntPtr d);
    [PreserveSig] int SetProcessingPeriod(IntPtr a, IntPtr b);
    [PreserveSig] int GetShareMode(IntPtr a, IntPtr b);
    [PreserveSig] int SetShareMode(IntPtr a, IntPtr b);
    [PreserveSig] int GetPropertyValue(IntPtr a, IntPtr b, IntPtr c);
    [PreserveSig] int SetPropertyValue(IntPtr a, IntPtr b, IntPtr c);
    [PreserveSig] int SetDefaultEndpoint([MarshalAs(UnmanagedType.LPWStr)] string id, ERole role);
  }

  // Classic Bluetooth API
  [StructLayout(LayoutKind.Sequential)] public struct SYSTEMTIME { public ushort y, mo, dow, d, h, mi, s, ms; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct BT_DEVICE_INFO {
    public uint dwSize; public ulong Address; public uint ulClassofDevice;
    public int fConnected; public int fRemembered; public int fAuthenticated;
    public SYSTEMTIME stLastSeen; public SYSTEMTIME stLastUsed;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 248)] public string szName;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct BT_SEARCH_PARAMS {
    public uint dwSize; public int fReturnAuthenticated; public int fReturnRemembered; public int fReturnUnknown;
    public int fReturnConnected; public int fIssueInquiry; public byte cTimeoutMultiplier; public IntPtr hRadio;
  }
  [StructLayout(LayoutKind.Sequential)] public struct BT_RADIO_PARAMS { public uint dwSize; }

  public static class Native {
    [DllImport("ole32.dll")] public static extern int PropVariantClear(ref PROPVARIANT pv);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern bool QueryFullProcessImageName(IntPtr h, uint flags, StringBuilder name, ref uint size);
    [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
    [DllImport("BluetoothAPIs.dll", SetLastError = true)] public static extern IntPtr BluetoothFindFirstRadio(ref BT_RADIO_PARAMS p, out IntPtr radio);
    [DllImport("BluetoothAPIs.dll", SetLastError = true)] public static extern bool BluetoothFindRadioClose(IntPtr find);
    [DllImport("BluetoothAPIs.dll", SetLastError = true)] public static extern IntPtr BluetoothFindFirstDevice(ref BT_SEARCH_PARAMS p, ref BT_DEVICE_INFO info);
    [DllImport("BluetoothAPIs.dll", SetLastError = true)] public static extern bool BluetoothFindNextDevice(IntPtr find, ref BT_DEVICE_INFO info);
    [DllImport("BluetoothAPIs.dll", SetLastError = true)] public static extern bool BluetoothFindDeviceClose(IntPtr find);
    [DllImport("BluetoothAPIs.dll", SetLastError = true)] public static extern uint BluetoothGetDeviceInfo(IntPtr radio, ref BT_DEVICE_INFO info);
    [DllImport("BluetoothAPIs.dll", SetLastError = true)] public static extern uint BluetoothSetServiceState(IntPtr radio, ref BT_DEVICE_INFO info, ref Guid service, uint flags);
  }

  public static class Mixer {
    static Guid IID_EndpointVolume = new Guid("5CDF2C82-841E-4546-9722-0CF74078229A");
    static Guid IID_SessionManager2 = new Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F");
    static Guid NoCtx = Guid.Empty;
    static PROPERTYKEY FriendlyName = new PROPERTYKEY { fmtid = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"), pid = 14 };

    static IMMDeviceEnumerator Enum() { return (IMMDeviceEnumerator)new MMDeviceEnumeratorCo(); }

    static string Esc(string s) {
      if (s == null) return "";
      var b = new StringBuilder();
      foreach (char c in s) {
        if (c == '"' || c == '\\\\') { b.Append('\\\\'); b.Append(c); }
        else if (c < 32) b.AppendFormat("\\\\u{0:x4}", (int)c);
        else b.Append(c);
      }
      return b.ToString();
    }

    static string Name(IMMDevice d) {
      IPropertyStore ps;
      if (d.OpenPropertyStore(0, out ps) != 0 || ps == null) return "";
      PROPVARIANT v;
      var k = FriendlyName;
      if (ps.GetValue(ref k, out v) != 0) return "";
      string s = v.ptr != IntPtr.Zero ? Marshal.PtrToStringUni(v.ptr) : "";
      Native.PropVariantClear(ref v);
      return s;
    }

    static IMMDevice Default() {
      IMMDevice d;
      return Enum().GetDefaultAudioEndpoint(EDataFlow.eRender, ERole.eMultimedia, out d) == 0 ? d : null;
    }

    static IAudioEndpointVolume EndpointVolume(IMMDevice d) {
      object o; var iid = IID_EndpointVolume;
      return d != null && d.Activate(ref iid, 23, IntPtr.Zero, out o) == 0 ? (IAudioEndpointVolume)o : null;
    }

    static string ExeOf(uint pid) {
      IntPtr h = Native.OpenProcess(0x1000, false, pid);
      if (h == IntPtr.Zero) return "";
      try { var sb = new StringBuilder(1024); uint n = 1024; return Native.QueryFullProcessImageName(h, 0, sb, ref n) ? sb.ToString() : ""; }
      finally { Native.CloseHandle(h); }
    }

    static string AppName(uint pid, string exe, string display) {
      if (!string.IsNullOrEmpty(display) && !display.StartsWith("@")) return display;
      if (!string.IsNullOrEmpty(exe)) {
        try { var fv = FileVersionInfo.GetVersionInfo(exe); if (!string.IsNullOrEmpty(fv.FileDescription)) return fv.FileDescription; } catch {}
        return System.IO.Path.GetFileNameWithoutExtension(exe);
      }
      try { return Process.GetProcessById((int)pid).ProcessName; } catch { return "App " + pid; }
    }

    static List<KeyValuePair<string, IAudioSessionControl2>> Sessions() {
      var list = new List<KeyValuePair<string, IAudioSessionControl2>>();
      var d = Default();
      if (d == null) return list;
      object o; var iid = IID_SessionManager2;
      if (d.Activate(ref iid, 23, IntPtr.Zero, out o) != 0) return list;
      IAudioSessionEnumerator e;
      if (((IAudioSessionManager2)o).GetSessionEnumerator(out e) != 0) return list;
      int n; e.GetCount(out n);
      for (int i = 0; i < n; i++) {
        IAudioSessionControl2 s;
        if (e.GetSession(i, out s) != 0 || s == null) continue;
        string id; s.GetSessionInstanceIdentifier(out id);
        list.Add(new KeyValuePair<string, IAudioSessionControl2>(id ?? ("s" + i), s));
      }
      return list;
    }

    public static string State() {
      var sb = new StringBuilder("{\\"devices\\":[");
      var def = Default();
      string defId = ""; if (def != null) def.GetId(out defId);
      IMMDeviceCollection col;
      if (Enum().EnumAudioEndpoints(EDataFlow.eRender, 1, out col) == 0) {
        int n; col.GetCount(out n);
        for (int i = 0; i < n; i++) {
          IMMDevice d; if (col.Item(i, out d) != 0) continue;
          string id; d.GetId(out id);
          if (i > 0) sb.Append(",");
          sb.AppendFormat("{{\\"id\\":\\"{0}\\",\\"name\\":\\"{1}\\",\\"default\\":{2}}}", Esc(id), Esc(Name(d)), id == defId ? "true" : "false");
        }
      }
      sb.Append("],\\"master\\":");
      var ev = EndpointVolume(def);
      if (ev != null) { float v; bool m; ev.GetMasterVolumeLevelScalar(out v); ev.GetMute(out m); sb.AppendFormat(System.Globalization.CultureInfo.InvariantCulture, "{{\\"volume\\":{0:0.###},\\"mute\\":{1}}}", v, m ? "true" : "false"); }
      else sb.Append("null");
      sb.Append(",\\"sessions\\":[");
      bool first = true;
      foreach (var kv in Sessions()) {
        var s = kv.Value;
        int st; s.GetState(out st);
        if (st == 2) continue;                       // expired
        uint pid; s.GetProcessId(out pid);
        bool sys = s.IsSystemSoundsSession() == 0;
        string disp; s.GetDisplayName(out disp);
        string exe = sys ? "" : ExeOf(pid);
        var vol = (ISimpleAudioVolume)s;
        float v; bool m; vol.GetMasterVolume(out v); vol.GetMute(out m);
        if (!first) sb.Append(",");
        first = false;
        sb.AppendFormat(System.Globalization.CultureInfo.InvariantCulture,
          "{{\\"id\\":\\"{0}\\",\\"pid\\":{1},\\"name\\":\\"{2}\\",\\"exe\\":\\"{3}\\",\\"system\\":{4},\\"active\\":{5},\\"volume\\":{6:0.###},\\"mute\\":{7}}}",
          Esc(Convert.ToBase64String(Encoding.UTF8.GetBytes(kv.Key))), pid, Esc(sys ? "System sounds" : AppName(pid, exe, disp)), Esc(exe),
          sys ? "true" : "false", st == 1 ? "true" : "false", v, m ? "true" : "false");
      }
      sb.Append("]}");
      return sb.ToString();
    }

    public static bool SetMaster(float v) { var ev = EndpointVolume(Default()); return ev != null && ev.SetMasterVolumeLevelScalar(Math.Max(0f, Math.Min(1f, v)), ref NoCtx) == 0; }
    public static bool MuteMaster(bool m) { var ev = EndpointVolume(Default()); return ev != null && ev.SetMute(m, ref NoCtx) == 0; }

    static ISimpleAudioVolume Session(string id64) {
      string id = Encoding.UTF8.GetString(Convert.FromBase64String(id64));
      foreach (var kv in Sessions()) if (kv.Key == id) return (ISimpleAudioVolume)kv.Value;
      return null;
    }
    public static bool SetSession(string id64, float v) { var s = Session(id64); return s != null && s.SetMasterVolume(Math.Max(0f, Math.Min(1f, v)), ref NoCtx) == 0; }
    public static bool MuteSession(string id64, bool m) { var s = Session(id64); return s != null && s.SetMute(m, ref NoCtx) == 0; }

    public static bool SetDefault(string id64) {
      string id = Encoding.UTF8.GetString(Convert.FromBase64String(id64));
      var pc = (IPolicyConfig)new PolicyConfigCo();
      bool ok = pc.SetDefaultEndpoint(id, ERole.eConsole) == 0;
      ok &= pc.SetDefaultEndpoint(id, ERole.eMultimedia) == 0;
      pc.SetDefaultEndpoint(id, ERole.eCommunications);
      return ok;
    }
  }

  public static class Bt {
    // Audio services a headset / speaker offers: A2DP sink, AVRCP, hands-free, headset.
    static readonly Guid[] AudioServices = {
      new Guid("0000110b-0000-1000-8000-00805f9b34fb"), new Guid("0000110e-0000-1000-8000-00805f9b34fb"),
      new Guid("0000111e-0000-1000-8000-00805f9b34fb"), new Guid("00001108-0000-1000-8000-00805f9b34fb")
    };

    static IntPtr Radio() {
      var p = new BT_RADIO_PARAMS { dwSize = (uint)Marshal.SizeOf(typeof(BT_RADIO_PARAMS)) };
      IntPtr radio;
      IntPtr find = Native.BluetoothFindFirstRadio(ref p, out radio);
      if (find == IntPtr.Zero) return IntPtr.Zero;
      Native.BluetoothFindRadioClose(find);
      return radio;
    }

    static string Esc(string s) { return (s ?? "").Replace("\\\\", "\\\\\\\\").Replace("\\"", "\\\\\\""); }

    public static string Devices() {
      var sb = new StringBuilder("[");
      var p = new BT_SEARCH_PARAMS { dwSize = (uint)Marshal.SizeOf(typeof(BT_SEARCH_PARAMS)), fReturnAuthenticated = 1, fReturnRemembered = 1, fReturnConnected = 1, fReturnUnknown = 0, fIssueInquiry = 0, hRadio = IntPtr.Zero };
      var info = new BT_DEVICE_INFO { dwSize = (uint)Marshal.SizeOf(typeof(BT_DEVICE_INFO)) };
      IntPtr find = Native.BluetoothFindFirstDevice(ref p, ref info);
      bool first = true;
      if (find != IntPtr.Zero) {
        do {
          if (info.fRemembered != 0 || info.fAuthenticated != 0) {
            if (!first) sb.Append(",");
            first = false;
            uint major = (info.ulClassofDevice >> 8) & 0x1F;
            sb.AppendFormat("{{\\"address\\":\\"{0:X12}\\",\\"name\\":\\"{1}\\",\\"connected\\":{2},\\"audio\\":{3},\\"kind\\":{4}}}",
              info.Address, Esc(info.szName), info.fConnected != 0 ? "true" : "false", major == 4 ? "true" : "false", major);
          }
          info = new BT_DEVICE_INFO { dwSize = (uint)Marshal.SizeOf(typeof(BT_DEVICE_INFO)) };
        } while (Native.BluetoothFindNextDevice(find, ref info));
        Native.BluetoothFindDeviceClose(find);
      }
      sb.Append("]");
      return sb.ToString();
    }

    // Connect / disconnect an audio device: its audio services on / off.
    public static string SetConnected(string hex, bool on) {
      IntPtr radio = Radio();
      if (radio == IntPtr.Zero) return "no-radio";
      var info = new BT_DEVICE_INFO { dwSize = (uint)Marshal.SizeOf(typeof(BT_DEVICE_INFO)), Address = Convert.ToUInt64(hex, 16) };
      if (Native.BluetoothGetDeviceInfo(radio, ref info) != 0) { Native.CloseHandle(radio); return "unknown-device"; }
      int ok = 0;
      foreach (var g in AudioServices) { var s = g; if (Native.BluetoothSetServiceState(radio, ref info, ref s, on ? 1u : 0u) == 0) ok++; }
      Native.CloseHandle(radio);
      return ok > 0 ? "ok" : "failed";
    }
  }
}
`;

const WORKER = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -TypeDefinition @'
${AUDIO_CS}
'@
$ErrorActionPreference = 'Continue'
$script:winrt = $false
function Init-WinRT {
  if ($script:winrt) { return }
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.Devices.Radios.Radio, Windows.System.Devices, ContentType = WindowsRuntime]
  $script:asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
  $script:winrt = $true
}
function Await($op, [Type]$t) { $task = $script:asTask.MakeGenericMethod($t).Invoke($null, @($op)); $null = $task.Wait(8000); $task.Result }
function Bt-Radio {
  Init-WinRT
  $radios = Await ([Windows.Devices.Radios.Radio]::GetRadiosAsync()) ([System.Collections.Generic.IReadOnlyList[Windows.Devices.Radios.Radio]])
  foreach ($r in $radios) { if ($r.Kind -eq 'Bluetooth') { return $r } }
  return $null
}
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $p = $line.Trim() -split ' ', 3
  try {
    switch ($p[0]) {
      'state'      { [Console]::Out.WriteLine([AeroSound.Mixer]::State()) }
      'master'     { [Console]::Out.WriteLine([AeroSound.Mixer]::SetMaster([float]::Parse($p[1], [Globalization.CultureInfo]::InvariantCulture))) }
      'mastermute' { [Console]::Out.WriteLine([AeroSound.Mixer]::MuteMaster($p[1] -eq '1')) }
      'session'    { [Console]::Out.WriteLine([AeroSound.Mixer]::SetSession($p[1], [float]::Parse($p[2], [Globalization.CultureInfo]::InvariantCulture))) }
      'sessionmute'{ [Console]::Out.WriteLine([AeroSound.Mixer]::MuteSession($p[1], $p[2] -eq '1')) }
      'default'    { [Console]::Out.WriteLine([AeroSound.Mixer]::SetDefault($p[1])) }
      'bt' {
        $r = $null; try { $r = Bt-Radio } catch {}
        $radio = if ($r) { '"' + $r.State + '"' } else { 'null' }
        [Console]::Out.WriteLine('{"radio":' + $radio + ',"devices":' + [AeroSound.Bt]::Devices() + '}')
      }
      'btconnect'  { [Console]::Out.WriteLine([AeroSound.Bt]::SetConnected($p[1], $p[2] -eq '1')) }
      'btpower' {
        $r = Bt-Radio
        if (-not $r) { [Console]::Out.WriteLine('no-radio') } else {
          $null = Await ([Windows.Devices.Radios.Radio]::RequestAccessAsync()) ([Windows.Devices.Radios.RadioAccessStatus])
          $res = Await ($r.SetStateAsync($(if ($p[1] -eq '1') { 'On' } else { 'Off' }))) ([Windows.Devices.Radios.RadioAccessStatus])
          [Console]::Out.WriteLine("$res")
        }
      }
      default { [Console]::Out.WriteLine('err') }
    }
  } catch { [Console]::Out.WriteLine('err ' + ($_.Exception.Message -replace '[\\r\\n]+', ' ')) }
}
`;

class WinSound {
  constructor() { this.ps = null; this.queue = Promise.resolve(); this.waiters = []; this.buf = ''; }

  ensure() {
    if (this.ps) return;
    // The helper is big (Core Audio interop): run it from a file, so stdin
    // stays free for commands and the command line stays short.
    const fs = require('fs');
    const file = require('path').join(require('os').tmpdir(), `be-aero-sound-${require('crypto').createHash('sha1').update(WORKER).digest('hex').slice(0, 10)}.ps1`);
    try { if (!fs.existsSync(file)) fs.writeFileSync(file, `﻿${WORKER}`, 'utf8'); } catch { /* tmp not writable: spawn fails below */ }
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.ps = ps;
    ps.stdout.setEncoding('utf8');
    ps.stdout.on('data', (d) => {
      this.buf += d;
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).replace(/\r$/, '');
        this.buf = this.buf.slice(i + 1);
        const w = this.waiters.shift();
        if (w) w(line);
      }
    });
    ps.stderr.on('data', (d) => { this.stderr = ((this.stderr || '') + d).slice(-4000); });
    ps.on('exit', () => { this.ps = null; for (const w of this.waiters.splice(0)) w(null); });
  }

  send(cmd, timeout = 15000) {
    const run = () => new Promise((resolve) => {
      this.ensure();
      const t = setTimeout(() => { const i = this.waiters.indexOf(w); if (i >= 0) this.waiters.splice(i, 1); resolve(null); }, timeout);
      const w = (line) => { clearTimeout(t); resolve(line); };
      this.waiters.push(w);
      try { this.ps.stdin.write(`${cmd}\n`); } catch { resolve(null); }
    });
    const next = this.queue.then(run, run);
    this.queue = next.then(() => {}, () => {});
    return next;
  }

  async json(cmd, timeout) {
    const line = await this.send(cmd, timeout);
    if (!line || /^err/.test(line)) throw new Error(line ? line.replace(/^err ?/, '') || 'failed' : 'the sound helper did not answer');
    return JSON.parse(line);
  }

  async state() { return this.json('state', 30000); }       // first call compiles the helper
  async setMaster(v) { return (await this.send(`master ${Number(v).toFixed(3)}`)) === 'True'; }
  async muteMaster(m) { return (await this.send(`mastermute ${m ? 1 : 0}`)) === 'True'; }
  async setApp(id, v) { return (await this.send(`session ${id} ${Number(v).toFixed(3)}`)) === 'True'; }
  async muteApp(id, m) { return (await this.send(`sessionmute ${id} ${m ? 1 : 0}`)) === 'True'; }
  async setDefault(id) { return (await this.send(`default ${Buffer.from(String(id)).toString('base64')}`)) === 'True'; }
  async bluetooth() {
    const r = await this.json('bt', 20000);
    return { radio: r.radio === null ? null : r.radio === 'On', devices: (r.devices || []).map((d) => ({ id: d.address, name: d.name || d.address, connected: !!d.connected, audio: !!d.audio })) };
  }
  async btConnect(id, on) {
    if (!/^[0-9A-F]{12}$/i.test(String(id))) throw new Error('bad device');
    const r = await this.send(`btconnect ${id} ${on ? 1 : 0}`, 30000);
    if (r !== 'ok') throw new Error(r === 'no-radio' ? 'Bluetooth is off' : 'Windows could not change this device - try Bluetooth settings');
    return true;
  }
  async btPower(on) {
    const r = await this.send(`btpower ${on ? 1 : 0}`, 20000);
    if (r !== 'Allowed') throw new Error(r === 'no-radio' ? 'no Bluetooth radio' : `Windows refused (${r || 'no answer'})`);
    return true;
  }
  openBluetoothSettings() { require('electron').shell.openExternal('ms-settings:bluetooth'); }
  destroy() { if (this.ps) { try { this.ps.kill(); } catch { /* gone */ } } }
}

// ---------------------------------------------------------------- Linux
function run(cmd, args, timeout = 8000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }, (err, out) => resolve(err ? null : out));
  });
}

// pactl's volume object -> 0..1 (first channel).
function pactlVolume(v) {
  if (!v || typeof v !== 'object') return 0;
  const ch = Object.values(v)[0];
  const pct = ch && (ch.value_percent || ch.valuePercent);
  return pct ? Math.max(0, Math.min(1.5, parseInt(pct, 10) / 100)) : 0;
}

// bluetoothctl "Device AA:BB:.. Name" lines
function parseBtDevices(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const m = /^Device\s+([0-9A-F:]{17})\s+(.*)$/i.exec(line.trim());
    if (m) out.push({ id: m[1].toUpperCase(), name: m[2].trim() || m[1] });
  }
  return out;
}

// bluetoothctl info -> { connected, audio, battery }
function parseBtInfo(text) {
  const t = String(text || '');
  const bat = /Battery Percentage:\s*0x[0-9a-f]+\s*\((\d+)\)/i.exec(t);
  return {
    connected: /^\s*Connected:\s*yes/im.test(t),
    paired: /^\s*Paired:\s*yes/im.test(t),
    audio: /^\s*Icon:\s*audio-/im.test(t) || /UUID: Audio Sink/i.test(t),
    battery: bat ? Number(bat[1]) : null
  };
}

class LinuxSound {
  async state() {
    const [sinksJ, inputsJ, def] = await Promise.all([
      run('pactl', ['-f', 'json', 'list', 'sinks']), run('pactl', ['-f', 'json', 'list', 'sink-inputs']), run('pactl', ['get-default-sink'])
    ]);
    if (sinksJ === null) throw new Error('pactl is not available (install pulseaudio-utils)');
    const sinks = JSON.parse(sinksJ || '[]');
    const inputs = JSON.parse(inputsJ || '[]');
    const defName = String(def || '').trim();
    const cur = sinks.find((s) => s.name === defName) || sinks[0];
    return {
      devices: sinks.map((s) => ({ id: s.name, name: s.description || s.name, default: s.name === defName })),
      master: cur ? { volume: pactlVolume(cur.volume), mute: !!cur.mute } : null,
      sessions: inputs.map((i) => {
        const p = i.properties || {};
        return {
          id: String(i.index), pid: Number(p['application.process.id']) || 0,
          name: p['application.name'] || p['media.name'] || 'App', exe: p['application.process.binary'] || '',
          icon: p['application.icon_name'] || '', system: false, active: !i.corked, volume: pactlVolume(i.volume), mute: !!i.mute
        };
      })
    };
  }
  async setMaster(v) { return (await run('pactl', ['set-sink-volume', '@DEFAULT_SINK@', `${Math.round(Math.max(0, Math.min(1.5, v)) * 100)}%`])) !== null; }
  async muteMaster(m) { return (await run('pactl', ['set-sink-mute', '@DEFAULT_SINK@', m ? '1' : '0'])) !== null; }
  async setApp(id, v) { if (!/^\d+$/.test(String(id))) return false; return (await run('pactl', ['set-sink-input-volume', String(id), `${Math.round(Math.max(0, Math.min(1.5, v)) * 100)}%`])) !== null; }
  async muteApp(id, m) { if (!/^\d+$/.test(String(id))) return false; return (await run('pactl', ['set-sink-input-mute', String(id), m ? '1' : '0'])) !== null; }
  async setDefault(id) { if (!/^[\w.:@-]+$/.test(String(id))) return false; return (await run('pactl', ['set-default-sink', String(id)])) !== null; }
  async bluetooth() {
    const show = await run('bluetoothctl', ['show'], 5000);
    if (show === null) return { radio: null, devices: [], error: 'bluetoothctl is not available' };
    const radio = /Powered:\s*yes/i.test(show) ? true : /Powered:\s*no/i.test(show) ? false : null;
    let list = await run('bluetoothctl', ['devices', 'Paired'], 5000);
    if (!list || !/Device/.test(list)) list = await run('bluetoothctl', ['paired-devices'], 5000);
    const devices = [];
    for (const d of parseBtDevices(list).slice(0, 30)) {
      const info = parseBtInfo(await run('bluetoothctl', ['info', d.id], 4000));
      devices.push({ ...d, connected: info.connected, audio: info.audio, battery: info.battery });
    }
    return { radio, devices };
  }
  async btConnect(id, on) {
    if (!/^[0-9A-F:]{17}$/i.test(String(id))) throw new Error('bad device');
    const out = await run('bluetoothctl', [on ? 'connect' : 'disconnect', id], 20000);
    if (out === null || /Failed|not available/i.test(out)) throw new Error(on ? 'could not connect' : 'could not disconnect');
    return true;
  }
  async btPower(on) {
    const out = await run('bluetoothctl', ['power', on ? 'on' : 'off'], 8000);
    if (out === null || /Failed/i.test(out)) throw new Error('could not switch Bluetooth');
    return true;
  }
  openBluetoothSettings() {
    for (const [cmd, args] of [['gnome-control-center', ['bluetooth']], ['blueman-manager', []], ['systemsettings', ['kcm_bluetooth']]]) {
      try { const p = spawn(cmd, args, { detached: true, stdio: 'ignore' }); p.on('error', () => {}); p.unref(); return; } catch { /* next */ }
    }
  }
  destroy() {}
}

// PipeWire without the PulseAudio tools (Debian 13's default): the nodes
// from pw-dump, volumes through wpctl.
function parseWpVolume(text) {
  const m = /Volume:\s*([\d.]+)/.exec(String(text || ''));
  return { volume: m ? Math.max(0, Math.min(1.5, Number(m[1]))) : 0, mute: /\[MUTED\]/.test(String(text || '')) };
}

// pw-dump JSON -> { sinks: [{ id, name }], streams: [{ id, name, exe, pid, icon }] }
function parsePwDump(list) {
  const sinks = [];
  const streams = [];
  for (const o of Array.isArray(list) ? list : []) {
    if (!o || !/Node$/.test(String(o.type || ''))) continue;
    const p = (o.info && o.info.props) || {};
    const cls = String(p['media.class'] || '');
    if (cls === 'Audio/Sink') sinks.push({ id: String(o.id), name: p['node.description'] || p['node.nick'] || p['node.name'] || `Output ${o.id}` });
    else if (cls === 'Stream/Output/Audio') {
      streams.push({
        id: String(o.id), name: p['application.name'] || p['media.name'] || p['node.name'] || 'App',
        exe: p['application.process.binary'] || '', pid: Number(p['application.process.id']) || 0, icon: p['application.icon-name'] || '',
        active: String((o.info && o.info.state) || '') === 'running'
      });
    }
  }
  return { sinks, streams };
}

class WpctlSound extends LinuxSound {
  async state() {
    const dump = await run('pw-dump', [], 8000);
    if (dump === null) throw new Error('neither pactl nor PipeWire tools are available');
    const { sinks, streams } = parsePwDump(JSON.parse(dump || '[]'));
    const inspect = await run('wpctl', ['inspect', '@DEFAULT_AUDIO_SINK@'], 4000);
    const defId = (/^id (\d+)/m.exec(String(inspect || '')) || [])[1] || '';
    const master = sinks.length ? parseWpVolume(await run('wpctl', ['get-volume', '@DEFAULT_AUDIO_SINK@'], 4000)) : null;
    const sessions = [];
    for (const st of streams.slice(0, 30)) {
      const v = parseWpVolume(await run('wpctl', ['get-volume', st.id], 4000));
      sessions.push({ ...st, system: false, volume: v.volume, mute: v.mute });
    }
    return { devices: sinks.map((d) => ({ ...d, default: d.id === defId })), master, sessions };
  }
  async setMaster(v) { return (await run('wpctl', ['set-volume', '@DEFAULT_AUDIO_SINK@', Math.max(0, Math.min(1.5, v)).toFixed(3)])) !== null; }
  async muteMaster(m) { return (await run('wpctl', ['set-mute', '@DEFAULT_AUDIO_SINK@', m ? '1' : '0'])) !== null; }
  async setApp(id, v) { if (!/^\d+$/.test(String(id))) return false; return (await run('wpctl', ['set-volume', String(id), Math.max(0, Math.min(1.5, v)).toFixed(3)])) !== null; }
  async muteApp(id, m) { if (!/^\d+$/.test(String(id))) return false; return (await run('wpctl', ['set-mute', String(id), m ? '1' : '0'])) !== null; }
  async setDefault(id) { if (!/^\d+$/.test(String(id))) return false; return (await run('wpctl', ['set-default', String(id)])) !== null; }
}

function hasCommand(cmd) {
  try { require('child_process').execFileSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }); return true; } catch { return false; }
}

function createSound() {
  if (process.platform === 'win32') return new WinSound();
  if (process.platform === 'linux') return hasCommand('pactl') || !hasCommand('wpctl') ? new LinuxSound() : new WpctlSound();
  return null;
}

module.exports = { createSound, WinSound, LinuxSound, WpctlSound, parseBtDevices, parseBtInfo, pactlVolume, parseWpVolume, parsePwDump };
