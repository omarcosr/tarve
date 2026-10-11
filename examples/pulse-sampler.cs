using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Management;
using System.Net.NetworkInformation;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

// Pulse example: everything a user (non-admin) program can read on Windows,
// once a second, as one JSON line on stdout. No performance-counter paths in
// the display language: classic counters through PDH's English names, the
// rest from ntdll/psapi, IOCTLs, WMI and NVML. Compiled to a small executable
// (or by PowerShell's Add-Type where no compiler is found); PulseMain also
// extracts program icons on request, so one helper process does everything.
public static class PulseSampler {
  [DllImport("ntdll.dll")] static extern int NtQuerySystemInformation(int cls, IntPtr buf, int len, out int ret);
  [StructLayout(LayoutKind.Sequential)] struct PerfInfo { public uint cb; public UIntPtr CommitTotal, CommitLimit, CommitPeak, PhysicalTotal, PhysicalAvailable, SystemCache, KernelTotal, KernelPaged, KernelNonpaged, PageSize; public uint HandleCount, ProcessCount, ThreadCount; }
  [DllImport("psapi.dll")] static extern bool GetPerformanceInfo(out PerfInfo info, uint size);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageNameW(IntPtr h, uint flags, StringBuilder name, ref uint size);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern SafeFileHandle CreateFileW(string n, uint a, uint s, IntPtr sa, uint c, uint f, IntPtr t);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool DeviceIoControl(SafeFileHandle h, uint code, IntPtr i, uint il, IntPtr o, uint ol, out uint ret, IntPtr ov);
  [DllImport("pdh.dll", CharSet = CharSet.Unicode)] static extern uint PdhOpenQueryW(string src, IntPtr user, out IntPtr q);
  [DllImport("pdh.dll", CharSet = CharSet.Unicode)] static extern uint PdhAddEnglishCounterW(IntPtr q, string path, IntPtr user, out IntPtr c);
  [DllImport("pdh.dll")] static extern uint PdhCollectQueryData(IntPtr q);
  [DllImport("pdh.dll", CharSet = CharSet.Unicode)] static extern uint PdhGetFormattedCounterArrayW(IntPtr c, uint fmt, ref uint size, out uint count, IntPtr buf);
  [StructLayout(LayoutKind.Sequential)] struct PdhItem { public IntPtr name; public uint status; public uint pad; public double value; }


  // The GPU Task Manager would chart here: the DXGI adapter with the most
  // dedicated memory (software adapters skipped), named by its LUID, which is
  // how GPU Engine and GPU Adapter Memory instances are keyed.
  [DllImport("dxgi.dll")] static extern int CreateDXGIFactory1(ref Guid riid, out IntPtr factory);
  delegate int EnumAdapters1(IntPtr self, uint index, out IntPtr adapter);
  delegate int GetDesc1(IntPtr self, IntPtr desc);
  delegate uint Release(IntPtr self);
  // Every hardware adapter, as Task Manager lists them: name, LUID (how GPU
  // Engine and GPU Adapter Memory instances are keyed) and memory sizes.
  static readonly List<string> gpus = new List<string>();
  static T Slot<T>(IntPtr com, int slot) { return (T)(object)Marshal.GetDelegateForFunctionPointer(Marshal.ReadIntPtr(Marshal.ReadIntPtr(com), slot * IntPtr.Size), typeof(T)); }
  static void FindGpus() {
    try {
      var iid = new Guid("770aae78-f26f-4dba-a829-253c83d1b387"); IntPtr f;
      if (CreateDXGIFactory1(ref iid, out f) != 0) return;
      var desc = Marshal.AllocHGlobal(512); var seen = new HashSet<string>();
      for (uint i = 0; ; i++) {
        IntPtr a; if (Slot<EnumAdapters1>(f, 12)(f, i, out a) != 0) break;
        if (Slot<GetDesc1>(a, 10)(a, desc) == 0) {
          // DXGI_ADAPTER_DESC1: Description[128], VendorId, DeviceId, SubSysId, Revision, 3 SIZE_Ts, LUID, Flags.
          int o = 256; uint vendor = (uint)Marshal.ReadInt32(desc, o); o += 16;
          long dedicated = Marshal.ReadIntPtr(desc, o).ToInt64(), shared = Marshal.ReadIntPtr(desc, o + 2 * IntPtr.Size).ToInt64(); o += 3 * IntPtr.Size;
          uint low = (uint)Marshal.ReadInt32(desc, o); int high = Marshal.ReadInt32(desc, o + 4); uint flags = (uint)Marshal.ReadInt32(desc, o + 8);
          string luid = "luid_0x" + high.ToString("X8") + "_0x" + low.ToString("X8");
          if ((flags & 2) == 0 && vendor == 0x10DE) nvidia.Add(luid);
          if ((flags & 2) == 0 && seen.Add(luid))
            gpus.Add("{\"name\":" + Json(Marshal.PtrToStringUni(desc).TrimEnd('\0')) + ",\"luid\":\"" + luid + "\",\"vendor\":" + vendor + ",\"dedicated\":" + dedicated + ",\"shared\":" + shared + "}");
        }
        Slot<Release>(a, 2)(a);
      }
      Marshal.FreeHGlobal(desc); Slot<Release>(f, 2)(f);
    } catch { }
  }

