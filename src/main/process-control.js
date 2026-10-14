const { execFile } = require('child_process');
const paused = new Map();
const pending = new Map();

// Use the documented Win32 thread APIs; Suspend-Process is not a built-in PowerShell cmdlet.
// https://learn.microsoft.com/windows/win32/api/processthreadsapi/nf-processthreadsapi-suspendthread
const windowsSource = `
using System;
using System.Diagnostics;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class BiodlProcessControl {
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenThread(uint access, bool inherit, uint id);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint SuspendThread(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr handle);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  public static int[] Suspend(int pid) {
    var handles = new List<IntPtr>(); var ids = new List<int>();
    try {
      using (var process = Process.GetProcessById(pid)) {
        // Re-enumerate until no unsuspended threads remain (threads can start during the first pass).
        for (int pass=0; pass<10; pass++) {
          int added=0; process.Refresh();
          foreach (ProcessThread thread in process.Threads) {
            if (ids.Contains(thread.Id)) continue;
            IntPtr handle=OpenThread(2, false, (uint)thread.Id);
            if (handle==IntPtr.Zero) throw new System.ComponentModel.Win32Exception();
            if (SuspendThread(handle)==UInt32.MaxValue) { CloseHandle(handle); throw new System.ComponentModel.Win32Exception(); }
            handles.Add(handle); ids.Add(thread.Id); added++;
          }
          if (added==0) return ids.ToArray();
        }
        throw new Exception("Process threads did not settle");
      }
    } catch { foreach(var handle in handles) ResumeThread(handle); throw; }
    finally { foreach(var handle in handles) CloseHandle(handle); }
  }
  public static void Resume(int pid, int[] ids) {
    using (var process=Process.GetProcessById(pid)) {
      var live=new HashSet<int>(); foreach(ProcessThread t in process.Threads) live.Add(t.Id);
      foreach(int id in ids) {
        if (!live.Contains(id)) continue;
        IntPtr handle=OpenThread(2, false, (uint)id);
        if(handle==IntPtr.Zero) throw new System.ComponentModel.Win32Exception();
        try { if(ResumeThread(handle)==UInt32.MaxValue) throw new System.ComponentModel.Win32Exception(); }
        finally { CloseHandle(handle); }
      }
    }
  }
}`;

function runWindows(pid, suspend, ids) {
  const call = suspend
    ? `[BiodlProcessControl]::Suspend(${pid}) | ConvertTo-Json -Compress`
    : `[BiodlProcessControl]::Resume(${pid}, [int[]]@(${ids.join(',')}))`;
  const script = `$ErrorActionPreference='Stop'\nAdd-Type -TypeDefinition @'\n${windowsSource}\n'@\n${call}`;
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { windowsHide: true, timeout: 15000 }, (error, stdout) => {
        if (error) return reject(error);
        resolve(suspend ? [].concat(JSON.parse(stdout.trim() || '[]')) : []);
      });
  });
}

function controlProcess(proc, suspend) {
  if (!proc || proc.killed || !Number.isSafeInteger(proc.pid) || proc.pid <= 0) return Promise.resolve(false);
  const pid = proc.pid;
  const operation = (pending.get(pid) || Promise.resolve()).catch(() => {}).then(async () => {
    if (suspend === paused.has(pid)) return true;
    if (process.platform === 'win32') {
      const ids = await runWindows(pid, suspend, paused.get(pid) || []);
      if (suspend && !ids.length) throw new Error('No process threads suspended');
      if (suspend) paused.set(pid, ids); else paused.delete(pid);
    } else {
      process.kill(pid, suspend ? 'SIGSTOP' : 'SIGCONT');
      if (suspend) paused.set(pid, []); else paused.delete(pid);
    }
    return true;
  });
  pending.set(pid, operation);
  operation.finally(() => { if (pending.get(pid) === operation) pending.delete(pid); }).catch(() => {});
  if (!proc.__biodlControlHook) {
    proc.__biodlControlHook = true;
    proc.once('exit', () => { paused.delete(pid); pending.delete(pid); });
  }
  return operation;
}

module.exports = { controlProcess };
