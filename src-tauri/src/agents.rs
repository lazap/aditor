//! What the coding agent has been doing: its sessions in this workspace, which
//! of them is running right now, and what they cost in tokens.
//!
//! Everything here is read off the agent's own on-disk state -- no API calls,
//! no network, no subprocess -- so the panel is free to refresh as often as the
//! frontend likes.
//!
//! Only Claude Code is implemented. `sessions_for` is the single dispatch
//! point: another agent is a new arm there plus a reader module, because the
//! shapes below (`SessionSummary`, `Counters`, `Totals`) are deliberately
//! agent-neutral rather than shaped around Claude's transcript format.

use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use notify::{EventKind, RecursiveMode, Watcher, recommended_watcher};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, State};

use crate::fs::{Workspace, workspace_root};

// ---------------------------------------------------------------- shapes ---

/// Token counters. The `cache_write_*` split exists only for pricing -- the
/// two ephemeral TTLs bill at different multiples of the input rate -- so it is
/// not serialized; the UI shows the combined `cache_write`.
#[derive(Serialize, Default, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub struct Counters {
    input: u64,
    output: u64,
    /// A subset of `output`, not an addition to it. Reported, never re-priced.
    thinking: u64,
    cache_read: u64,
    cache_write: u64,
    #[serde(skip)]
    cache_write_5m: u64,
    #[serde(skip)]
    cache_write_1h: u64,
}

