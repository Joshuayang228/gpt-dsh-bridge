<#
.SYNOPSIS
  Thin client for the dsh-orchestrator control surface.

.DESCRIPTION
  Talks to the localhost-only control plugin that the DSH Web host mounts. It
  authenticates with a bearer token read from DSH's own credential store, so
  there is no second copy of the secret and nothing to configure.

  Every subcommand writes the raw `{ok, result}` / `{ok, error}` envelope to
  stdout, so a caller can consume it directly. Exit code is 0 when ok is true,
  1 when ok is false, 2 for a usage or transport error.

  The plugin lives in the DSH Web host, so that host must be running.

.EXAMPLE
  .\tools\dsho.ps1 health

.EXAMPLE
  .\tools\dsho.ps1 ensure -Path "D:\proj"
  .\tools\dsho.ps1 new -Workstream "四线下半链集成" -WorkspaceId <id>
  .\tools\dsho.ps1 prompt -Session session-abc -Text "run the tests"
  .\tools\dsho.ps1 status -Session session-abc -Wait
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [ValidateSet('health', 'workspaces', 'ensure', 'sessions', 'new', 'attach', 'rename', 'prompt', 'status', 'sandbox', 'cancel')]
    [string] $Command,

    [string] $Path,
    [string] $Workstream,
    [string] $Title,
    [string] $Session,
    [string] $WorkspaceId,
    [string] $Cwd,
    [string] $AgentPreset,
    [string] $Text,
    [string] $TextFile,
    [string] $RequestId,
    # Deliberately NOT ValidateSet: the server owns the mode vocabulary and
    # replies with a structured SANDBOX_INVALID_MODE (exit 1). Validating here
    # would turn a contract violation into a PowerShell binding error (exit 2)
    # and hide the real contract from the caller.
    [string] $Mode,
    [int]    $TimeoutMs,
    [string] $Token,
    [string] $DshHome = $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }),
    # Test/diagnostic seam: point the contract lookup at another file. It changes
    # WHERE the single contract is read from, never WHAT it says.
    [string] $ContractFile,
    # Compose the prompt payload and print it instead of sending. The injection
    # is only verifiable this way when no host is running.
    [switch] $DryRun,
    [switch] $Steer,
    [switch] $Wait,
    [switch] $IncludeArchived,
    [switch] $Pretty
)

$ErrorActionPreference = 'Stop'

# --------------------------------------------------------------- discovery

function Get-Endpoint {
    $file = Join-Path $DshHome 'orchestrator\endpoint.json'
    if (-not (Test-Path -LiteralPath $file)) {
        throw "no endpoint file at $file - is the DSH Web host running with dsh-orchestrator installed?"
    }
    $endpoint = Get-Content -LiteralPath $file -Raw -Encoding UTF8 | ConvertFrom-Json
    if (-not $endpoint.port) { throw "the endpoint file at $file has no port" }
    return $endpoint
}

<#
  Read the control token out of DSH's credential document. Structural parse of
  the one record only; no other entry is touched and no value is printed.
#>
function Get-ControlToken {
    if ($Token) { return $Token }
    $file = Join-Path $DshHome '.credentials.yaml'
    if (-not (Test-Path -LiteralPath $file)) {
        throw "no credential document at $file and no -Token given"
    }
    $lines = Get-Content -LiteralPath $file -Encoding UTF8
    $keyLine = -1
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i].Trim() -eq 'dsh-orchestrator/control-token:') { $keyLine = $i; break }
    }
    if ($keyLine -lt 0) {
        throw "the credential document has no dsh-orchestrator/control-token record; start the DSH Web host once so it is minted"
    }
    $indent = $lines[$keyLine].Length - $lines[$keyLine].TrimStart().Length
    for ($i = $keyLine + 1; $i -lt $lines.Count; $i++) {
        $line = $lines[$i]
        if ($line.Trim().Length -eq 0) { continue }
        $lineIndent = $line.Length - $line.TrimStart().Length
        if ($lineIndent -le $indent) { break }
        if ($line -match '^\s*token:\s*(\S+)\s*$') { return $Matches[1] }
    }
    throw "the dsh-orchestrator/control-token record carries no token"
}

# ----------------------------------------------------------------- requests

