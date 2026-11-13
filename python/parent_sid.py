"""Which Claude session launched each headless run (patch 93).

  python parent_sid.py <pid>:<own sid> [<pid>:<own sid> ...]   ->  {"<pid>": "<parent sid>" | null, ...}

Every Bash/PowerShell call a session makes carries CLAUDE_CODE_SESSION_ID in its environment, and every
process below it inherits it -- through a detached launcher whose shell has long exited, through a python
pipeline that strips the walker's own environment. So walk up from the run, live process by live process,
and read each one's environment block; the first CLAUDE_CODE_SESSION_ID that is not the run's own sid is
the session that launched it. Stops at a dead link or a parent younger than its child (a reused pid).
Windows x64 only; any process that cannot be read is skipped, never guessed.
"""
import ctypes, json, sys
from ctypes import wintypes as W

k32, ntdll = ctypes.WinDLL("kernel32", use_last_error=True), ctypes.WinDLL("ntdll")
k32.OpenProcess.restype = W.HANDLE
k32.ReadProcessMemory.argtypes = [W.HANDLE, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_size_t, ctypes.POINTER(ctypes.c_size_t)]
k32.GetProcessTimes.argtypes = [W.HANDLE] + [ctypes.POINTER(W.FILETIME)] * 4
k32.CloseHandle.argtypes = [W.HANDLE]
VAR = "CLAUDE_CODE_SESSION_ID="


class PBI(ctypes.Structure):
    _fields_ = [("ExitStatus", ctypes.c_void_p), ("Peb", ctypes.c_void_p), ("Affinity", ctypes.c_void_p),
                ("BasePriority", ctypes.c_void_p), ("Pid", ctypes.c_void_p), ("ParentPid", ctypes.c_void_p)]


def read(h, addr, n):
    buf, got = ctypes.create_string_buffer(n), ctypes.c_size_t()
    if not k32.ReadProcessMemory(h, ctypes.c_void_p(addr), buf, n, ctypes.byref(got)) or got.value != n:
        raise OSError("read")
    return buf.raw


def inspect(pid):
    """(parent pid, creation time, session id in its environment or None); None if unreadable."""
    h = k32.OpenProcess(0x0400 | 0x0010, False, pid)  # QUERY_INFORMATION | VM_READ
    if not h:
        return None
    try:
        pbi = PBI()
        if ntdll.NtQueryInformationProcess(h, 0, ctypes.byref(pbi), ctypes.sizeof(pbi), None) != 0:
            return None
        t = [W.FILETIME() for _ in range(4)]
        k32.GetProcessTimes(h, *[ctypes.byref(x) for x in t])
        created = (t[0].dwHighDateTime << 32) | t[0].dwLowDateTime
        sid = None
        try:
            params = int.from_bytes(read(h, pbi.Peb + 0x20, 8), "little")  # PEB.ProcessParameters
            env = int.from_bytes(read(h, params + 0x80, 8), "little")      # RTL_USER_PROCESS_PARAMETERS.Environment
            size = int.from_bytes(read(h, params + 0x3F0, 8), "little")    # .EnvironmentSize
            for v in read(h, env, min(size, 1 << 20)).decode("utf-16-le", "replace").split("\0"):
                if v.upper().startswith(VAR):
                    sid = v[len(VAR):].strip() or None
        except OSError:
            pass
        return (pbi.ParentPid or 0), created, sid
    finally:
        k32.CloseHandle(h)


def parent_of(pid, own):
    child_created = None
    for _ in range(16):
        info = inspect(pid)
        if not info:
            return None
        ppid, created, sid = info
        if child_created is not None and created > child_created:
            return None  # pid reused by a younger process: the real parent is gone
        if sid and sid != own:
            return sid
        pid, child_created = ppid, created
        if not pid:
            return None
    return None


if __name__ == "__main__":
    out = {}
    for a in sys.argv[1:]:
        pid, _, own = a.partition(":")
        try:
            out[pid] = parent_of(int(pid), own)
        except Exception:
            out[pid] = None
    print(json.dumps(out))