impl Counters {
    fn add(&mut self, o: &Counters) {
        self.input += o.input;
        self.output += o.output;
        self.thinking += o.thinking;
        self.cache_read += o.cache_read;
        self.cache_write += o.cache_write;
        self.cache_write_5m += o.cache_write_5m;
        self.cache_write_1h += o.cache_write_1h;
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Totals {
    #[serde(flatten)]
    tokens: Counters,
    cost_usd: f64,
    /// True only when the agent recorded the cost itself. False means the
    /// figure came from the price table, which is a lower bound -- see
    /// `summarize`. The UI renders that difference as a leading "≈".
    exact: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelUsage {
    model: String,
    #[serde(flatten)]
    tokens: Counters,
    cost_usd: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Live {
    pid: u32,
    /// As the agent reports it: "waiting", "idle", ...
    status: String,
    waiting_for: Option<String>,
    name: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    id: String,
    title: Option<String>,
    branch: Option<String>,
    /// Epoch ms. `last_at` falls back to file mtime for a session that recorded
    /// no assistant turns at all.
    started_at: i64,
    last_at: i64,
    /// Assistant turns, not raw transcript lines.
    turns: u32,
    live: Option<Live>,
    models: Vec<ModelUsage>,
    totals: Totals,
}

/// Account-wide rate-limit headroom. Cached by the agent at startup, so it goes
/// stale between launches -- `fetched_at_ms` is shown alongside it for that
/// reason.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageLimits {
    five_hour_pct: f64,
    five_hour_resets_at: Option<String>,
    seven_day_pct: f64,
    seven_day_resets_at: Option<String>,
    fetched_at_ms: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessions {
    /// False for an agent we have no reader for. A typed "nothing to show"
    /// rather than an error, the way `FileContents::Binary` is.
    supported: bool,
    sessions: Vec<SessionSummary>,
    limits: Option<UsageLimits>,
}

impl AgentSessions {
    fn unsupported() -> Self {
        AgentSessions { supported: false, sessions: Vec::new(), limits: None }
    }
}

// --------------------------------------------------------------- pricing ---

/// Per-million-token rates, input then output. Matched by longest prefix after
/// `normalize_model`, so `claude-fable-5-1` wins over `claude-fable-5`.
const PRICES: [(&str, f64, f64); 9] = [
    ("claude-fable-5-1", 10.0, 50.0),
    ("claude-fable-5", 10.0, 50.0),
    ("claude-opus-5", 5.0, 25.0),
    ("claude-opus-4-8", 5.0, 25.0),
    ("claude-opus-4-7", 5.0, 25.0),
    ("claude-opus-4-6", 5.0, 25.0),
    ("claude-sonnet-5", 2.0, 10.0),
    ("claude-sonnet-4-6", 3.0, 15.0),
    ("claude-haiku-4-5", 1.0, 5.0),
];

/// Multiples of the model's *input* rate.
const CACHE_READ: f64 = 0.10;
const CACHE_WRITE_5M: f64 = 1.25;
const CACHE_WRITE_1H: f64 = 2.00;

/// Strip the two decorations that stop a raw id from matching `PRICES`: the
/// variant suffix the agent uses in its own bookkeeping (`claude-opus-5[1m]`)
/// and a dated snapshot (`claude-haiku-4-5-20251001`).
fn normalize_model(model: &str) -> &str {
    let base = model.split('[').next().unwrap_or(model);
    match base.rsplit_once('-') {
        Some((head, tail)) if tail.len() == 8 && tail.bytes().all(|b| b.is_ascii_digit()) => head,
        _ => base,
    }
}

fn price(model: &str) -> Option<(f64, f64)> {
    let id = normalize_model(model);
    PRICES
        .iter()
        .filter(|(prefix, _, _)| id.starts_with(prefix))
        .max_by_key(|(prefix, _, _)| prefix.len())
        .map(|(_, i, o)| (*i, *o))
}

fn cost_of(model: &str, c: &Counters) -> Option<f64> {
    let (inp, out) = price(model)?;
    let m = 1_000_000.0;
    Some(
        c.input as f64 / m * inp
            + c.output as f64 / m * out
            + c.cache_read as f64 / m * inp * CACHE_READ
            + c.cache_write_5m as f64 / m * inp * CACHE_WRITE_5M
            + c.cache_write_1h as f64 / m * inp * CACHE_WRITE_1H,
    )
}

// ------------------------------------------------------------- timestamps ---

/// Parse `2026-09-23T12:23:46.789Z` to epoch millis. Deliberately strict:
/// transcripts are machine-written, so a lenient parser would only hide a
/// format change behind plausible-looking numbers.
fn iso_to_ms(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() < 19 {
        return None;
    }
    let num = |a: usize, z: usize| s.get(a..z)?.parse::<i64>().ok();
    let (y, mo, d) = (num(0, 4)?, num(5, 7)?, num(8, 10)?);
    let (h, mi, sec) = (num(11, 13)?, num(14, 16)?, num(17, 19)?);
    let ms = if b.len() >= 23 && b[19] == b'.' { num(20, 23).unwrap_or(0) } else { 0 };
    Some((days_from_civil(y, mo, d) * 86_400 + h * 3600 + mi * 60 + sec) * 1000 + ms)
}

/// Howard Hinnant's `days_from_civil`: days since 1970-01-01 in the proleptic
/// Gregorian calendar. Cheaper than taking on a date crate for one conversion.
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn mtime_ms(path: &Path) -> i64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ------------------------------------------------------------ parse state ---

struct CostState {
    total_usd: f64,
    models: HashMap<String, Counters>,
}

/// Everything one session's files contribute, folded as lines arrive.
#[derive(Default)]
struct Accum {
    /// Retries repeat `message.id`; `requestId` is what distinguishes a request
    /// that was actually billed. Without this a retried turn is counted twice.
    seen_requests: HashSet<String>,
    models: HashMap<String, Counters>,
    turns: u32,
    first_ts: Option<i64>,
    last_ts: Option<i64>,
    title: Option<String>,
    slug: Option<String>,
    branch: Option<String>,
    cost_state: Option<CostState>,
}

impl Accum {
    /// Merge only what a subagent transcript may contribute: its token spend.
    /// Titles, branches and timestamps stay the parent session's.
    fn merge_usage(&mut self, other: &Accum) {
        for (model, c) in &other.models {
            self.models.entry(model.clone()).or_default().add(c);
        }
    }

    fn is_empty(&self) -> bool {
        self.models.is_empty() && self.cost_state.is_none()
    }
}

/// One transcript file, parsed up to `offset` (the end of the last *complete*
/// line). `seen_len` short-circuits a refresh that found nothing appended.
#[derive(Default)]
struct CachedFile {
    seen_len: u64,
    offset: u64,
    accum: Accum,
}

#[derive(Default)]
pub struct AgentState {
    files: Mutex<HashMap<PathBuf, CachedFile>>,
    /// workspace root -> the agent's transcript directory for it.
    dirs: Mutex<HashMap<PathBuf, PathBuf>>,
    watcher: Mutex<Option<Box<dyn Watcher + Send>>>,
    /// What the live watcher currently covers, so a repeat call is a no-op.
    watching: Mutex<Option<PathBuf>>,
}

// --------------------------------------------------------------- folding ---

fn fold_line(line: &str, acc: &mut Accum) {
    // Cheap reject before serde. Tool-result lines carrying whole file bodies
    // are the bulk of the bytes on disk and can never contribute, so keep them
    // away from the JSON parser entirely.
    if !(line.contains("\"usage\"")
        || line.contains("\"cost-state\"")
        || line.contains("\"ai-title\""))
    {
        return;
    }
    let v: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(_) => return,
    };
    match v.get("type").and_then(Value::as_str) {
        Some("assistant") => fold_assistant(&v, acc),
        Some("cost-state") => fold_cost_state(&v, acc),
        Some("ai-title") => {
            if let Some(t) = v.get("aiTitle").and_then(Value::as_str) {
                acc.title = Some(t.to_string());
            }
        }
        _ => {}
    }
}

fn fold_assistant(v: &Value, acc: &mut Accum) {
    let msg = match v.get("message") {
        Some(m) => m,
        None => return,
    };
    let model = msg.get("model").and_then(Value::as_str).unwrap_or("");
    // Synthetic entries stand in for things like an interrupted turn; they
    // carry a usage block of zeroes and no real model.
    if model.is_empty() || model.starts_with('<') {
        return;
    }
    if let Some(req) = v.get("requestId").and_then(Value::as_str) {
        if !acc.seen_requests.insert(req.to_string()) {
            return;
        }
    }
    let u = match msg.get("usage") {
        Some(u) => u,
        None => return,
    };
    let g = |k: &str| u.get(k).and_then(Value::as_u64).unwrap_or(0);
    let total_write = g("cache_creation_input_tokens");
    let cc = u.get("cache_creation");
    let w5 = cc.and_then(|c| c.get("ephemeral_5m_input_tokens")).and_then(Value::as_u64);
    let w1h = cc.and_then(|c| c.get("ephemeral_1h_input_tokens")).and_then(Value::as_u64);

    let c = acc.models.entry(model.to_string()).or_default();
    c.input += g("input_tokens");
    c.output += g("output_tokens");
    c.thinking += u
        .get("output_tokens_details")
        .and_then(|d| d.get("thinking_tokens"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    c.cache_read += g("cache_read_input_tokens");
    c.cache_write += total_write;
    match (w5, w1h) {
        (Some(a), Some(b)) => {
            c.cache_write_5m += a;
            c.cache_write_1h += b;
        }
        // Entries that report only the total predate the split; 5 minutes is
        // the default TTL, so price them that way.
        _ => c.cache_write_5m += total_write,
    }

    acc.turns += 1;
    if let Some(ts) = v.get("timestamp").and_then(Value::as_str).and_then(iso_to_ms) {
        acc.first_ts.get_or_insert(ts);
        acc.last_ts = Some(ts);
    }
    if let Some(b) = v.get("gitBranch").and_then(Value::as_str).filter(|s| !s.is_empty()) {
        acc.branch = Some(b.to_string());
    }
    if acc.slug.is_none() {
        if let Some(s) = v.get("slug").and_then(Value::as_str).filter(|s| !s.is_empty()) {
            acc.slug = Some(s.to_string());
        }
    }
}

fn fold_cost_state(v: &Value, acc: &mut Accum) {
    let total = match v.get("totalCostUSD").and_then(Value::as_f64) {
        Some(t) => t,
        None => return,
    };
    let mut models = HashMap::new();
    if let Some(mu) = v.get("modelUsage").and_then(Value::as_object) {
        for (model, u) in mu {
            let g = |k: &str| u.get(k).and_then(Value::as_u64).unwrap_or(0);
            let w = g("cacheCreationInputTokens");
            models.insert(
                model.clone(),
                Counters {
                    input: g("inputTokens"),
                    output: g("outputTokens"),
                    thinking: g("thinkingTokens"),
                    cache_read: g("cacheReadInputTokens"),
                    cache_write: w,
                    cache_write_5m: w,
                    cache_write_1h: 0,
                },
            );
        }
    }
    acc.cost_state = Some(CostState { total_usd: total, models });
    if acc.first_ts.is_none() {
        acc.first_ts = v.get("startTime").and_then(Value::as_i64);
    }
}

/// Fold whatever has been appended to `path` since the last call.
///
/// Reads are incremental because the live transcript grows throughout a turn:
/// re-parsing a multi-megabyte file on every refresh would make the panel the
/// most expensive thing in the app.
fn fold_file(path: &Path, cached: &mut CachedFile) {
    let len = match std::fs::metadata(path) {
        Ok(m) => m.len(),
        Err(_) => return,
    };
    // Shorter than what we already consumed means the file was rewritten, not
    // appended to; the only safe response is to start over.
    if len < cached.offset {
        *cached = CachedFile::default();
    } else if len == cached.seen_len {
        return;
    }
    cached.seen_len = len;

    let mut file = match File::open(path) {
        Ok(f) => f,
        Err(_) => return,
    };
    if file.seek(SeekFrom::Start(cached.offset)).is_err() {
        return;
    }
    let mut reader = BufReader::new(file);
    let mut buf: Vec<u8> = Vec::new();
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf) {
            Ok(0) => break,
            Ok(n) => {
                // A line without its newline is still being written. Leave the
                // offset short of it and pick it up on the next refresh.
                if buf.last() != Some(&b'\n') {
                    break;
                }
                cached.offset += n as u64;
                // Lossy rather than strict: a truncated multi-byte character at
                // a write boundary must not stop the whole file.
                if let Ok(s) = std::str::from_utf8(&buf) {
                    fold_line(s, &mut cached.accum);
                }
            }
            Err(_) => break,
        }
    }
}

// ---------------------------------------------------- claude code reader ---

fn home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

/// The agent names a project directory after the cwd with every separator
/// flattened. That mapping is lossy -- a literal `-` in a path is
/// indistinguishable from `/` -- so it is only ever used as a *guess*, checked
/// against the `cwd` recorded inside the transcript.
fn encode_project_dir(root: &Path) -> String {
    root.to_string_lossy()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '-' })
        .collect()
}

/// The `cwd` a transcript directory belongs to, read from the first entry that
/// records one.
fn dir_cwd(dir: &Path) -> Option<String> {
    let entries = std::fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let file = File::open(&path).ok()?;
        for line in BufReader::new(file).lines().take(50).map_while(Result::ok) {
            if !line.contains("\"cwd\"") {
                continue;
            }
            if let Ok(v) = serde_json::from_str::<Value>(&line) {
                if let Some(cwd) = v.get("cwd").and_then(Value::as_str) {
                    return Some(cwd.to_string());
                }
            }
        }
    }
    None
}