  static IntPtr query;
  static readonly Dictionary<string, IntPtr> counters = new Dictionary<string, IntPtr>();
  static readonly Dictionary<uint, string> paths = new Dictionary<uint, string>();
  static readonly List<string> nvidia = new List<string>();

  static void AddCounter(string key, string path) { IntPtr c; if (PdhAddEnglishCounterW(query, path, IntPtr.Zero, out c) == 0) counters[key] = c; }

  static List<KeyValuePair<string, double>> Instances(string key) {
    var list = new List<KeyValuePair<string, double>>();
    IntPtr c; if (!counters.TryGetValue(key, out c)) return list;
    uint size = 0, count; PdhGetFormattedCounterArrayW(c, 0x200, ref size, out count, IntPtr.Zero);
    if (size == 0) return list;
    IntPtr buf = Marshal.AllocHGlobal((int)size);
    try {
      if (PdhGetFormattedCounterArrayW(c, 0x200, ref size, out count, buf) != 0) return list;
      int n = Marshal.SizeOf(typeof(PdhItem));
      for (int i = 0; i < count; i++) {
        var it = (PdhItem)Marshal.PtrToStructure(buf + i * n, typeof(PdhItem));
        if (it.status == 0) list.Add(new KeyValuePair<string, double>(Marshal.PtrToStringUni(it.name), it.value));
      }
    } finally { Marshal.FreeHGlobal(buf); }
    return list;
  }

  static string Json(string s) {
    if (s == null) return "null";
    var b = new StringBuilder("\"");
    foreach (char ch in s) { if (ch == '"' || ch == '\\') b.Append('\\').Append(ch); else if (ch < ' ') b.Append("\\u").Append(((int)ch).ToString("x4")); else b.Append(ch); }
    return b.Append('"').ToString();
  }
  static string Num(double v) { return double.IsNaN(v) || double.IsInfinity(v) ? "0" : v.ToString("R", System.Globalization.CultureInfo.InvariantCulture); }

  // Each process's image path, already as JSON, looked up once per process.
  static string PathOf(uint pid) {
    string p; if (paths.TryGetValue(pid, out p)) return p;
    string path = null;
    IntPtr h = OpenProcess(0x1000, false, pid);
    if (h != IntPtr.Zero) { var sb = new StringBuilder(1024); uint n = 1024; if (QueryFullProcessImageNameW(h, 0, sb, ref n)) path = sb.ToString(); CloseHandle(h); }
    paths[pid] = p = Json(path);
    return p;
  }

  // The process snapshot buffer, kept between samples: a fresh megabyte each
  // second cost more in page faults than the query itself.
  static IntPtr procBuf = IntPtr.Zero;
  static int procLen = 1 << 20;

