# TunnelVision helper. Runs elevated, started by the "TunnelVision Connect" / "TunnelVision Stop"
# scheduled tasks that Setup-TunnelVision.ps1 registers. Installed to %ProgramFiles%\TunnelVision
# (admin-only writable). Do not run by hand.
#
# Everything read from %LOCALAPPDATA%\TunnelVision is user-writable, so it is treated as untrusted:
# ids, host, port, username and cert are validated, and openconnect's path/script come only from
# config.json next to this file.
[CmdletBinding()]
param([Parameter(Mandatory = $true)][ValidateSet('Connect', 'Stop')][string]$Mode)

$ErrorActionPreference = 'Stop'
$InstallDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Config = Get-Content -LiteralPath (Join-Path $InstallDir 'config.json') -Raw | ConvertFrom-Json

$Data     = Join-Path $env:LOCALAPPDATA 'TunnelVision'
$Req      = Join-Path $Data 'requests'
$Run      = Join-Path $Data 'run'
$Logs     = Join-Path $Data 'logs'
$Profiles = Join-Path $Data 'profiles'
foreach ($d in $Req, $Run, $Logs, $Profiles) { New-Item -ItemType Directory -Force -Path $d | Out-Null }

$IdRe   = '^[A-Za-z0-9-]{1,64}$'
$HostRe = '^(?:[A-Za-z0-9.-]{1,253}|\[[0-9A-Fa-f:.]{2,45}\])$'
$UserRe = '^[^\x00-\x1f]{1,256}$'
$CertRe = '^(?:pin-sha256:[A-Za-z0-9+/]{43}=|sha256:[0-9A-Fa-f]{64}|[0-9A-Fa-f]{64})$'

# Take one request file of the given kind; renaming makes it safe with parallel task instances.
function Claim([string]$Kind) {
    $files = Get-ChildItem -LiteralPath $Req -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Extension -eq ".$Kind" } | Sort-Object LastWriteTime
    foreach ($f in $files) {
        $id = [IO.Path]::GetFileNameWithoutExtension($f.Name)
        $claimed = Join-Path $Req ("{0}-{1}.claimed" -f $PID, [guid]::NewGuid())
        try { Move-Item -LiteralPath $f.FullName -Destination $claimed -ErrorAction Stop } catch { continue }
        Remove-Item -LiteralPath $claimed -Force -ErrorAction SilentlyContinue
        if ($id -match $IdRe) { return $id }
    }
    return $null
}

function Write-Log([string]$LogPath, [string]$Message) {
    # Share read/write: the Connect instance keeps this file open while openconnect runs.
    $fs = New-Object IO.FileStream($LogPath, [IO.FileMode]::Append, [IO.FileAccess]::Write, [IO.FileShare]'ReadWrite, Delete')
    try {
        $b = [Text.Encoding]::UTF8.GetBytes("[TunnelVision] $Message`r`n")
        $fs.Write($b, 0, $b.Length)
    } finally { $fs.Dispose() }
}

function Get-TunnelProcess([string]$PidFile) {
    if (-not (Test-Path -LiteralPath $PidFile)) { return $null }
    $n = 0
    if (-not [int]::TryParse((Get-Content -LiteralPath $PidFile -Raw).Trim(), [ref]$n)) { return $null }
    $p = Get-Process -Id $n -ErrorAction SilentlyContinue
    if ($p -and $p.ProcessName -eq 'openconnect') { return $p }
    return $null
}

if ($Mode -eq 'Stop') {
    # Ctrl+C makes openconnect log out of the FortiGate before exiting. A hard kill leaves the
    # session open on the gateway until its idle timeout, which breaks the next connect.
    Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;

public static class TvStop {
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AttachConsole(uint pid);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool FreeConsole();
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetConsoleCtrlHandler(IntPtr handler, bool add);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GenerateConsoleCtrlEvent(uint ctrlEvent, uint group);

    public static string Stop(int pid, int graceMs) {
        Process p;
        try { p = Process.GetProcessById(pid); } catch { return "already stopped"; }
        bool sent = false;
        FreeConsole();
        if (AttachConsole((uint)pid)) {
            SetConsoleCtrlHandler(IntPtr.Zero, true);   // don't let the Ctrl+C stop this helper
            sent = GenerateConsoleCtrlEvent(0, 0);      // CTRL_C_EVENT to openconnect's console
            Thread.Sleep(300);
            FreeConsole();
        }
        if (sent && p.WaitForExit(graceMs)) return "logged out cleanly";
        try { p.Kill(); p.WaitForExit(5000); } catch { }
        return sent ? "forced stop (no exit after Ctrl+C)" : "forced stop (could not send Ctrl+C)";
    }
}
'@
    while ($id = Claim 'stop') {
        if ($id -eq 'all') {
            $pidFiles = Get-ChildItem -LiteralPath $Run -Filter '*.pid' -File -ErrorAction SilentlyContinue
        } else {
            $pidFiles = @(Get-Item -LiteralPath (Join-Path $Run "$id.pid") -ErrorAction SilentlyContinue)
        }
        foreach ($pf in $pidFiles) {
            if (-not $pf) { continue }
            $p = Get-TunnelProcess $pf.FullName
            if (-not $p) { continue }
            $result = [TvStop]::Stop($p.Id, 10000)
            $pfId = [IO.Path]::GetFileNameWithoutExtension($pf.Name)
            if ($pfId -match $IdRe) {
                try { Write-Log (Join-Path $Logs "$pfId.log") "disconnect: $result" } catch { }
            }
        }
    }
    exit 0
}