function Invoke-Control {
    param(
        [string] $Method,
        [string] $Uri,
        $Body
    )

    $headers = @{ Authorization = "Bearer $(Get-ControlToken)" }
    $params = @{
        Method      = $Method
        Uri         = $Uri
        Headers     = $headers
        ErrorAction = 'Stop'
        # Mandatory on Windows PowerShell 5.1: without it Invoke-WebRequest
        # routes the body through the Internet Explorer DOM parser and dies
        # with "Windows PowerShell is in NonInteractive mode". PowerShell 7
        # accepts and ignores it, so this works on both.
        UseBasicParsing = $true
    }
    if ($null -ne $Body) {
        # Encode explicitly. Windows PowerShell 5.1 sends a string body using a
        # non-UTF-8 default unless the content type names a charset, and its
        # ConvertTo-Json leaves CJK characters raw rather than \u-escaping them.
        # A Unicode path like D:\项目\... would otherwise arrive mangled and register a
        # bogus workspace. Passing bytes removes the ambiguity entirely.
        $json = $Body | ConvertTo-Json -Depth 8 -Compress
        $params['Body'] = [System.Text.Encoding]::UTF8.GetBytes($json)
        $params['ContentType'] = 'application/json; charset=utf-8'
    }

    try {
        $response = Invoke-WebRequest @params
        return $response.Content
    }
    catch {
        # A structured failure still carries a body; surface it rather than the
        # PowerShell wrapper. 5.1 and 7 expose it in different places.
        $body = $null
        if ($_.ErrorDetails -and $_.ErrorDetails.Message) { $body = $_.ErrorDetails.Message }
        elseif ($_.Exception.Response) {
            try {
                $stream = $_.Exception.Response.GetResponseStream()
                $reader = New-Object System.IO.StreamReader($stream)
                $body = $reader.ReadToEnd()
            } catch { $body = $null }
        }
        if ($body) { return $body }
        # No body means a transport-level failure. Name the exception type as
        # well as the message: 5.1's wrapper text is often uninformative.
        throw "$($_.Exception.GetType().Name): $($_.Exception.Message)"
    }
}

# ------------------------------------------------------- runtime contract

# Every dispatched prompt must carry the delivery contract. It is maintained in
# exactly one place - the marked block in agent-skills/dsh-handoff.md - and this
# script only locates, extracts, validates and appends it. Never inline the text
# here: two copies drift, and the one DSH actually reads is the one that drifts.

$ContractStartMarker = '<!-- RUNTIME-CONTRACT:START -->'
$ContractEndMarker   = '<!-- RUNTIME-CONTRACT:END -->'

function Resolve-ContractFile {
    if ($ContractFile) { return $ContractFile }
    return Join-Path (Join-Path $PSScriptRoot '..\agent-skills') 'dsh-handoff.md'
}

function Get-RuntimeContract {
    $file = Resolve-ContractFile
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
        throw "runtime contract: file not found: $file"
    }
    $text = [string]::Concat((Get-Content -LiteralPath $file -Raw -Encoding UTF8))
    $startCount = ([regex]::Matches($text, [regex]::Escape($ContractStartMarker))).Count
    $endCount   = ([regex]::Matches($text, [regex]::Escape($ContractEndMarker))).Count
    if ($startCount -ne 1 -or $endCount -ne 1) {
        throw "runtime contract: expected exactly one START and one END marker in $file, found $startCount START / $endCount END"
    }
    $startAt = $text.IndexOf($ContractStartMarker, [StringComparison]::Ordinal)
    $endAt   = $text.IndexOf($ContractEndMarker, [StringComparison]::Ordinal)
    if ($endAt -lt $startAt) {
        throw "runtime contract: END marker appears before START marker in $file"
    }
    $body = $text.Substring($startAt + $ContractStartMarker.Length, $endAt - $startAt - $ContractStartMarker.Length).Trim()
    if ([string]::IsNullOrWhiteSpace($body)) {
        throw "runtime contract: the marked block in $file is empty"
    }
    return $body
}

# Appends the contract to a task text exactly once. Callers hand in the raw task
# text and send the return value; nothing downstream appends again.
function Add-RuntimeContract {
    param([string] $Content)
    $contract = Get-RuntimeContract
    return ($Content.TrimEnd() + "`r`n`r`n" + $contract + "`r`n")
}

# A separate GPT-only reminder is read from the same handoff source of truth.
# It is never sent to DSH and never inserted into the five-block DSH report.
function Get-GptReviewReminder {
    $file = Resolve-ContractFile
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
        throw "GPT review reminder: file not found: $file"
    }
    $source = [string]::Concat((Get-Content -LiteralPath $file -Raw -Encoding UTF8))
    $startMarker = '<!-- GPT-REVIEW-REMINDER:START -->'
    $endMarker   = '<!-- GPT-REVIEW-REMINDER:END -->'
    $starts = ([regex]::Matches($source, [regex]::Escape($startMarker))).Count
    $ends = ([regex]::Matches($source, [regex]::Escape($endMarker))).Count
    if ($starts -ne 1 -or $ends -ne 1) {
        throw "GPT review reminder: expected one START and END marker, found $starts / $ends"
    }
    $startAt = $source.IndexOf($startMarker, [StringComparison]::Ordinal)
    $endAt = $source.IndexOf($endMarker, [StringComparison]::Ordinal)
    if ($endAt -lt $startAt) {
        throw "GPT review reminder: END marker precedes START"
    }
    $reminder = $source.Substring($startAt + $startMarker.Length, $endAt - $startAt - $startMarker.Length).Trim()
    if ([string]::IsNullOrWhiteSpace($reminder)) {
        throw "GPT review reminder: marked block is empty"
    }
    return $reminder
}