/// Find the transcript directory for `root`: guess from the encoding, verify
/// against the recorded cwd, and fall back to a one-time scan if they disagree.
fn project_dir(root: &Path, state: &AgentState) -> Option<PathBuf> {
    if let Some(hit) = state.dirs.lock().unwrap().get(root) {
        if hit.is_dir() {
            return Some(hit.clone());
        }
    }
    let projects = home()?.join(".claude").join("projects");
    let want = root.to_string_lossy().to_string();

    let guess = projects.join(encode_project_dir(root));
    let found = if guess.is_dir() && dir_cwd(&guess).as_deref().unwrap_or(&want) == want {
        Some(guess)
    } else {
        std::fs::read_dir(&projects)
            .ok()?
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.is_dir())
            .find(|p| dir_cwd(p).as_deref() == Some(want.as_str()))
    }?;

    state.dirs.lock().unwrap().insert(root.to_path_buf(), found.clone());
    Some(found)
}

#[derive(Deserialize)]
struct LiveEntry {
    pid: u32,
    #[serde(rename = "sessionId")]
    session_id: String,
    cwd: String,
    status: Option<String>,
    #[serde(rename = "waitingFor")]
    waiting_for: Option<String>,
    name: Option<String>,
}

/// Is this PID still around? Guards against a registry file left behind by a
/// process that died without cleaning up.
fn pid_alive(pid: u32) -> bool {
    // Signal 0 performs the existence and permission checks without delivering
    // anything -- the standard liveness probe.
    unsafe { libc::kill(pid as i32, 0) == 0 }
}