# ---- Connect: handle exactly one request, then stay alive while openconnect runs ----
$id = Claim 'connect'
if (-not $id) { exit 0 }
$log = Join-Path $Logs "$id.log"
$pidFile = Join-Path $Run "$id.pid"

function Fail([string]$Message) {
    Write-Log $log "ERROR: $Message"
    Write-Log $log 'helper exited (code -1)'
    exit 1
}

if (Get-TunnelProcess $pidFile) { Fail 'This profile is already connected' }

try {
    $prof = Get-Content -LiteralPath (Join-Path $Profiles "$id.json") -Raw | ConvertFrom-Json
} catch { Fail 'Profile settings not found' }

$gw   = [string]$prof.host
$port = [string]$prof.port
$user = [string]$prof.username
$cert = [string]$prof.trustedCert
if ($gw -notmatch $HostRe) { Fail 'Invalid gateway' }
if ($port -notmatch '^\d{1,5}$' -or [int]$port -lt 1 -or [int]$port -gt 65535) { Fail 'Invalid port' }
if ($user -notmatch $UserRe) { Fail 'Invalid username' }
if ($cert) {
    if ($cert -notmatch $CertRe) { Fail 'Invalid trusted certificate fingerprint' }
    if ($cert -match '^[0-9A-Fa-f]{64}$') { $cert = 'sha256:' + $cert.ToLower() }
}

$exe = [string]$Config.OpenConnect
if (-not $exe -or -not (Test-Path -LiteralPath $exe)) { Fail "openconnect.exe not found at '$exe' - re-run Setup-TunnelVision.ps1" }

try {
    $sec = (Get-Content -LiteralPath (Join-Path $Profiles "$id.pw") -Raw).Trim() | ConvertTo-SecureString
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
    try { $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
} catch { Fail 'Could not read the saved password - enter it again in the button settings' }

$ocArgs = @('--protocol=fortinet', '--non-inter', '--passwd-on-stdin', '--user', $user)
if ($cert) { $ocArgs += @('--servercert', $cert) }
if ($Config.Script) { $ocArgs += @('--script', [string]$Config.Script) }
$ocArgs += ('https://{0}:{1}/' -f $gw, $port)

Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.Diagnostics;
using System.IO;
using System.Text;

public static class TvRunner {
    static string Quote(string a) {
        if (a.Length > 0 && a.IndexOfAny(new[] { ' ', '\t', '"' }) < 0) return a;
        var sb = new StringBuilder("\"");
        int bs = 0;
        foreach (char c in a) {
            if (c == '\\') { bs++; continue; }
            if (c == '"') { sb.Append('\\', bs * 2 + 1); sb.Append('"'); bs = 0; continue; }
            sb.Append('\\', bs); bs = 0; sb.Append(c);
        }
        sb.Append('\\', bs * 2);
        sb.Append('"');
        return sb.ToString();
    }

    public static int Run(string exe, string[] args, string password, string logPath, string pidPath) {
        var parts = new string[args.Length];
        for (int i = 0; i < args.Length; i++) parts[i] = Quote(args[i]);
        var psi = new ProcessStartInfo(exe, string.Join(" ", parts));
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        psi.RedirectStandardInput = true;
        psi.RedirectStandardOutput = true;
        psi.RedirectStandardError = true;
        psi.StandardOutputEncoding = Encoding.UTF8;
        psi.StandardErrorEncoding = Encoding.UTF8;
        psi.WorkingDirectory = Path.GetDirectoryName(exe);

        var fs = new FileStream(logPath, FileMode.Append, FileAccess.Write, FileShare.ReadWrite | FileShare.Delete);
        var w = new StreamWriter(fs, new UTF8Encoding(false));
        w.AutoFlush = true;
        object gate = new object();
        DataReceivedEventHandler h = (s, e) => { if (e.Data != null) lock (gate) { w.WriteLine(e.Data); } };

        var p = new Process();
        p.StartInfo = psi;
        p.OutputDataReceived += h;
        p.ErrorDataReceived += h;
        p.Start();
        File.WriteAllText(pidPath, p.Id.ToString());
        p.BeginOutputReadLine();
        p.BeginErrorReadLine();

        var bytes = Encoding.UTF8.GetBytes(password + "\n");
        p.StandardInput.BaseStream.Write(bytes, 0, bytes.Length);
        p.StandardInput.BaseStream.Flush();
        p.StandardInput.Close();
        Array.Clear(bytes, 0, bytes.Length);

        p.WaitForExit();
        int code = p.ExitCode;
        lock (gate) { w.WriteLine("[TunnelVision] openconnect exited (code " + code + ")"); }
        w.Dispose();
        return code;
    }
}
'@

try {
    $code = [TvRunner]::Run($exe, [string[]]$ocArgs, $plain, $log, $pidFile)
} catch {
    Fail ("Could not start openconnect: " + $_.Exception.Message)
} finally {
    $plain = $null
    Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
}
exit $code