# Resolves the task text from -Text or -TextFile. Shared by the real dispatch and
# by -DryRun so the two paths cannot disagree about what counts as task text.
function Resolve-TaskText {
    $content = $Text
    if (-not $content -and $TextFile) { $content = [string]::Concat((Get-Content -LiteralPath $TextFile -Raw -Encoding UTF8)) }
    if (-not $content) { throw 'prompt needs -Text <t> or -TextFile <f>' }
    return $content
}

# -------------------------------------------------------------------- usage

function Show-Usage {
    @'
usage: dsho.ps1 <command> [options]

  health                                   service facts and the capability report
  workspaces                               registered Workspaces and their accounting
  ensure    -Path <dir>                    create or reuse the Workspace over a directory
  sessions  [-IncludeArchived]             every visible session
  new       -Workstream <name>             create + name GPT-<name>
            (-WorkspaceId <id> | -Cwd <dir>) [-AgentPreset <p>]
  attach    -Session <id> -WorkspaceId <id>  account an existing session to a Workspace
  rename    -Session <id> (-Title <t> | -Workstream <w>)
  prompt    -Session <id> (-Text <t> | -TextFile <f>) [-Steer] [-RequestId <id>]
  status    -Session <id> [-Wait] [-TimeoutMs <ms>]
  sandbox   -Session <id>                  read the effective file sandbox policy
  sandbox   -Session <id> -Mode <mode>     switch it (an explicit act only)
                mode = read-only | workspace-write | danger-full-access
  cancel    -Session <id>

  -Token <t>         override the token (default: DSH credential store)
  -DshHome <dir>     override $DSH_HOME
  -Pretty            pretty-print the JSON envelope
'@
}

# --------------------------------------------------------------------- main