/// Live sessions whose cwd is this workspace, keyed by session id.
fn live_sessions(root: &Path) -> HashMap<String, Live> {
    let mut out = HashMap::new();
    let dir = match home() {
        Some(h) => h.join(".claude").join("sessions"),
        None => return out,
    };
    let want = root.to_string_lossy().to_string();
    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return out,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let text = match std::fs::read_to_string(&path) {
            Ok(t) => t,
            Err(_) => continue,
        };
        let e: LiveEntry = match serde_json::from_str(&text) {
            Ok(e) => e,
            Err(_) => continue,
        };
        if e.cwd != want || !pid_alive(e.pid) {
            continue;
        }
        out.insert(
            e.session_id,
            Live {
                pid: e.pid,
                status: e.status.unwrap_or_else(|| "idle".to_string()),
                waiting_for: e.waiting_for,
                name: e.name,
            },
        );
    }
    out
}

/// Account-wide rate-limit headroom, cached by the agent in its own config.
///
/// That file also holds account identity and machine identifiers. Only the
/// utilization block is deserialized, and only these five fields leave here.
fn usage_limits() -> Option<UsageLimits> {
    #[derive(Deserialize)]
    struct Window {
        utilization: Option<f64>,
        resets_at: Option<String>,
    }
    #[derive(Deserialize)]
    struct Utilization {
        five_hour: Option<Window>,
        seven_day: Option<Window>,
    }
    #[derive(Deserialize)]
    struct Cached {
        #[serde(rename = "fetchedAtMs")]
        fetched_at_ms: Option<i64>,
        utilization: Option<Utilization>,
    }
    #[derive(Deserialize)]
    struct Config {
        #[serde(rename = "cachedUsageUtilization")]
        cached: Option<Cached>,
    }

    let text = std::fs::read_to_string(home()?.join(".claude.json")).ok()?;
    let cached = serde_json::from_str::<Config>(&text).ok()?.cached?;
    let u = cached.utilization?;
    let pct = |w: &Option<Window>| w.as_ref().and_then(|w| w.utilization).unwrap_or(0.0);
    let reset = |w: &Option<Window>| w.as_ref().and_then(|w| w.resets_at.clone());
    Some(UsageLimits {
        five_hour_pct: pct(&u.five_hour),
        five_hour_resets_at: reset(&u.five_hour),
        seven_day_pct: pct(&u.seven_day),
        seven_day_resets_at: reset(&u.seven_day),
        fetched_at_ms: cached.fetched_at_ms.unwrap_or(0),
    })
}