  static string Processes(StringBuilder o, out int runnable) {
    runnable = 0;
    int ret;
    while (true) {
      if (procBuf == IntPtr.Zero) procBuf = Marshal.AllocHGlobal(procLen);
      int st = NtQuerySystemInformation(5, procBuf, procLen, out ret);
      if (st == 0) break;
      Marshal.FreeHGlobal(procBuf); procBuf = IntPtr.Zero;
      if (st != unchecked((int)0xC0000004)) return "";
      procLen *= 2;
    }
    IntPtr buf = procBuf;
    long compression = 0;
    var seen = new HashSet<uint>();
    {
      long off = 0; bool first = true;
      while (true) {
        IntPtr p = buf + (int)off;
        int next = Marshal.ReadInt32(p, 0), threads = Marshal.ReadInt32(p, 4);
        uint pid = (uint)Marshal.ReadInt64(p, 80), ppid = (uint)Marshal.ReadInt64(p, 88);
        ushort nlen = (ushort)Marshal.ReadInt16(p, 56); IntPtr name = Marshal.ReadIntPtr(p, 64);
        string n = name == IntPtr.Zero ? (pid == 0 ? "System Idle Process" : "") : Marshal.PtrToStringUni(name, nlen / 2);
        long ws = Marshal.ReadInt64(p, 144), privateWs = Marshal.ReadInt64(p, 8), cpu = Marshal.ReadInt64(p, 40) + Marshal.ReadInt64(p, 48);
        long rb = Marshal.ReadInt64(p, 232), wb = Marshal.ReadInt64(p, 240);
        if (n == "Memory Compression") compression = ws;
        if (pid != 0) {
          for (int t = 0; t < threads; t++) { int state = Marshal.ReadInt32(p, 256 + t * 80 + 68); if (state == 1 || state == 2) runnable++; }
          seen.Add(pid);
          if (!first) o.Append(',');
          first = false;
          if (n.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) n = n.Substring(0, n.Length - 4);
          o.Append('[').Append(pid).Append(',').Append(ppid).Append(',').Append(Json(n)).Append(',').Append(PathOf(pid)).Append(',')
            .Append(threads).Append(',').Append(Num(cpu / 1e7)).Append(',').Append(privateWs).Append(',').Append(rb).Append(',').Append(wb).Append(']');
        }
        if (next == 0) break;
        off += next;
      }
    }
    var gone = new List<uint>(); foreach (var k in paths.Keys) if (!seen.Contains(k)) gone.Add(k); foreach (var k in gone) paths.Remove(k);
    return compression.ToString();
  }

  static string Memory(string compression) {
    var buf = Marshal.AllocHGlobal(256);
    long zero = 0, free = 0, modified = 0, standby = 0;
    try {
      int ret;
      if (NtQuerySystemInformation(80, buf, 256, out ret) == 0) {
        zero = Marshal.ReadInt64(buf, 0); free = Marshal.ReadInt64(buf, 8); modified = Marshal.ReadInt64(buf, 16);
        for (int i = 5; i < 13; i++) standby += Marshal.ReadInt64(buf, i * 8);
      }
    } finally { Marshal.FreeHGlobal(buf); }
    PerfInfo pi; GetPerformanceInfo(out pi, (uint)Marshal.SizeOf(typeof(PerfInfo)));
    long page = (long)pi.PageSize.ToUInt64();
    return "{\"total\":" + ((long)pi.PhysicalTotal.ToUInt64() * page) + ",\"available\":" + ((long)pi.PhysicalAvailable.ToUInt64() * page)
      + ",\"zero\":" + (zero * page) + ",\"free\":" + (free * page) + ",\"modified\":" + (modified * page) + ",\"standby\":" + (standby * page)
      + ",\"nonpaged\":" + ((long)pi.KernelNonpaged.ToUInt64() * page) + ",\"paged\":" + ((long)pi.KernelPaged.ToUInt64() * page)
      + ",\"compressed\":" + compression + ",\"commit\":" + ((long)pi.CommitTotal.ToUInt64() * page) + ",\"commitLimit\":" + ((long)pi.CommitLimit.ToUInt64() * page)
      + ",\"handles\":" + pi.HandleCount + ",\"threads\":" + pi.ThreadCount + "}";
  }