try {
    # -ContractFile is a test seam for -DryRun only. Every real dispatch must read
    # the canonical agent-skills/dsh-handoff.md, otherwise "one source of truth"
    # is silently bypassable. Checked before any discovery or send.
    if (-not $DryRun -and $PSBoundParameters.ContainsKey('ContractFile')) {
        throw '-ContractFile is only allowed with -DryRun; a real dispatch always reads agent-skills/dsh-handoff.md'
    }

    # -DryRun only composes and prints the payload, so it must work with no host,
    # no endpoint file and no credential. Handling it before any discovery is what
    # makes that true; nothing below this block runs for it.
    if ($DryRun) {
        if ($Command -ne 'prompt') { throw '-DryRun is only supported with prompt' }
        $composed = Add-RuntimeContract -Content (Resolve-TaskText)
        try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }
        # Write-Output rather than [Console]::Out.Write: the latter bypasses the
        # PowerShell pipeline, so `$x = & .\tools\dsho.ps1 ... -DryRun` would
        # capture nothing. This keeps the composed text composable.
        Write-Output $composed
        exit 0
    }

    $endpoint = Get-Endpoint
    $base = "http://$($endpoint.host):$($endpoint.port)"

    switch ($Command) {
        'health'     { $json = Invoke-Control GET  "$base/v1/health" $null }
        'workspaces' { $json = Invoke-Control GET  "$base/v1/workspaces" $null }

        'ensure' {
            if (-not $Path) { throw 'ensure needs -Path <dir>' }
            $json = Invoke-Control POST "$base/v1/workspaces/ensure" @{ path = $Path }
        }

        'sessions' {
            $uri = "$base/v1/sessions"
            if ($IncludeArchived) { $uri += '?includeArchived=true' }
            $json = Invoke-Control GET $uri $null
        }

        'new' {
            if (-not $Workstream) { throw 'new needs -Workstream <name>' }
            if (-not $WorkspaceId -and -not $Cwd) { throw 'new needs -WorkspaceId <id> or -Cwd <dir>' }
            if ($WorkspaceId -and $Cwd) { throw 'new takes -WorkspaceId or -Cwd, not both' }
            $body = @{ workstream = $Workstream }
            if ($WorkspaceId) { $body.workspaceId = $WorkspaceId }
            if ($Cwd)         { $body.cwd = $Cwd }
            if ($AgentPreset) { $body.agentPreset = $AgentPreset }
            $json = Invoke-Control POST "$base/v1/sessions" $body
        }

        'attach' {
            if (-not $Session)     { throw 'attach needs -Session <id>' }
            if (-not $WorkspaceId) { throw 'attach needs -WorkspaceId <id>' }
            $json = Invoke-Control POST "$base/v1/sessions/$([uri]::EscapeDataString($Session))/attach" @{ workspaceId = $WorkspaceId }
        }

        'rename' {
            if (-not $Session) { throw 'rename needs -Session <id>' }
            $body = @{}
            if ($Title)      { $body.title = $Title }
            if ($Workstream) { $body.workstream = $Workstream }
            if ($body.Count -eq 0) { throw 'rename needs -Title <t> or -Workstream <w>' }
            $json = Invoke-Control POST "$base/v1/sessions/$([uri]::EscapeDataString($Session))/rename" $body
        }

        'prompt' {
            if (-not $Session) { throw 'prompt needs -Session <id>' }
            # The delivery contract rides on every dispatch, whichever way the task
            # text arrived. This is the only append site, so it is appended exactly
            # once, and a broken contract fails here — before anything is sent.
            $content = Add-RuntimeContract -Content (Resolve-TaskText)
            $body = @{ text = $content }
            # queue is the server default; steer is sent only when asked for.
            if ($Steer) { $body.mode = 'steer' }
            if ($RequestId) { $body.requestId = $RequestId }
            $json = Invoke-Control POST "$base/v1/sessions/$([uri]::EscapeDataString($Session))/prompt" $body
        }

        'status' {
            if (-not $Session) { throw 'status needs -Session <id>' }
            $uri = "$base/v1/sessions/$([uri]::EscapeDataString($Session))/status"
            $query = @()
            if ($Wait) { $query += 'wait=idle' }
            if ($PSBoundParameters.ContainsKey('TimeoutMs')) { $query += "timeoutMs=$TimeoutMs" }
            if ($query.Count -gt 0) { $uri += '?' + ($query -join '&') }
            $json = Invoke-Control GET $uri $null
        }

        'sandbox' {
            if (-not $Session) { throw 'sandbox needs -Session <id>' }
            $uri = "$base/v1/sessions/$([uri]::EscapeDataString($Session))/sandbox"
            # No -Mode means query only. Any -Mode, even an empty string, is an
            # explicit switch request and is sent verbatim for the server to
            # accept or reject. Nothing here retries with a different mode.
            if ($PSBoundParameters.ContainsKey('Mode')) {
                $json = Invoke-Control POST $uri @{ mode = $Mode }
            }
            else {
                $json = Invoke-Control GET $uri $null
            }
        }

        'cancel' {
            if (-not $Session) { throw 'cancel needs -Session <id>' }
            $json = Invoke-Control POST "$base/v1/sessions/$([uri]::EscapeDataString($Session))/cancel" $null
        }

        default { Show-Usage; exit 2 }
    }

    $parsed = $json | ConvertFrom-Json

    # Only a settled DSH result with a real final assistant message gets the
    # GPT collaboration reminder. Never add it to health/sessions, snapshot-only
    # status, timeouts, stream-ended responses, or a still-running Goal round.
    # The API result and DSH five-block report remain untouched.
    if ($Command -eq 'status' -and $Wait -and $parsed.ok -eq $true) {
        $result = $parsed.result
        if (($result.waitOutcome -eq 'idle' -or $result.waitOutcome -eq 'already-idle') -and
            $result.running -eq $false -and
            -not [string]::IsNullOrWhiteSpace([string]$result.lastTurn.text) -and
            $null -ne $result.lastTurn.reason) {
            try {
                $parsed | Add-Member -NotePropertyName 'gptReviewReminder' -NotePropertyValue (Get-GptReviewReminder) -Force
            }
            catch {
                # Reminder failure must not hide a successfully retrieved result.
                $parsed | Add-Member -NotePropertyName 'gptReviewReminderError' -NotePropertyValue $_.Exception.Message -Force
            }
            $json = $parsed | ConvertTo-Json -Depth 32 -Compress
        }
    }

    # PowerShell 5.1 may otherwise emit localized text through a legacy
    # console code page. The new Chinese GPT reminder must remain valid UTF-8.
    try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch { }
    if ($Pretty) {
        $parsed | ConvertTo-Json -Depth 32
    }
    else {
        $json
    }

    if ($parsed.ok -eq $true) { exit 0 }
    if ($null -ne $parsed.error.code) {
        Write-Error "$($parsed.error.code): $($parsed.error.message)" -ErrorAction Continue
    }
    exit 1
}
catch {
    Write-Error $_.Exception.Message -ErrorAction Continue
    exit 2
}
