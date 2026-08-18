#Requires -Version 5.1
<#
relay.ps1 — multica-relay (WISP v1) for Windows, self-contained.

The complete relay lives in this one file: PowerShell plus the .NET
Framework Windows 10+ already ships (HttpListener, System.Net.WebSockets,
TcpClient, UdpClient). No compiled binary, no second download, no package
manager. relay.py is the macOS/Linux sibling implementing the same
contract; tests/relay-conformance.mjs is the parity gate between the two.

This relay is an unauthenticated outbound TCP/UDP proxy: anything that can
open a WebSocket to it can make this machine dial arbitrary hosts and
ports (that is its whole job — it is what gives a v86 guest, which cannot
open raw sockets from a browser tab, real internet access). The only two
things standing between "the guest in your own tab" and "anyone else" are
the listen address and the Origin check below; both default to the
tightest setting that still lets the shipped page work.

Run (what the page's one-liner does):
  $env:MULTICA_RELAY_ORIGIN='https://owner.github.io'; irm <pages-url>/relay.ps1 | iex
Or from a saved file:
  powershell -File relay.ps1 -Listen 127.0.0.1:8086 -Origin https://owner.github.io
#>
param(
    [string]$Listen = "127.0.0.1:8086",
    [string[]]$Origin = @(),
    [switch]$AllowAnyOrigin
)

$ErrorActionPreference = "Stop"

# --- WISP constants ---------------------------------------------------------
$TYPE_CONNECT = 1
$TYPE_DATA = 2
$TYPE_CONTINUE = 3
$TYPE_CLOSE = 4
$INITIAL_BUFFER = [uint32]128
$CLOSE_INVALID_PAYLOAD = [byte]0x41
$CLOSE_CONNECT_FAILED = [byte]0x42
$CLOSE_GENERIC = [byte]0x02

# --- Origin allowlist (parity with relay.py) --------------------------------
# The "[::1]" entries never match under wildcard syntax ("[" opens a
# character class) — inherited verbatim from the previous implementations
# for default-for-default parity.
$DefaultOriginPatterns = @(
    "localhost", "localhost:*",
    "127.0.0.1", "127.0.0.1:*",
    "[::1]", "[::1]:*"
)

function Get-NormalizedOriginPattern([string]$Pattern) {
    $s = $Pattern.Trim() -replace '^[a-zA-Z][a-zA-Z0-9+.-]*://', ''
    return $s.TrimEnd('/')
}

function Test-OriginAllowed([string]$OriginHeader, [string[]]$Patterns) {
    # An absent Origin (a non-browser client) is allowed: this check exists
    # to stop OTHER websites in the same browser, and browsers always send
    # Origin. -like is a case-insensitive glob, matching relay.py's fnmatch.
    if ([string]::IsNullOrEmpty($OriginHeader)) { return $true }
    $bare = Get-NormalizedOriginPattern $OriginHeader
    foreach ($p in $Patterns) {
        if ($bare -like $p) { return $true }
    }
    return $false
}

$extraOrigins = @()
foreach ($o in $Origin) {
    foreach ($part in ($o -split ',')) {
        $n = Get-NormalizedOriginPattern $part
        if ($n) { $extraOrigins += $n }
    }
}
if ($env:MULTICA_RELAY_ORIGIN) {
    $n = Get-NormalizedOriginPattern $env:MULTICA_RELAY_ORIGIN
    if ($n) { $extraOrigins += $n }
}
if ($AllowAnyOrigin) {
    $OriginPatterns = @("*")
    Write-Warning "-AllowAnyOrigin is set: any website in any tab can use this relay as an unauthenticated proxy from this machine"
} else {
    $OriginPatterns = $DefaultOriginPatterns + $extraOrigins
}

# --- frame helpers ----------------------------------------------------------

function New-WispFrame([byte]$Type, [uint32]$StreamId, [byte[]]$Payload) {
    if ($null -eq $Payload) { $Payload = @() }
    $frame = New-Object byte[] (5 + $Payload.Length)
    $frame[0] = $Type
    [BitConverter]::GetBytes($StreamId).CopyTo($frame, 1)  # little-endian
    if ($Payload.Length) { [Array]::Copy($Payload, 0, $frame, 5, $Payload.Length) }
    return ,$frame
}

function Send-WsMessage($Session, [byte[]]$Bytes) {
    # Sends are serialized per session by waiting synchronously: keeps frame
    # order without a queue. Send errors mark the session dead.
    try {
        $segment = New-Object System.ArraySegment[byte] -ArgumentList @(,$Bytes)
        $Session.WebSocket.SendAsync(
            $segment,
            [System.Net.WebSockets.WebSocketMessageType]::Binary,
            $true,
            [System.Threading.CancellationToken]::None
        ).GetAwaiter().GetResult() | Out-Null
    } catch {
        $Session.Dead = $true
    }
}

function Close-WispStream($Session, [uint32]$StreamId, [byte]$Reason) {
    $stream = $Session.Streams[$StreamId]
    if ($null -ne $stream) {
        $Session.Streams.Remove($StreamId)
        try { $stream.Client.Close() } catch {}
    }
    Send-WsMessage $Session (New-WispFrame $TYPE_CLOSE $StreamId @($Reason))
}

function Open-WispStream($Session, [uint32]$StreamId, [byte[]]$Payload) {
    if ($Payload.Length -lt 4) {
        Close-WispStream $Session $StreamId $CLOSE_INVALID_PAYLOAD
        return
    }
    $streamType = $Payload[0]
    $port = [BitConverter]::ToUInt16($Payload, 1)
    $targetHost = [System.Text.Encoding]::UTF8.GetString($Payload, 3, $Payload.Length - 3)
    try {
        if ($streamType -eq 2) {
            $udp = New-Object System.Net.Sockets.UdpClient
            $udp.Connect($targetHost, $port)  # resolves the hostname relay-side
            $Session.Streams[$StreamId] = [pscustomobject]@{
                Kind = 'udp'; Client = $udp; NetStream = $null
                ReadBuffer = $null; ReadTask = $udp.ReceiveAsync()
            }
        } else {
            # Connect synchronously (parity: the Go and Python relays also
            # dial inline in their receive loop). A slow dial briefly stalls
            # the pump; acceptable for a localhost POC relay.
            $tcp = New-Object System.Net.Sockets.TcpClient
            $tcp.ConnectAsync($targetHost, $port).GetAwaiter().GetResult() | Out-Null
            $buffer = New-Object byte[] 32768
            $netStream = $tcp.GetStream()
            $Session.Streams[$StreamId] = [pscustomobject]@{
                Kind = 'tcp'; Client = $tcp; NetStream = $netStream
                ReadBuffer = $buffer; ReadTask = $netStream.ReadAsync($buffer, 0, $buffer.Length)
            }
        }
    } catch {
        Close-WispStream $Session $StreamId $CLOSE_CONNECT_FAILED
    }
}

function Invoke-WispMessage($Session, [byte[]]$MessageBytes) {
    if ($MessageBytes.Length -lt 5) { return }  # malformed frame: ignored
    $type = $MessageBytes[0]
    $streamId = [BitConverter]::ToUInt32($MessageBytes, 1)
    $payload = New-Object byte[] ($MessageBytes.Length - 5)
    if ($payload.Length) { [Array]::Copy($MessageBytes, 5, $payload, 0, $payload.Length) }
    switch ([int]$type) {
        1 { Open-WispStream $Session $streamId $payload }
        2 {
            $stream = $Session.Streams[$streamId]
            if ($null -eq $stream) { return }  # unknown stream: ignored
            try {
                if ($stream.Kind -eq 'udp') {
                    $stream.Client.Send($payload, $payload.Length) | Out-Null
                } else {
                    $stream.NetStream.Write($payload, 0, $payload.Length)
                }
                Send-WsMessage $Session (New-WispFrame $TYPE_CONTINUE $streamId ([BitConverter]::GetBytes($INITIAL_BUFFER)))
            } catch {
                Close-WispStream $Session $streamId $CLOSE_GENERIC
            }
        }
        4 { Close-WispStream $Session $streamId $CLOSE_GENERIC }
    }
}

function New-RelaySession($WebSocket) {
    $recvBuffer = New-Object byte[] 65536
    $session = [pscustomobject]@{
        WebSocket  = $WebSocket
        Streams    = @{}
        RecvBuffer = $recvBuffer
        RecvTask   = $null
        Message    = New-Object System.IO.MemoryStream
        Dead       = $false
    }
    $session.RecvTask = $WebSocket.ReceiveAsync(
        (New-Object System.ArraySegment[byte] -ArgumentList @(,$recvBuffer)),
        [System.Threading.CancellationToken]::None)
    return $session
}

# --- listener ---------------------------------------------------------------

$sep = $Listen.LastIndexOf(':')
if ($sep -lt 0) { throw "listen address must be host:port or :port" }
$ListenHost = $Listen.Substring(0, $sep)
$ListenPort = [int]$Listen.Substring($sep + 1)

$listener = New-Object System.Net.HttpListener
if ($ListenHost -eq '' -or $ListenHost -eq '0.0.0.0' -or $ListenHost -eq '+') {
    # All interfaces: reachable by your whole LAN, and http.sys requires an
    # elevated prompt for this prefix. Deliberate friction.
    $prefixes = @("http://+:$ListenPort/")
} elseif ($ListenHost -eq '127.0.0.1' -or $ListenHost -eq 'localhost') {
    # Loopback. Register both spellings: http.sys routes by Host header
    # (unlike a plain socket bind), and the page may use either
    # wisp://localhost:8086 or wisp://127.0.0.1:8086.
    $prefixes = @("http://localhost:$ListenPort/", "http://127.0.0.1:$ListenPort/")
} else {
    $prefixes = @("http://${ListenHost}:$ListenPort/")
}
foreach ($prefix in $prefixes) { $listener.Prefixes.Add($prefix) }
try {
    $listener.Start()
} catch {
    throw ("could not listen on {0}: {1}`nIf this is an access-denied error, try another port (-Listen 127.0.0.1:8087) or an elevated prompt." -f $Listen, $_.Exception.Message)
}

Write-Host "wisp://localhost:$ListenPort"
Write-Host "multica-relay (WISP v1) listening on ${ListenHost}:$ListenPort (allowed origins: $($OriginPatterns -join ' '))"

# --- pump loop --------------------------------------------------------------
# Windows PowerShell 5.1 has no await and no clean async callbacks, so the
# whole relay is one thread polling .NET Tasks: the accept task, each
# session's WebSocket receive task, and each stream's read task. Nothing
# here blocks longer than one send.

$sessions = New-Object System.Collections.ArrayList
$acceptTask = $listener.GetContextAsync()

try {
    while ($true) {
        $idle = $true

        # New HTTP connections -> origin check -> WebSocket accept.
        if ($acceptTask.IsCompleted) {
            $idle = $false
            $ctx = $null
            try { $ctx = $acceptTask.GetAwaiter().GetResult() } catch {}
            $acceptTask = $listener.GetContextAsync()
            if ($null -ne $ctx) {
                $originHeader = $ctx.Request.Headers["Origin"]
                if (-not $ctx.Request.IsWebSocketRequest) {
                    $ctx.Response.StatusCode = 400
                    $ctx.Response.Close()
                } elseif (-not (Test-OriginAllowed $originHeader $OriginPatterns)) {
                    # Logged: a rejected Origin is the one failure a
                    # legitimate user can hit (page deployed somewhere this
                    # relay wasn't told about). See -Origin.
                    Write-Host "websocket accept rejected (origin '$originHeader'): origin not allowed"
                    $ctx.Response.StatusCode = 403
                    $ctx.Response.Close()
                } else {
                    try {
                        $wsCtx = $ctx.AcceptWebSocketAsync($null).GetAwaiter().GetResult()
                        $session = New-RelaySession $wsCtx.WebSocket
                        [void]$sessions.Add($session)
                        Send-WsMessage $session (New-WispFrame $TYPE_CONTINUE 0 ([BitConverter]::GetBytes($INITIAL_BUFFER)))
                    } catch {
                        try { $ctx.Response.StatusCode = 400; $ctx.Response.Close() } catch {}
                    }
                }
            }
        }

        foreach ($session in @($sessions)) {
            if ($session.Dead) { continue }

            # WebSocket receive progress (reassemble until EndOfMessage).
            if ($session.RecvTask.IsCompleted) {
                $idle = $false
                $result = $null
                try { $result = $session.RecvTask.GetAwaiter().GetResult() } catch { $session.Dead = $true }
                if (-not $session.Dead) {
                    if ($result.MessageType -eq [System.Net.WebSockets.WebSocketMessageType]::Close) {
                        $session.Dead = $true
                    } else {
                        $session.Message.Write($session.RecvBuffer, 0, $result.Count)
                        if ($result.EndOfMessage) {
                            $bytes = $session.Message.ToArray()
                            $session.Message.SetLength(0)
                            Invoke-WispMessage $session $bytes
                        }
                        if (-not $session.Dead) {
                            $session.RecvTask = $session.WebSocket.ReceiveAsync(
                                (New-Object System.ArraySegment[byte] -ArgumentList @(,$session.RecvBuffer)),
                                [System.Threading.CancellationToken]::None)
                        }
                    }
                }
            }

            # Target -> client reads.
            foreach ($streamId in @($session.Streams.Keys)) {
                $stream = $session.Streams[$streamId]
                if ($null -eq $stream -or -not $stream.ReadTask.IsCompleted) { continue }
                $idle = $false
                try {
                    if ($stream.Kind -eq 'udp') {
                        $result = $stream.ReadTask.GetAwaiter().GetResult()
                        Send-WsMessage $session (New-WispFrame $TYPE_DATA $streamId $result.Buffer)
                        $stream.ReadTask = $stream.Client.ReceiveAsync()
                    } else {
                        $count = $stream.ReadTask.GetAwaiter().GetResult()
                        if ($count -le 0) {
                            Close-WispStream $session $streamId $CLOSE_GENERIC
                            continue
                        }
                        $chunk = New-Object byte[] $count
                        [Array]::Copy($stream.ReadBuffer, 0, $chunk, 0, $count)
                        Send-WsMessage $session (New-WispFrame $TYPE_DATA $streamId $chunk)
                        $stream.ReadTask = $stream.NetStream.ReadAsync($stream.ReadBuffer, 0, $stream.ReadBuffer.Length)
                    }
                } catch {
                    Close-WispStream $session $streamId $CLOSE_GENERIC
                }
            }
        }

        # Reap dead sessions and their streams.
        foreach ($session in @($sessions | Where-Object { $_.Dead })) {
            foreach ($streamId in @($session.Streams.Keys)) {
                try { $session.Streams[$streamId].Client.Close() } catch {}
            }
            $session.Streams.Clear()
            try { $session.WebSocket.Dispose() } catch {}
            $sessions.Remove($session)
        }

        if ($idle) { Start-Sleep -Milliseconds 10 }
    }
} finally {
    $listener.Stop()
}