/// Everything that passed through the model, cache included.
fn total(c: &Counters) -> u64 {
    c.input + c.output + c.cache_read + c.cache_write
}

fn summarize(id: String, acc: &Accum, live: Option<Live>, fallback_ts: i64) -> SessionSummary {
    // A session that recorded its own cost is authoritative: that is the number
    // the agent itself reports, and it accounts for everything the session
    // spent. The price table is only the fallback, and it is *always* a floor
    // rather than a figure -- hence `exact: false` on that branch even when
    // every model priced cleanly.
    //
    // Measured against sessions that carry both: the table reproduces
    // cost-state to the cent when all spend is in the transcript, but sessions
    // routinely run 1-13% higher because the agent makes side calls (a cheaper
    // model for titles and suchlike) that are never written as transcript
    // entries. There is nothing on disk to recover those from.
    let (source, cost_usd, exact) = match &acc.cost_state {
        Some(cs) => (&cs.models, cs.total_usd, true),
        None => {
            let sum = acc
                .models
                .iter()
                .filter_map(|(model, c)| cost_of(model, c))
                .sum();
            (&acc.models, sum, false)
        }
    };

    let mut models: Vec<ModelUsage> = source
        .iter()
        .map(|(model, c)| ModelUsage {
            model: model.clone(),
            tokens: *c,
            cost_usd: cost_of(model, c).unwrap_or(0.0),
        })
        .collect();
    models.sort_by(|a, b| b.cost_usd.total_cmp(&a.cost_usd));

    let mut tokens = Counters::default();
    for c in source.values() {
        tokens.add(c);
    }

    SessionSummary {
        title: acc.title.clone().or_else(|| acc.slug.clone()),
        branch: acc.branch.clone(),
        started_at: acc.first_ts.unwrap_or(fallback_ts),
        last_at: acc.last_ts.unwrap_or(fallback_ts),
        turns: acc.turns,
        live,
        models,
        totals: Totals { tokens, cost_usd, exact },
        id,
    }
}