  // Per physical disk, as Task Manager shows them: model, SSD or HDD, bus,
  // size and drive letters (looked up now and then), and the running counters
  // its activity, speeds and response time are derived from.
  static readonly Dictionary<int, string> diskInfo = new Dictionary<int, string>();
  static int diskInfoAge = 0;
  static SafeFileHandle Open(string path) { return CreateFileW(path, 0, 3, IntPtr.Zero, 3, 0, IntPtr.Zero); }
  static string DiskInfo(SafeFileHandle h, int index, Dictionary<int, List<string>> letters) {
    string model = null; int bus = 0; bool? ssd = null; long size = 0;
    var q = Marshal.AllocHGlobal(12); var o = Marshal.AllocHGlobal(1024); uint r;
    try {
      Marshal.WriteInt32(q, 0, 0); Marshal.WriteInt32(q, 4, 0); Marshal.WriteInt32(q, 8, 0);
      if (DeviceIoControl(h, 0x2D1400, q, 12, o, 1024, out r, IntPtr.Zero)) {
        int vendorAt = Marshal.ReadInt32(o, 12), productAt = Marshal.ReadInt32(o, 16); bus = Marshal.ReadInt32(o, 28);
        string vendor = vendorAt > 0 ? Marshal.PtrToStringAnsi(o + vendorAt).Trim() : "", product = productAt > 0 ? Marshal.PtrToStringAnsi(o + productAt).Trim() : "";
        model = (vendor.Length > 0 && !product.StartsWith(vendor) ? vendor + " " : "") + product;
      }
      Marshal.WriteInt32(q, 0, 7);
      if (DeviceIoControl(h, 0x2D1400, q, 12, o, 1024, out r, IntPtr.Zero)) ssd = Marshal.ReadByte(o, 8) == 0;
      if (DeviceIoControl(h, 0x700A0, IntPtr.Zero, 0, o, 1024, out r, IntPtr.Zero)) size = Marshal.ReadInt64(o, 24);
    } finally { Marshal.FreeHGlobal(q); Marshal.FreeHGlobal(o); }
    List<string> l; letters.TryGetValue(index, out l);
    return "\"model\":" + Json(model) + ",\"bus\":" + bus + ",\"ssd\":" + (ssd == null ? "null" : ssd.Value ? "true" : "false") + ",\"size\":" + size
      + ",\"letters\":" + Json(l == null ? "" : string.Join(" ", l));
  }
  static string Disks() {
    if (diskInfoAge-- <= 0) { diskInfo.Clear(); diskInfoAge = 30; }
    Dictionary<int, List<string>> letters = null;
    long freeBytes = 0, total = 0;
    var list = new StringBuilder("[");
    for (int i = 0; i < 32; i++) {
      using (var h = Open("\\\\.\\PhysicalDrive" + i)) {
        if (h.IsInvalid) continue;
        var buf = Marshal.AllocHGlobal(256); uint r;
        try {
          if (!DeviceIoControl(h, 0x70020, IntPtr.Zero, 0, buf, 256, out r, IntPtr.Zero)) continue;
          string info;
          if (!diskInfo.TryGetValue(i, out info)) {
            if (letters == null) {
              letters = new Dictionary<int, List<string>>();
              foreach (var d in DriveInfo.GetDrives()) {
                if (d.DriveType != DriveType.Fixed && d.DriveType != DriveType.Removable) continue;
                using (var v = Open("\\\\.\\" + d.Name.TrimEnd('\\'))) {
                  if (v.IsInvalid) continue;
                  var n = Marshal.AllocHGlobal(12); uint nr;
                  if (DeviceIoControl(v, 0x2D1080, IntPtr.Zero, 0, n, 12, out nr, IntPtr.Zero)) { int disk = Marshal.ReadInt32(n, 4); List<string> l; if (!letters.TryGetValue(disk, out l)) letters[disk] = l = new List<string>(); l.Add(d.Name.TrimEnd('\\')); }
                  Marshal.FreeHGlobal(n);
                }
              }
            }
            diskInfo[i] = info = DiskInfo(h, i, letters);
          }
          if (list.Length > 1) list.Append(',');
          list.Append("{\"index\":").Append(i).Append(',').Append(info)
            .Append(",\"read\":").Append(Marshal.ReadInt64(buf, 0)).Append(",\"written\":").Append(Marshal.ReadInt64(buf, 8))
            .Append(",\"readTime\":").Append(Marshal.ReadInt64(buf, 16)).Append(",\"writeTime\":").Append(Marshal.ReadInt64(buf, 24))
            .Append(",\"idle\":").Append(Marshal.ReadInt64(buf, 32)).Append(",\"reads\":").Append((uint)Marshal.ReadInt32(buf, 40)).Append(",\"writes\":").Append((uint)Marshal.ReadInt32(buf, 44))
            .Append(",\"query\":").Append(Marshal.ReadInt64(buf, 56)).Append('}');
        } finally { Marshal.FreeHGlobal(buf); }
      }
    }
    foreach (var d in DriveInfo.GetDrives()) { try { if (d.DriveType == DriveType.Fixed && d.IsReady) { freeBytes += d.AvailableFreeSpace; total += d.TotalSize; } } catch { } }
    return "{\"free\":" + freeBytes + ",\"total\":" + total + ",\"disks\":" + list.Append(']') + "}";
  }

