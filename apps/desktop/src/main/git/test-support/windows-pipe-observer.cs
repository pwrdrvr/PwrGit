// Built with Windows PowerShell's framework compiler. No downloaded binaries,
// elevation, command-line capture, or changes to the observed process.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Management;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;

public class PipeObserver {
  static readonly object Gate = new object();
  static readonly Dictionary<int, Dictionary<string, object>> Starts = new Dictionary<int, Dictionary<string, object>>();
  static readonly Dictionary<int, Dictionary<string, object>> Stops = new Dictionary<int, Dictionary<string, object>>();
  static readonly HashSet<int> Known = new HashSet<int>();
  static readonly HashSet<int> Reported = new HashSet<int>();
  static StreamWriter Log;
  static int Root;
  static int Self;
  static string DirectoryPath;
  static string Exe;
  static readonly Stopwatch Clock = Stopwatch.StartNew();

  static string Hash(string value) { using (var sha = SHA256.Create()) { return BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(value))).Replace("-", "").Substring(0, 16).ToLowerInvariant(); } }
  static string Json(object value) {
    if (value == null) return "null";
    if (value is string) {
      var b = new StringBuilder("\"");
      foreach (char c in (string)value) { if (c == '"' || c == '\\') b.Append('\\').Append(c); else if (c < 32) b.Append("\\u").Append(((int)c).ToString("x4")); else b.Append(c); }
      return b.Append('"').ToString();
    }
    if (value is bool) return (bool)value ? "true" : "false";
    var dictionary = value as IDictionary;
    if (dictionary != null) { var parts = new List<string>(); foreach (DictionaryEntry entry in dictionary) parts.Add(Json(entry.Key.ToString()) + ":" + Json(entry.Value)); return "{" + String.Join(",", parts.ToArray()) + "}"; }
    var list = value as IEnumerable;
    if (list != null) { var parts = new List<string>(); foreach (object item in list) parts.Add(Json(item)); return "[" + String.Join(",", parts.ToArray()) + "]"; }
    return Convert.ToString(value, CultureInfo.InvariantCulture);
  }
  static Dictionary<string, object> Row(string name) { return new Dictionary<string, object> { { "event", name }, { "observedUtc", DateTime.UtcNow.ToString("O") }, { "observerElapsedMs", Clock.Elapsed.TotalMilliseconds } }; }
  static void Emit(Dictionary<string, object> row) { lock (Gate) { try { Log.WriteLine(Json(row)); Log.Flush(); } catch (ObjectDisposedException) { } } }
  static string SafeName(string name) {
    string lower = name.ToLowerInvariant();
    string allowed = "|git.exe|git-lfs.exe|node.exe|cmd.exe|sh.exe|bash.exe|ssh.exe|gpg.exe|git-remote-http.exe|git-remote-https.exe|git-credential-manager.exe|powershell.exe|";
    return allowed.Contains("|" + lower + "|") ? lower : "other:" + Hash(name);
  }
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool QueryFullProcessImageName(IntPtr handle, uint flags, StringBuilder name, ref uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr handle, out long creation, out long exit, out long kernel, out long user);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr source, IntPtr targetProcess, out IntPtr target, uint access, bool inherit, uint options);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint GetFileType(IntPtr handle);
  [DllImport("ntdll.dll")] static extern int NtQueryObject(IntPtr handle, int kind, IntPtr buffer, int size, out int needed);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetNamedPipeInfo(IntPtr handle, out uint flags, out uint outputSize, out uint inputSize, out uint instances);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetNamedPipeClientProcessId(IntPtr handle, out uint pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetNamedPipeServerProcessId(IntPtr handle, out uint pid);
  [DllImport("ntdll.dll")] static extern int NtQuerySystemInformation(int kind, IntPtr buffer, int size, out int needed);
  [StructLayout(LayoutKind.Sequential)] struct HandleEntry {
    public IntPtr Object; public UIntPtr Pid; public UIntPtr Handle;
    public uint Access; public ushort Backtrace; public ushort Type;
    public uint Attributes; public uint Reserved;
  }
  [StructLayout(LayoutKind.Sequential)] struct UnicodeString { public ushort Length; public ushort MaximumLength; public IntPtr Buffer; }
  static void Image(int pid, Dictionary<string, object> row) {
    IntPtr process = OpenProcess(0x1000, false, pid);
    if (process == IntPtr.Zero) { row["imageStatus"] = "unavailable"; return; }
    try {
      long creation, exit, kernel, user;
      if (GetProcessTimes(process, out creation, out exit, out kernel, out user)) {
        string created = DateTime.FromFileTimeUtc(creation).ToString("O");
        row["queriedCreationUtc"] = created;
        if (row.ContainsKey("eventUtc") && String.CompareOrdinal(created, (string)row["eventUtc"]) > 0) { row["imageStatus"] = "pid-reused-since-event"; return; }
      }
      uint length = 32768; var path = new StringBuilder((int)length);
      if (!QueryFullProcessImageName(process, 0, path, ref length)) { row["imageStatus"] = "unavailable"; return; }
      string full = path.ToString().Replace('\\', '/');
      row["imageId"] = Hash(full.ToLowerInvariant()); row["queriedBinary"] = SafeName(Path.GetFileName(full));
      string[] layouts = { "/Git/cmd/git.exe", "/Git/mingw64/bin/git.exe", "/Git/bin/git.exe", "/Git/usr/bin/sh.exe", "/Git/mingw64/bin/git-lfs.exe" };
      foreach (string layout in layouts) if (full.EndsWith(layout, StringComparison.OrdinalIgnoreCase)) row["gitInstallationPath"] = layout.Substring(1);
      row["imageStatus"] = "queried";
    } finally { CloseHandle(process); }
  }
  static void PublishKnown() {
    bool changed;
    do {
      changed = false;
      foreach (var pair in Starts) {
        int parent = (int)pair.Value["ppid"];
        if (Starts.ContainsKey(parent) && String.CompareOrdinal((string)Starts[parent]["eventUtc"], (string)pair.Value["eventUtc"]) > 0) continue;
        if (Stops.ContainsKey(parent) && String.CompareOrdinal((string)Stops[parent]["eventUtc"], (string)pair.Value["eventUtc"]) < 0) continue;
        if (pair.Key != Self && Known.Contains(parent) && Known.Add(pair.Key)) changed = true;
      }
    } while (changed && Known.Count < 4096);
    foreach (var pair in Starts) {
      if (!Known.Contains(pair.Key) || !Reported.Add(pair.Key)) continue;
      Emit(pair.Value);
      if (Stops.ContainsKey(pair.Key)) Emit(Stops[pair.Key]);
    }
  }
  static void ProcessEvent(EventArrivedEventArgs args, bool start) {
    try {
      var e = args.NewEvent;
      int pid = Convert.ToInt32(e["ProcessID"]);
      var row = Row(start ? "process-start" : "process-stop");
      row["pid"] = pid;
      row["eventUtc"] = DateTime.FromFileTimeUtc(Convert.ToInt64(e["TIME_CREATED"])).ToString("O");
      row["binary"] = SafeName(Convert.ToString(e["ProcessName"]));
      if (start) { row["ppid"] = Convert.ToInt32(e["ParentProcessID"]); Image(pid, row); }
      else row["exitStatus"] = Convert.ToUInt32(e["ExitStatus"]);
      lock (Gate) {
        if (start && Starts.Count >= 4096) {
          // Other Vitest workers also launch thousands of processes. Keep the
          // live related tree; bound cached unrelated/out-of-order events.
          var remove = new List<int>();
          foreach (int cached in Starts.Keys) if (!Known.Contains(cached) || Stops.ContainsKey(cached)) remove.Add(cached);
          foreach (int cached in remove) { Starts.Remove(cached); Stops.Remove(cached); Known.Remove(cached); Reported.Remove(cached); }
          var pruned = Row("process-cache-pruned"); pruned["removed"] = remove.Count; Emit(pruned);
          if (Starts.Count >= 4096) return;
        }
        if (start) {
          Starts[pid] = row;
          if (pid != Root) Known.Remove(pid);
          if (Stops.ContainsKey(pid) && String.CompareOrdinal((string)Stops[pid]["eventUtc"], (string)row["eventUtc"]) < 0) Stops.Remove(pid);
          Reported.Remove(pid); PublishKnown();
        }
        else { if (Starts.ContainsKey(pid) || Stops.Count < 4096) Stops[pid] = row; if (Known.Contains(pid)) Emit(row); }
      }
    } catch { Emit(Row("process-event-unavailable")); }
  }
  static void Handles(string[] ids) {
    var wanted = new HashSet<ulong>(); foreach (string id in ids) wanted.Add(UInt64.Parse(id));
    int size = 1024 * 1024, needed, status;
    IntPtr table = IntPtr.Zero;
    try {
      while (true) {
        table = Marshal.AllocHGlobal(size);
        status = NtQuerySystemInformation(64, table, size, out needed);
        if (status == 0) break;
        Marshal.FreeHGlobal(table); table = IntPtr.Zero;
        if (status != unchecked((int)0xc0000004) || size >= 32 * 1024 * 1024) { Console.WriteLine(Json(new Dictionary<string, object> { { "status", "handle-table-unavailable" }, { "ntstatus", status } })); return; }
        size = Math.Min(32 * 1024 * 1024, Math.Max(size * 2, needed));
      }
      long count = Marshal.ReadIntPtr(table).ToInt64();
      int stride = Marshal.SizeOf(typeof(HandleEntry));
      count = Math.Min(count, (size - IntPtr.Size * 2) / stride);
      var rows = new List<object>(); int denied = 0, failedNames = 0;
      var budget = Stopwatch.StartNew();
      for (long i = 0; i < count && rows.Count < 256 && budget.ElapsedMilliseconds < 500; i++) {
        var entry = (HandleEntry)Marshal.PtrToStructure(IntPtr.Add(table, checked(IntPtr.Size * 2 + (int)i * stride)), typeof(HandleEntry));
        if (!wanted.Contains(entry.Pid.ToUInt64())) continue;
        int pid = checked((int)entry.Pid.ToUInt64());
        IntPtr source = OpenProcess(0x40, false, pid);
        if (source == IntPtr.Zero) { denied++; continue; }
        IntPtr handle = IntPtr.Zero;
        try {
          if (!DuplicateHandle(source, new IntPtr(unchecked((long)entry.Handle.ToUInt64())), GetCurrentProcess(), out handle, 0, false, 2)) { denied++; continue; }
          if (GetFileType(handle) != 3) continue; // FILE_TYPE_PIPE only; never query arbitrary filenames.
          var row = new Dictionary<string, object> { { "pid", pid }, { "handle", entry.Handle.ToUInt64() }, { "accessMask", entry.Access }, { "writeDataAccess", (entry.Access & 2) != 0 }, { "objectId", Hash(entry.Object.ToString()) } };
          Image(pid, row);
          IntPtr name = Marshal.AllocHGlobal(4096);
          try {
            // FileNameInfo's public API excludes pipes. Query the native
            // object's name only after FILE_TYPE_PIPE, in this disposable
            // process: a name query can block on a pending synchronous read.
            int nameNeeded;
            int nameStatus = NtQueryObject(handle, 1, name, 4096, out nameNeeded);
            if (nameStatus == 0) {
              var value = (UnicodeString)Marshal.PtrToStructure(name, typeof(UnicodeString));
              long offset = value.Buffer.ToInt64() - name.ToInt64();
              if (value.Length > 0 && offset >= 0 && offset + value.Length <= 4096) row["pipeId"] = Hash(Marshal.PtrToStringUni(value.Buffer, value.Length / 2).ToLowerInvariant());
            } else { failedNames++; row["nameNtStatus"] = nameStatus; }
          } finally { Marshal.FreeHGlobal(name); }
          uint flags, output, input, instances, peer;
          if (GetNamedPipeInfo(handle, out flags, out output, out input, out instances)) row["endpoint"] = (flags & 1) != 0 ? "server" : "client";
          if (GetNamedPipeClientProcessId(handle, out peer)) row["clientPid"] = peer;
          if (GetNamedPipeServerProcessId(handle, out peer)) row["serverPid"] = peer;
          rows.Add(row);
        } finally { if (handle != IntPtr.Zero) CloseHandle(handle); CloseHandle(source); }
      }
      Console.WriteLine(Json(new Dictionary<string, object> { { "status", "sampled" }, { "handles", rows }, { "accessFailures", denied }, { "nameFailures", failedNames }, { "scanMs", budget.ElapsedMilliseconds }, { "limited", rows.Count >= 256 || budget.ElapsedMilliseconds >= 500 } }));
    } finally { if (table != IntPtr.Zero) Marshal.FreeHGlobal(table); }
  }
  static void Inspect(string call, string phase, int pid) {
    var ids = new List<string> { Root.ToString() };
    if (phase != "baseline") {
      lock (Gate) { foreach (int known in Known) if (known != Self && known != Root && !Stops.ContainsKey(known) && ids.Count < 64) ids.Add(known.ToString()); }
      if (pid > 0 && !ids.Contains(pid.ToString())) ids.Add(pid.ToString());
    }
    var result = Row("pipe-handle-sample"); result["callId"] = call; result["phase"] = phase;
    result["writerDuplicationPossible"] = true;
    result["scope"] = "root-and-observed-descendants-max64";
    var info = new ProcessStartInfo(Exe, "handles " + String.Join(" ", ids.ToArray()));
    info.UseShellExecute = false; info.RedirectStandardOutput = true; info.RedirectStandardError = true; info.CreateNoWindow = true;
    using (var process = new Process()) {
      process.StartInfo = info; var output = new StringBuilder();
      process.OutputDataReceived += delegate(object sender, DataReceivedEventArgs data) { if (data.Data != null && output.Length < 128 * 1024) output.Append(data.Data); };
      process.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs data) { };
      process.Start(); process.BeginOutputReadLine(); process.BeginErrorReadLine();
      if (!process.WaitForExit(900)) { process.Kill(); process.WaitForExit(500); result["status"] = "inspector-timeout"; }
      else { process.WaitForExit(); result["status"] = "inspector-finished"; result["inspectorExitCode"] = process.ExitCode; result["sampleJson"] = output.ToString(); }
      result["inspectorPid"] = process.Id;
    }
    Emit(result);
  }
  public static int Main(string[] args) {
    if (args.Length > 0 && args[0] == "handles") {
      // Also bound this process if its observer disappears during a native
      // filename query. Exiting releases every duplicated handle.
      using (var deadline = new Timer(delegate(object state) { Environment.Exit(124); }, null, 1500, Timeout.Infinite)) {
        Handles(new List<string>(args).GetRange(1, args.Length - 1).ToArray()); return 0;
      }
    }
    Root = Int32.Parse(args[0]); DirectoryPath = args[1]; Exe = args[2]; Self = Process.GetCurrentProcess().Id;
    Known.Add(Root);
    Log = new StreamWriter(Path.Combine(DirectoryPath, "windows-processes.jsonl"), true, new UTF8Encoding(false));
    var root = Row("observed-root"); root["pid"] = Root; Image(Root, root); Emit(root);
    using (var starts = new ManagementEventWatcher(new WqlEventQuery("SELECT * FROM Win32_ProcessStartTrace")))
    using (var stops = new ManagementEventWatcher(new WqlEventQuery("SELECT * FROM Win32_ProcessStopTrace"))) {
      starts.EventArrived += delegate(object sender, EventArrivedEventArgs e) { ProcessEvent(e, true); };
      stops.EventArrived += delegate(object sender, EventArrivedEventArgs e) { ProcessEvent(e, false); };
      try { starts.Start(); stops.Start(); Emit(Row("process-subscriptions-ready")); }
      catch { Emit(Row("process-subscriptions-unavailable")); }
      File.WriteAllText(Path.Combine(DirectoryPath, "ready"), "ready");
      var lifetime = Stopwatch.StartNew();
      while (!File.Exists(Path.Combine(DirectoryPath, "stop")) && lifetime.Elapsed.TotalMinutes < 10) {
        foreach (string request in System.IO.Directory.GetFiles(DirectoryPath, "request-*")) {
          if (File.Exists(Path.Combine(DirectoryPath, "stop"))) break;
          if (request.EndsWith(".tmp", StringComparison.Ordinal)) continue;
          try {
            string[] fields = File.ReadAllText(request).Split('\t');
            if (fields.Length != 3) continue;
            File.Delete(request);
            Inspect(fields[0], fields[1], Int32.Parse(fields[2]));
          } catch { Emit(Row("handle-inspection-unavailable")); }
        }
        Thread.Sleep(10);
      }
      try { starts.Stop(); stops.Stop(); } catch { }
    }
    Log.Dispose(); return 0;
  }
}