fn claude_sessions(root: &Path, state: &AgentState) -> AgentSessions {
    let limits = usage_limits();
    let mut live = live_sessions(root);
    let dir = match project_dir(root, state) {
        Some(d) => d,
        None => {
            return AgentSessions { supported: true, sessions: Vec::new(), limits };
        }
    };

    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return AgentSessions { supported: true, sessions: Vec::new(), limits },
    };

    let mut files = state.files.lock().unwrap();
    let mut sessions = Vec::new();

    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let id = match path.file_stem().and_then(|s| s.to_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };

        let cached = files.entry(path.clone()).or_default();
        fold_file(&path, cached);
        // Folding borrows the map mutably, so build the summary from a snapshot
        // of what this session contributed before touching the map again.
        let mut acc = Accum {
            models: cached.accum.models.clone(),
            turns: cached.accum.turns,
            first_ts: cached.accum.first_ts,
            last_ts: cached.accum.last_ts,
            title: cached.accum.title.clone(),
            slug: cached.accum.slug.clone(),
            branch: cached.accum.branch.clone(),
            cost_state: cached.accum.cost_state.as_ref().map(|c| CostState {
                total_usd: c.total_usd,
                models: c.models.clone(),
            }),
            seen_requests: HashSet::new(),
        };

        // Subagent transcripts sit beside the session they belong to. Their
        // tokens are part of what the session spent, so fold them in -- and
        // only their tokens, since their titles and branches are their own.
        let sub_dir = dir.join(&id).join("subagents");
        if let Ok(subs) = std::fs::read_dir(&sub_dir) {
            for sub in subs.flatten() {
                let sub_path = sub.path();
                if sub_path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                    continue;
                }
                let sub_cached = files.entry(sub_path.clone()).or_default();
                fold_file(&sub_path, sub_cached);
                acc.merge_usage(&sub_cached.accum);
            }
        }

        if acc.is_empty() {
            continue;
        }
        let live_entry = live.remove(&id);
        let summary = summarize(id, &acc, live_entry, mtime_ms(&path));
        // A session that recorded a cost but never took a turn -- an immediate
        // quit, say -- is a row that says nothing. A live one still belongs:
        // it simply has not had its first turn yet.
        if summary.live.is_none() && summary.turns == 0 && total(&summary.totals.tokens) == 0 {
            continue;
        }
        sessions.push(summary);
    }

    sessions.sort_by_key(|s| std::cmp::Reverse(s.last_at));
    AgentSessions { supported: true, sessions, limits }
}

// -------------------------------------------------------------- commands ---

#[tauri::command]
pub fn agent_sessions(
    ws: State<'_, Workspace>,
    state: State<'_, AgentState>,
    agent_id: String,
) -> Result<AgentSessions, String> {
    let root = workspace_root(&ws)?;
    // The one dispatch point. Another agent is a new arm here.
    Ok(match agent_id.as_str() {
        "claude" => claude_sessions(&root, &state),
        _ => AgentSessions::unsupported(),
    })
}