  // Every connected adapter, as Task Manager lists them. Tunnels (VPNs) and
  // virtual switches (WSL, Hyper-V) are marked: their traffic also crosses a
  // physical adapter, so totals leave them out.
  // Adapters as Windows lists them (GetAdaptersAddresses, through .NET),
  // refreshed every 30 s and matched by name to their LUIDs in GetIfTable2;
  // each second only their own rows are read (GetIfEntry2), a few
  // microseconds against milliseconds for .NET's per-adapter statistics.
  [DllImport("iphlpapi.dll")] static extern int GetIfTable2(out IntPtr table);
  [DllImport("iphlpapi.dll")] static extern int GetIfEntry2(IntPtr row);
  [DllImport("iphlpapi.dll")] static extern void FreeMibTable(IntPtr table);
  struct Nic { public string head; public long luid; }
  static List<Nic> nics = new List<Nic>();
  static int nicsAge = 29;
  static IntPtr ifRow = IntPtr.Zero;
  static string Network() {
    if (++nicsAge >= 30) {
      nicsAge = 0;
      var luids = new Dictionary<string, long>();
      IntPtr table;
      if (GetIfTable2(out table) == 0) {
        // MIB_IF_ROW2 (1352 bytes): InterfaceLuid at 0, Alias (the adapter's name) at 28.
        int count = Marshal.ReadInt32(table);
        for (int k = 0; k < count; k++) { IntPtr row = table + 8 + k * 1352; luids[Marshal.PtrToStringUni(row + 28)] = Marshal.ReadInt64(row); }
        FreeMibTable(table);
      }
      var list = new List<Nic>();
      foreach (var nic in NetworkInterface.GetAllNetworkInterfaces()) {
        if (nic.NetworkInterfaceType == NetworkInterfaceType.Loopback || nic.OperationalStatus != OperationalStatus.Up) continue;
        long luid; if (!luids.TryGetValue(nic.Name, out luid)) continue;
        bool virt = nic.NetworkInterfaceType == NetworkInterfaceType.Tunnel || (int)nic.NetworkInterfaceType == 53 || nic.Description.IndexOf("Virtual", StringComparison.OrdinalIgnoreCase) >= 0;
        // Its addresses and hardware address, as the Network page lists them.
        var v4 = new List<string>(); var v6 = new List<string>(); string mac = "";
        try {
          foreach (var u in nic.GetIPProperties().UnicastAddresses) {
            if (u.Address.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork) v4.Add(Json(u.Address.ToString()));
            else if (u.Address.AddressFamily == System.Net.Sockets.AddressFamily.InterNetworkV6) v6.Add(Json(u.Address.ToString()));
          }
          var bytes = nic.GetPhysicalAddress().GetAddressBytes();
          mac = bytes.Length == 0 ? "" : BitConverter.ToString(bytes).Replace('-', ':');
        } catch { }
        list.Add(new Nic { luid = luid, head = "{\"name\":" + Json(nic.Name) + ",\"description\":" + Json(nic.Description) + ",\"wireless\":" + (nic.NetworkInterfaceType == NetworkInterfaceType.Wireless80211 ? "true" : "false")
          + ",\"virtual\":" + (virt ? "true" : "false") + ",\"ipv4\":[" + string.Join(",", v4) + "],\"ipv6\":[" + string.Join(",", v6) + "],\"mac\":" + Json(mac) });
      }
      nics = list;
    }
    if (ifRow == IntPtr.Zero) ifRow = Marshal.AllocHGlobal(1352);
    var b = new StringBuilder("[");
    foreach (var nic in nics) {
      // TransmitLinkSpeed at 1192, InOctets 1208, OutOctets 1280.
      Marshal.WriteInt64(ifRow, 0, nic.luid); Marshal.WriteInt32(ifRow, 8, 0);
      if (GetIfEntry2(ifRow) != 0) continue;
      if (b.Length > 1) b.Append(',');
      b.Append(nic.head).Append(",\"speed\":").Append(Marshal.ReadInt64(ifRow, 1192)).Append(",\"received\":").Append(Marshal.ReadInt64(ifRow, 1208)).Append(",\"sent\":").Append(Marshal.ReadInt64(ifRow, 1280)).Append('}');
    }
    return b.Append(']').ToString();
  }

