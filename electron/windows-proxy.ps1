$ErrorActionPreference = 'Stop'
Add-Type -ReferencedAssemblies System.Web.Extensions -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;

public static class QaletxProxy {
  [StructLayout(LayoutKind.Explicit)] struct Value {
    [FieldOffset(0)] public int Flags;
    [FieldOffset(0)] public IntPtr Text;
    [FieldOffset(0)] public long Time;
  }
  [StructLayout(LayoutKind.Sequential)] struct Option { public int Kind; public Value Value; }
  [StructLayout(LayoutKind.Sequential)] struct List {
    public int Size; public IntPtr Connection; public int Count; public int Error; public IntPtr Options;
  }
  public class Settings { public int flags; public string server; public string bypass; public string pac; }
  public class Request { public string action; public Settings settings; }
  [DllImport("wininet.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool InternetQueryOptionW(IntPtr h, int option, ref List list, ref int size);
  [DllImport("wininet.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool InternetSetOptionW(IntPtr h, int option, ref List list, int size);
  [DllImport("wininet.dll", EntryPoint="InternetSetOptionW", SetLastError=true)]
  static extern bool Notify(IntPtr h, int option, IntPtr value, int size);
  [DllImport("kernel32.dll")] static extern IntPtr GlobalFree(IntPtr pointer);
  static Settings Access(Settings input) {
    int stride = Marshal.SizeOf(typeof(Option));
    IntPtr memory = Marshal.AllocHGlobal(stride * 4);
    bool querying = input == null;
    IntPtr[] strings = new IntPtr[4];
    try {
      for (int i=0; i<4; i++) {
        Option o = new Option(); o.Kind = i+1;
        if (!querying) {
          if (i==0) o.Value.Flags = input.flags;
          else {
            string value = i==1 ? input.server : i==2 ? input.bypass : input.pac;
            strings[i] = Marshal.StringToHGlobalUni(value ?? ""); o.Value.Text = strings[i];
          }
        }
        Marshal.StructureToPtr(o, new IntPtr(memory.ToInt64() + i*stride), false);
      }
      List list = new List(); list.Size = Marshal.SizeOf(typeof(List)); list.Count=4; list.Options=memory;
      int size=list.Size;
      bool success = querying ? InternetQueryOptionW(IntPtr.Zero,75,ref list,ref size) : InternetSetOptionW(IntPtr.Zero,75,ref list,size);
      if (!success) throw new Win32Exception(Marshal.GetLastWin32Error());
      if (!querying) {
        Notify(IntPtr.Zero,39,IntPtr.Zero,0); Notify(IntPtr.Zero,37,IntPtr.Zero,0);
        return input;
      }
      Settings result = new Settings();
      for (int i=0; i<4; i++) {
        Option o = (Option)Marshal.PtrToStructure(new IntPtr(memory.ToInt64() + i*stride),typeof(Option));
        if (i==0) result.flags=o.Value.Flags;
        else {
          strings[i]=o.Value.Text;
          string value=o.Value.Text==IntPtr.Zero ? "" : Marshal.PtrToStringUni(o.Value.Text);
          if(i==1) result.server=value; else if(i==2) result.bypass=value; else result.pac=value;
        }
      }
      return result;
    } finally {
      for(int i=1;i<4;i++) if(strings[i]!=IntPtr.Zero) {
        if(querying) GlobalFree(strings[i]); else Marshal.FreeHGlobal(strings[i]);
      }
      Marshal.FreeHGlobal(memory);
    }
  }
  public static string Dispatch(string json) {
    JavaScriptSerializer serializer = new JavaScriptSerializer();
    Request request=serializer.Deserialize<Request>(json);
    if(request.action!="get" && request.action!="set") throw new ArgumentException("Invalid proxy action");
    if(request.action=="set" && request.settings==null) throw new ArgumentException("Missing proxy settings");
    return serializer.Serialize(Access(request.action=="set" ? request.settings : null));
  }
}
'@
[Console]::Out.WriteLine([QaletxProxy]::Dispatch([Console]::In.ReadToEnd()))