/// Watch the agent's state so the panel refreshes itself during a turn.
///
/// Two targets: the live-session registry (rewritten whenever a session changes
/// status) and this project's transcripts (appended throughout a turn). Events
/// are coarse and frequent -- the frontend debounces, as it does for the
/// workspace watcher.
#[tauri::command]
pub fn agent_watch(
    app: AppHandle,
    ws: State<'_, Workspace>,
    state: State<'_, AgentState>,
    agent_id: String,
) -> Result<(), String> {
    if agent_id != "claude" {
        *state.watcher.lock().unwrap() = None;
        *state.watching.lock().unwrap() = None;
        return Ok(());
    }
    let root = workspace_root(&ws)?;
    if state.watching.lock().unwrap().as_deref() == Some(root.as_path()) {
        return Ok(());
    }
    let home = home().ok_or_else(|| "no home directory".to_string())?;

    let emitter = app.clone();
    let mut watcher = recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(event) = res {
            if matches!(
                event.kind,
                EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_)
            ) {
                let _ = emitter.emit("agents://changed", ());
            }
        }
    })
    .map_err(|e| e.to_string())?;

    let registry = home.join(".claude").join("sessions");
    if registry.is_dir() {
        watcher
            .watch(&registry, RecursiveMode::NonRecursive)
            .map_err(|e| e.to_string())?;
    }
    // Recursive so subagent transcripts, which live one level down, are covered.
    if let Some(dir) = project_dir(&root, &state) {
        watcher
            .watch(&dir, RecursiveMode::Recursive)
            .map_err(|e| e.to_string())?;
    }

    // Replacing the previous watcher drops it, which stops it.
    *state.watcher.lock().unwrap() = Some(Box::new(watcher));
    *state.watching.lock().unwrap() = Some(root);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fold(text: &str) -> Accum {
        let mut acc = Accum::default();
        for line in text.lines() {
            fold_line(line, &mut acc);
        }
        acc
    }

    #[test]
    fn normalizes_variant_and_dated_model_ids() {
        assert_eq!(normalize_model("claude-opus-5[1m]"), "claude-opus-5");
        assert_eq!(normalize_model("claude-haiku-4-5-20251001"), "claude-haiku-4-5");
        assert_eq!(normalize_model("claude-sonnet-5"), "claude-sonnet-5");
    }

    #[test]
    fn prefers_the_longest_matching_price_prefix() {
        assert_eq!(price("claude-fable-5-1"), Some((10.0, 50.0)));
        assert_eq!(price("claude-opus-5[1m]"), Some((5.0, 25.0)));
        assert_eq!(price("gpt-nonexistent"), None);
    }

    #[test]
    fn parses_iso_timestamps() {
        assert_eq!(iso_to_ms("1970-01-01T00:00:00.000Z"), Some(0));
        assert_eq!(iso_to_ms("2026-09-23T12:23:46.789Z"), Some(1790166226789));
        assert_eq!(iso_to_ms("nonsense"), None);
    }

    #[test]
    fn dedupes_retries_by_request_id() {
        let line = r#"{"type":"assistant","requestId":"req_1","timestamp":"2026-09-23T10:00:00.000Z","message":{"model":"claude-opus-5","usage":{"input_tokens":10,"output_tokens":5}}}"#;
        let acc = fold(&format!("{line}\n{line}"));
        assert_eq!(acc.turns, 1);
        assert_eq!(acc.models["claude-opus-5"].input, 10);
    }

    #[test]
    fn skips_synthetic_models() {
        let acc = fold(
            r#"{"type":"assistant","requestId":"req_2","message":{"model":"<synthetic>","usage":{"input_tokens":99,"output_tokens":99}}}"#,
        );
        assert!(acc.models.is_empty());
        assert_eq!(acc.turns, 0);
    }

    #[test]
    fn splits_the_two_cache_write_tiers() {
        let acc = fold(
            r#"{"type":"assistant","requestId":"r","message":{"model":"claude-opus-5","usage":{"input_tokens":0,"output_tokens":0,"cache_creation_input_tokens":1000,"cache_creation":{"ephemeral_5m_input_tokens":400,"ephemeral_1h_input_tokens":600}}}}"#,
        );
        let c = acc.models["claude-opus-5"];
        assert_eq!((c.cache_write, c.cache_write_5m, c.cache_write_1h), (1000, 400, 600));
        // 400 @ 1.25x + 600 @ 2.0x of the $5/MTok input rate.
        let want = 400.0 / 1e6 * 5.0 * 1.25 + 600.0 / 1e6 * 5.0 * 2.0;
        assert!((cost_of("claude-opus-5", &c).unwrap() - want).abs() < 1e-12);
    }

    #[test]
    fn treats_an_unsplit_cache_write_as_five_minute() {
        let acc = fold(
            r#"{"type":"assistant","requestId":"r","message":{"model":"claude-opus-5","usage":{"cache_creation_input_tokens":800}}}"#,
        );
        let c = acc.models["claude-opus-5"];
        assert_eq!((c.cache_write_5m, c.cache_write_1h), (800, 0));
    }

    #[test]
    fn cost_state_overrides_the_price_table() {
        let acc = fold(
            r#"{"type":"assistant","requestId":"r","message":{"model":"claude-opus-5","usage":{"input_tokens":10,"output_tokens":5}}}
{"type":"cost-state","totalCostUSD":22.82,"startTime":1790161905420,"modelUsage":{"claude-opus-5[1m]":{"inputTokens":1964,"outputTokens":186021,"thinkingTokens":54677,"cacheReadInputTokens":30861152,"cacheCreationInputTokens":273042}}}"#,
        );
        let s = summarize("s".into(), &acc, None, 0);
        assert!(s.totals.exact);
        assert_eq!(s.totals.cost_usd, 22.82);
        assert_eq!(s.totals.tokens.input, 1964);
        assert_eq!(s.started_at, 1790161905420);
    }

    #[test]
    fn marks_a_derived_cost_as_inexact_even_when_fully_priced() {
        let acc = fold(
            r#"{"type":"assistant","requestId":"r","message":{"model":"claude-opus-5","usage":{"input_tokens":1000000,"output_tokens":0}}}"#,
        );
        let s = summarize("s".into(), &acc, None, 0);
        // Priced cleanly, but the transcript is not the whole story.
        assert_eq!(s.totals.cost_usd, 5.0);
        assert!(!s.totals.exact);
    }

    #[test]
    fn counts_tokens_for_an_unpriced_model_but_no_dollars() {
        let acc = fold(
            r#"{"type":"assistant","requestId":"r","message":{"model":"some-future-model","usage":{"input_tokens":10,"output_tokens":5}}}"#,
        );
        let s = summarize("s".into(), &acc, None, 7);
        assert!(!s.totals.exact);
        assert_eq!(s.totals.cost_usd, 0.0);
        assert_eq!(s.totals.tokens.input, 10);
        assert_eq!(s.started_at, 7);
    }

    #[test]
    fn takes_the_title_then_falls_back_to_the_slug() {
        let usage = r#""usage":{"input_tokens":1,"output_tokens":1}"#;
        let with_slug = format!(
            r#"{{"type":"assistant","requestId":"r","slug":"fix-pty","message":{{"model":"claude-opus-5",{usage}}}}}"#
        );
        assert_eq!(fold(&with_slug).slug.as_deref(), Some("fix-pty"));
        let titled = format!("{with_slug}\n{}", r#"{"type":"ai-title","aiTitle":"Buffering fix"}"#);
        let acc = fold(&titled);
        assert_eq!(
            summarize("s".into(), &acc, None, 0).title.as_deref(),
            Some("Buffering fix")
        );
    }

    #[test]
    fn ignores_lines_that_cannot_contribute() {
        let mut acc = Accum::default();
        fold_line(r#"{"type":"user","toolUseResult":{"stdout":"huge file body"}}"#, &mut acc);
        assert!(acc.is_empty());
    }
}