  // Established TCP connections per process (IPv4 and IPv6): what a program
  // without administrator rights can tell about which apps use the network.
  [DllImport("iphlpapi.dll")] static extern uint GetExtendedTcpTable(IntPtr table, ref int size, bool order, int family, int kind, uint reserved);
  static IntPtr tcpBuf = IntPtr.Zero;
  static int tcpLen = 1 << 16;
  static string Connections() {
    var counts = new Dictionary<uint, int>();
    foreach (var family in new[] { 2, 23 }) {
      int rowSize = family == 2 ? 24 : 56, pidAt = family == 2 ? 20 : 52, stateAt = family == 2 ? 0 : 48;
      for (int attempt = 0; attempt < 3; attempt++) {
        if (tcpBuf == IntPtr.Zero) tcpBuf = Marshal.AllocHGlobal(tcpLen);
        int size = tcpLen;
        uint st = GetExtendedTcpTable(tcpBuf, ref size, false, family, 5, 0);
        if (st == 122) { Marshal.FreeHGlobal(tcpBuf); tcpBuf = IntPtr.Zero; tcpLen = size + 4096; continue; }
        if (st != 0) break;
        int n = Marshal.ReadInt32(tcpBuf);
        for (int i = 0; i < n; i++) {
          IntPtr row = tcpBuf + 4 + i * rowSize;
          if (Marshal.ReadInt32(row, stateAt) != 5) continue;
          uint pid = (uint)Marshal.ReadInt32(row, pidAt); int k; counts.TryGetValue(pid, out k); counts[pid] = k + 1;
        }
        break;
      }
    }
    var b = new StringBuilder("[");
    foreach (var kv in counts) { if (b.Length > 1) b.Append(','); b.Append('[').Append(kv.Key).Append(',').Append(kv.Value).Append(']'); }
    return b.Append(']').ToString();
  }

  static string battery = "null";
  static string Battery() {
    try {
      double full = 0, cycles = 0, rate = 0, remaining = 0, voltage = 0; bool online = false, charging = false, discharging = false, any = false;
      using (var s = new ManagementObjectSearcher(@"root\wmi", "SELECT * FROM BatteryStatus"))
        foreach (ManagementObject b in s.Get()) { any = true; online = (bool)b["PowerOnline"]; charging = (bool)b["Charging"]; discharging = (bool)b["Discharging"];
          rate = discharging ? Convert.ToDouble(b["DischargeRate"]) : charging ? Convert.ToDouble(b["ChargeRate"]) : 0; remaining = Convert.ToDouble(b["RemainingCapacity"]); voltage = Convert.ToDouble(b["Voltage"]); }
      if (!any) return "null";
      using (var s = new ManagementObjectSearcher(@"root\wmi", "SELECT * FROM BatteryFullChargedCapacity")) foreach (ManagementObject b in s.Get()) full = Convert.ToDouble(b["FullChargedCapacity"]);
      using (var s = new ManagementObjectSearcher(@"root\wmi", "SELECT * FROM BatteryCycleCount")) foreach (ManagementObject b in s.Get()) cycles = Convert.ToDouble(b["CycleCount"]);
      return "{\"full\":" + Num(full) + ",\"remaining\":" + Num(remaining) + ",\"rate\":" + Num(rate) + ",\"voltage\":" + Num(voltage) + ",\"cycles\":" + Num(cycles)
        + ",\"online\":" + (online ? "true" : "false") + ",\"charging\":" + (charging ? "true" : "false") + ",\"discharging\":" + (discharging ? "true" : "false") + "}";
    } catch { return "null"; }
  }

  // NVIDIA's own temperature, board power, utilization and memory, through
  // NVML (nvml.dll, installed with the driver) rather than starting nvidia-smi
  // every second. Only while the GPU is working (1% or more): querying a
  // hybrid laptop's idle GPU would wake it from its low-power state, and NVML
  // keeps ~20 MB resident, so it is loaded on demand and unloaded after 10 s
  // idle. The driver answers the power query only at its next reading (up to
  // half a second), so NVML runs on its own thread and a sample takes the latest.
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr LoadLibraryW(string name);
  [DllImport("kernel32.dll")] static extern bool FreeLibrary(IntPtr module);
  [DllImport("kernel32.dll", CharSet = CharSet.Ansi)] static extern IntPtr GetProcAddress(IntPtr module, string name);
  delegate int NvVoid();
  delegate int NvHandle(uint index, out IntPtr device);
  delegate int NvTemperature(IntPtr device, int sensor, out uint celsius);
  delegate int NvUint(IntPtr device, out uint value);
  delegate int NvUtilization(IntPtr device, out NvUtil util);
  delegate int NvMemoryInfo(IntPtr device, out NvMemory memory);
  [StructLayout(LayoutKind.Sequential)] struct NvUtil { public uint gpu, memory; }
  [StructLayout(LayoutKind.Sequential)] struct NvMemory { public ulong total, free, used; }
  static T Nv<T>(IntPtr module, string name) where T : class { var f = GetProcAddress(module, name); if (f == IntPtr.Zero) throw new EntryPointNotFoundException(name); return (T)(object)Marshal.GetDelegateForFunctionPointer(f, typeof(T)); }
  static bool nvBroken;
  static volatile bool nvWanted;
  static volatile string nvLatest = "null";
  static System.Threading.Thread nvThread;
  static string Nvidia(List<KeyValuePair<string, double>> engines) {
    if (nvidia.Count == 0 || nvBroken) return "null";
    double busy = 0;
    foreach (var kv in engines) foreach (var luid in nvidia) if (kv.Key.IndexOf(luid, StringComparison.Ordinal) >= 0) busy = Math.Max(busy, kv.Value);
    nvWanted = busy >= 1;
    if (nvWanted && nvThread == null) {
      nvThread = new System.Threading.Thread(NvidiaLoop);
      nvThread.IsBackground = true;
      nvThread.Start();
    }
    return nvWanted ? nvLatest : "null";
  }
  static void NvidiaLoop() {
    IntPtr module = IntPtr.Zero; NvVoid shutdown = null; IntPtr device = IntPtr.Zero; int idle = 0;
    NvTemperature temperature = null; NvUint power = null; NvUtilization utilization = null; NvMemoryInfo memory = null;
    while (!nvBroken) {
      if (!nvWanted) {
        nvLatest = "null";
        if (module != IntPtr.Zero && ++idle >= 10) { try { shutdown(); } catch { } FreeLibrary(module); module = IntPtr.Zero; }
      } else {
        idle = 0;
        try {
          if (module == IntPtr.Zero) {
            module = LoadLibraryW("nvml.dll");
            if (module == IntPtr.Zero) { nvBroken = true; break; }
            if (Nv<NvVoid>(module, "nvmlInit_v2")() != 0 || Nv<NvHandle>(module, "nvmlDeviceGetHandleByIndex_v2")(0, out device) != 0) { FreeLibrary(module); nvBroken = true; break; }
            shutdown = Nv<NvVoid>(module, "nvmlShutdown");
            temperature = Nv<NvTemperature>(module, "nvmlDeviceGetTemperature"); power = Nv<NvUint>(module, "nvmlDeviceGetPowerUsage");
            utilization = Nv<NvUtilization>(module, "nvmlDeviceGetUtilizationRates"); memory = Nv<NvMemoryInfo>(module, "nvmlDeviceGetMemoryInfo");
          }
          uint t, p; NvUtil u; NvMemory m;
          nvLatest = "{\"temp\":" + (temperature(device, 0, out t) == 0 ? Num(t) : "null")
            + ",\"power\":" + (power(device, out p) == 0 ? Num(p / 1000.0) : "null")
            + ",\"util\":" + (utilization(device, out u) == 0 ? Num(u.gpu) : "null")
            + ",\"memory\":" + (memory(device, out m) == 0 ? Num(m.used / 1048576.0) : "null") + "}";
        } catch { nvBroken = true; break; }
      }
      System.Threading.Thread.Sleep(1000);
    }
    nvLatest = "null";
  }

  static string Pairs(List<KeyValuePair<string, double>> list) {
    var b = new StringBuilder("["); bool first = true;
    foreach (var kv in list) { if (!first) b.Append(','); first = false; b.Append('[').Append(Json(kv.Key)).Append(',').Append(Num(kv.Value)).Append(']'); }
    return b.Append(']').ToString();
  }

  // One sample as a JSON line.
  static string Line() {
    var o = new StringBuilder("{\"procs\":[");
    int runnable; string compression = Processes(o, out runnable);
    o.Append("],\"runnable\":").Append(runnable);
    o.Append(",\"memory\":").Append(Memory(compression == "" ? "0" : compression));
    o.Append(",\"disk\":").Append(Disks());
    o.Append(",\"net\":").Append(Network());
    o.Append(",\"connections\":").Append(Connections());
    // One clock for every rate: when this sample was taken, in seconds.
    o.Append(",\"at\":").Append(Num((double)Stopwatch.GetTimestamp() / Stopwatch.Frequency));
    o.Append(",\"cpuUtility\":").Append(Pairs(Instances("cpu"))).Append(",\"cpuPrivileged\":").Append(Pairs(Instances("cpuPrivileged"))).Append(",\"cpuTime\":").Append(Pairs(Instances("cpuTime")));
    o.Append(",\"cpuPerf\":").Append(Pairs(Instances("cpuPerf"))).Append(",\"cpuBase\":").Append(Pairs(Instances("cpuBase")));
    o.Append(",\"gpus\":[").Append(string.Join(",", gpus)).Append(']');
    var engines = Instances("gpu");
    o.Append(",\"gpuEngines\":").Append(Pairs(engines));
    o.Append(",\"gpuDedicated\":").Append(Pairs(Instances("gpuDedicated"))).Append(",\"gpuShared\":").Append(Pairs(Instances("gpuShared")));
    o.Append(",\"thermal\":").Append(Pairs(Instances("thermal")));
    o.Append(",\"energy\":").Append(Pairs(Instances("energy")));
    o.Append(",\"battery\":").Append(battery);
    o.Append(",\"nvidia\":").Append(Nvidia(engines));
    o.Append('}');
    return o.ToString();
  }

  public static void Run(int samples) {
    var stdout = Console.Out;
    // WMI's first query takes a few hundred milliseconds to connect: read the
    // battery beside the first samples rather than before them.
    new System.Threading.Thread(() => { battery = Battery(); }) { IsBackground = true }.Start();
    // A first line before the performance counters, which take ~200 ms to add:
    // processes, memory, disks and network show at once, CPU from the OS's
    // own times, the rest a moment later.
    stdout.WriteLine(Line()); stdout.Flush();
    PdhOpenQueryW(null, IntPtr.Zero, out query);
    // Task Manager's CPU figure: utility (work done at the actual clock), not time busy.
    AddCounter("cpu", @"\Processor Information(*)\% Processor Utility");
    // Time busy, total and per logical processor (Task Manager's figure since
    // Windows 11 24H2), and the kernel's share of it, to split user and system.
    AddCounter("cpuPrivileged", @"\Processor Information(_Total)\% Privileged Time");
    AddCounter("cpuTime", @"\Processor Information(*)\% Processor Time");
    AddCounter("gpu", @"\GPU Engine(*)\Utilization Percentage");
    AddCounter("gpuDedicated", @"\GPU Adapter Memory(*)\Dedicated Usage");
    AddCounter("gpuShared", @"\GPU Adapter Memory(*)\Shared Usage");
    // Task Manager's "Speed": the base clock scaled by the performance counter.
    AddCounter("cpuPerf", @"\Processor Information(_Total)\% Processor Performance");
    AddCounter("cpuBase", @"\Processor Information(_Total)\Processor Frequency");
    AddCounter("thermal", @"\Thermal Zone Information(*)\Temperature");
    AddCounter("energy", @"\Energy Meter(*)\Power");
    PdhCollectQueryData(query);
    FindGpus();
    // Counter rates need two readings; the first full sample follows shortly.
    System.Threading.Thread.Sleep(150);
    for (int tick = 0; samples <= 0 || tick < samples; tick++) {
      var started = Stopwatch.StartNew();
      PdhCollectQueryData(query);
      // The battery through WMI (~15 ms): every 10 s on battery, every 30 s on power.
      if (tick > 0 && tick % (battery.Contains("\"discharging\":true") ? 10 : 30) == 0) battery = Battery();
      stdout.WriteLine(Line()); stdout.Flush();
      int rest = 1000 - (int)started.ElapsedMilliseconds;
      if (rest > 0 && (samples <= 0 || tick + 1 < samples)) System.Threading.Thread.Sleep(rest);
    }
  }

}

// The helper's entry point. Samples once a second on stdout; each stdin line
// "program|png" asks for that program's icon, answered "icon|ok|program" or
// "icon|no|program". Exits when stdin closes, so it never outlives the app.
public static class PulseMain {
  public static void Main(string[] args) {
    var icons = new System.Threading.Thread(() => {
      string line;
      while ((line = Console.In.ReadLine()) != null) {
        var bar = line.IndexOf('|');
        if (bar < 0) continue;
        string source = line.Substring(0, bar), target = line.Substring(bar + 1);
        bool ok = Extract(source, target);
        Console.Out.WriteLine("icon|" + (ok ? "ok|" : "no|") + source); Console.Out.Flush();
      }
      Environment.Exit(0);
    });
    icons.IsBackground = true;
    icons.Start();
    PulseSampler.Run(0);
  }
  // Its own method, so System.Drawing loads with the first icon asked for.
  [System.Runtime.CompilerServices.MethodImpl(System.Runtime.CompilerServices.MethodImplOptions.NoInlining)]
  static bool Extract(string source, string target) {
    try {
      using (var icon = System.Drawing.Icon.ExtractAssociatedIcon(source))
      using (var bitmap = icon.ToBitmap()) { bitmap.Save(target, System.Drawing.Imaging.ImageFormat.Png); return true; }
    } catch { return false; }
  }
}
