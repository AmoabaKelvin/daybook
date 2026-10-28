//! Sends a prompt and a JSON Schema to the model the user picked: Claude Code or Codex through
//! their own CLI logins, or OpenRouter with a key from the Keychain. Returns the model's JSON.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, ExitStatus, Stdio};
use std::sync::{Mutex, OnceLock};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri_plugin_opener::OpenerExt;

const KEYCHAIN_SERVICE: &str = "daybook";
const KEYCHAIN_OPENROUTER: &str = "openrouter";
const OPENROUTER: &str = "https://openrouter.ai";
const REFERER: &str = "https://github.com/AmoabaKelvin/daybook";
const CLAUDE_MODEL: &str = "sonnet";
const OPENROUTER_MODEL: &str = "anthropic/claude-haiku-5.5";
const CLI_TIMEOUT: Duration = Duration::from_secs(120);
const HTTP_TIMEOUT: Duration = Duration::from_secs(90);
const WARM_IDLE: Duration = Duration::from_secs(300);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(180);
const STOPPED: &str = "Stopped";

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug, Default)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    #[default]
    Claude,
    Codex,
    Openrouter,
}

/// Which provider and model to use. Empty model = the provider's default.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct AgentPrefs {
    pub provider: Provider,
    pub claude_model: String,
    pub codex_model: String,
    pub openrouter_model: String,
}

impl Default for AgentPrefs {
    fn default() -> Self {
        AgentPrefs {
            provider: Provider::Claude,
            claude_model: CLAUDE_MODEL.into(),
            codex_model: String::new(),
            openrouter_model: OPENROUTER_MODEL.into(),
        }
    }
}

impl AgentPrefs {
    fn claude_model(&self) -> &str {
        Some(self.claude_model.trim()).filter(|m| !m.is_empty()).unwrap_or(CLAUDE_MODEL)
    }

    fn openrouter_model(&self) -> &str {
        Some(self.openrouter_model.trim()).filter(|m| !m.is_empty()).unwrap_or(OPENROUTER_MODEL)
    }
}

pub struct Request<'a> {
    pub system: &'a str,
    pub schema: &'a serde_json::Value,
    /// The conversation so far, ending with the user's latest message.
    pub messages: &'a [Message],
}

#[derive(Clone, PartialEq, Debug)]
pub enum Message {
    User(String),
    Assistant(String),
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatus {
    pub id: Provider,
    pub ready: bool,
    pub detail: String,
}

/// One ask at a time, so `cancel` always means the current one.
static ASKING: Mutex<()> = Mutex::new(());
/// The CLI process answering the current ask.
static RUNNING: Mutex<Option<Child>> = Mutex::new(None);
/// A Claude process started ahead of time, that hasn't been told anything yet.
static WARM: Mutex<Option<Session>> = Mutex::new(None);
/// The Claude process holding the conversation, so a follow-up sends only the new message.
static LIVE: Mutex<Option<Session>> = Mutex::new(None);
static BINARIES: Mutex<Option<HashMap<&'static str, PathBuf>>> = Mutex::new(None);
static LOGIN_PATH: OnceLock<String> = OnceLock::new();
static REAPER: OnceLock<()> = OnceLock::new();
/// The OpenRouter key, read from the Keychain once and kept until it changes.
static OPENROUTER_KEY: Mutex<Option<Option<String>>> = Mutex::new(None);

/// Blocking. Returns the model's JSON (a string that should parse against the schema).
pub fn ask(prefs: &AgentPrefs, request: &Request) -> Result<String, String> {
    let _asking = ASKING.lock().unwrap_or_else(|e| e.into_inner());
    match prefs.provider {
        Provider::Claude => claude(prefs.claude_model(), request),
        Provider::Codex => codex(prefs.codex_model.trim(), request),
        Provider::Openrouter => openrouter(prefs.openrouter_model(), request),
    }
}

/// Starts a Claude process ahead of time so the next `ask` skips startup (no-op for other providers).
pub fn warm(prefs: &AgentPrefs, system: &str, schema: &serde_json::Value) {
    if prefs.provider != Provider::Claude {
        return drop_sessions();
    }
    let key = WarmKey::new(prefs.claude_model(), system, schema);
    let mut warm = WARM.lock().unwrap();
    if warm.as_mut().is_some_and(|w| w.key == key && w.alive()) {
        return;
    }
    if let Some(old) = warm.take() {
        old.kill();
    }
    *warm = spawn_claude(&key).ok().map(|process| Session { key, process, history: Vec::new(), since: Instant::now() });
    REAPER.get_or_init(|| {
        thread::spawn(reap);
    });
}

/// Stops the request in flight, if it's a CLI process. `ask` then returns Err("Stopped").
pub fn cancel() {
    if let Some(mut child) = RUNNING.lock().unwrap().take() {
        let _ = child.kill();
        let _ = child.wait();
    }
}

/// Blocking: whether each provider is installed and signed in.
pub fn status() -> Vec<ProviderStatus> {
    let (claude, codex) = thread::scope(|s| {
        let claude = s.spawn(claude_status);
        let codex = s.spawn(codex_status);
        (claude.join().unwrap(), codex.join().unwrap())
    });
    let connected = openrouter_key().is_some();
    let openrouter = ProviderStatus {
        id: Provider::Openrouter,
        ready: connected,
        detail: if connected { "Connected" } else { "Not connected" }.into(),
    };
    vec![claude, codex, openrouter]
}

// Running CLIs

/// Apps opened from Finder get a bare PATH, so look where installers usually put things.
fn binary(name: &'static str) -> Option<PathBuf> {
    let mut cache = BINARIES.lock().unwrap();
    let cache = cache.get_or_insert_with(HashMap::new);
    if let Some(path) = cache.get(name) {
        return Some(path.clone());
    }
    let home = std::env::var("HOME").unwrap_or_default();
    let dirs = [".local/bin", ".claude/local", "/opt/homebrew/bin", "/usr/local/bin", ".npm-global/bin", ".bun/bin", ".volta/bin"];
    let found = dirs
        .iter()
        .map(|dir| Path::new(&home).join(dir).join(name))
        .find(|path| path.is_file())
        .or_else(|| {
            let output = Command::new("/bin/zsh").args(["-lc", &format!("command -v {name}")]).output().ok()?;
            let path = PathBuf::from(String::from_utf8(output.stdout).ok()?.lines().last()?.trim());
            (path.is_absolute() && path.is_file()).then_some(path)
        })?;
    cache.insert(name, found.clone());
    Some(found)
}

/// The login shell's PATH, so the CLIs can find node and friends.
fn login_path() -> &'static str {
    LOGIN_PATH.get_or_init(|| {
        Command::new("/bin/zsh")
            .args(["-lc", "printf '\\n%s' \"$PATH\""])
            .output()
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .and_then(|text| text.rsplit('\n').next().map(String::from))
            .filter(|path| !path.is_empty())
            .unwrap_or_else(|| "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin".into())
    })
}

/// An empty folder to run in, so no project files get picked up.
fn workdir() -> PathBuf {
    let dir = std::env::temp_dir().join("daybook-agent");
    let _ = fs::create_dir_all(&dir);
    dir
}

fn command(name: &'static str, missing: &str) -> Result<Command, String> {
    let path = binary(name).ok_or_else(|| missing.to_string())?;
    let mut command = Command::new(path);
    command.env("PATH", login_path()).current_dir(workdir());
    Ok(command)
}

/// Collects stderr on its own thread so a chatty process never blocks on a full pipe.
fn collect(mut stream: impl Read + Send + 'static) -> JoinHandle<String> {
    thread::spawn(move || {
        let mut text = String::new();
        let _ = stream.read_to_string(&mut text);
        text
    })
}

enum Outcome {
    Exited(ExitStatus),
    /// `done` turned true first, and the child is still running.
    Running(Child),
}

/// Waits for the child to exit or `done` to turn true, whichever is first. Kills it on
/// cancel or after the time limit.
fn supervise(child: Child, done: impl Fn() -> bool) -> Result<Outcome, String> {
    *RUNNING.lock().unwrap() = Some(child);
    let deadline = Instant::now() + CLI_TIMEOUT;
    loop {
        let mut running = RUNNING.lock().unwrap();
        let Some(child) = running.as_mut() else { return Err(STOPPED.into()) };
        if let Some(status) = child.try_wait().ok().flatten() {
            running.take();
            return Ok(Outcome::Exited(status));
        }
        if done() {
            return Ok(Outcome::Running(running.take().unwrap()));
        }
        if Instant::now() > deadline {
            let mut child = running.take().unwrap();
            drop(running);
            let _ = child.kill();
            let _ = child.wait();
            return Err("The agent took too long to answer".into());
        }
        drop(running);
        thread::sleep(Duration::from_millis(50));
    }
}

/// The whole conversation as one message, for a model that hasn't seen any of it.
fn flatten(messages: &[Message]) -> String {
    let parts: Vec<String> = messages
        .iter()
        .map(|message| match message {
            Message::User(text) => text.clone(),
            Message::Assistant(text) => format!("You answered:\n{text}"),
        })
        .collect();
    parts.join("\n\n")
}

/// The last line of stderr worth showing.
fn last_line(stderr: &str) -> Option<String> {
    stderr
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .last()
        .map(|line| line.trim_start_matches("ERROR:").trim_start_matches("Error:").trim().to_string())
}

// Claude Code

#[derive(PartialEq)]
struct WarmKey {
    model: String,
    system: String,
    schema: String,
}

impl WarmKey {
    fn new(model: &str, system: &str, schema: &serde_json::Value) -> Self {
        WarmKey { model: model.into(), system: system.into(), schema: schema.to_string() }
    }
}

struct ClaudeProcess {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    stderr: JoinHandle<String>,
}

/// A Claude process waiting for its next message, and what it has been told so far.
struct Session {
    key: WarmKey,
    process: ClaudeProcess,
    history: Vec<Message>,
    since: Instant,
}

impl Session {
    fn alive(&mut self) -> bool {
        matches!(self.process.child.try_wait(), Ok(None))
    }

    fn kill(mut self) {
        let _ = self.process.child.kill();
        let _ = self.process.child.wait();
    }
}

fn drop_sessions() {
    for slot in [&WARM, &LIVE] {
        if let Some(old) = slot.lock().unwrap().take() {
            old.kill();
        }
    }
}

/// Kills processes nobody has used for a while.
fn reap() {
    loop {
        thread::sleep(Duration::from_secs(30));
        for slot in [&WARM, &LIVE] {
            let mut session = slot.lock().unwrap();
            if session.as_ref().is_some_and(|s| s.since.elapsed() > WARM_IDLE) {
                session.take().unwrap().kill();
            }
        }
    }
}

fn spawn_claude(key: &WarmKey) -> Result<ClaudeProcess, String> {
    let mut child = command("claude", "Claude Code isn't installed")?
        .args(["-p", "--tools", "", "--strict-mcp-config", "--setting-sources", "", "--no-session-persistence"])
        .args(["--model", &key.model, "--system-prompt", &key.system, "--json-schema", &key.schema])
        .args(["--input-format", "stream-json", "--output-format", "stream-json", "--verbose"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Couldn't start Claude Code: {e}"))?;
    Ok(ClaudeProcess {
        stdin: child.stdin.take().unwrap(),
        stdout: BufReader::new(child.stdout.take().unwrap()),
        stderr: collect(child.stderr.take().unwrap()),
        child,
    })
}

/// The process already holding this conversation, or else the warm one, or else a new one.
fn claude_session(key: WarmKey, earlier: &[Message]) -> Result<Session, String> {
    if let Some(mut live) = LIVE.lock().unwrap().take() {
        if live.key == key && live.history == earlier && live.alive() {
            return Ok(live);
        }
        live.kill();
    }
    if let Some(mut warm) = WARM.lock().unwrap().take() {
        if warm.key == key && warm.alive() {
            return Ok(warm);
        }
        warm.kill();
    }
    Ok(Session { process: spawn_claude(&key)?, key, history: Vec::new(), since: Instant::now() })
}

/// Sends the latest message to a process that has the rest, or the whole conversation to one
/// that has nothing, and keeps the process for the next message.
fn claude(model: &str, request: &Request) -> Result<String, String> {
    let (latest, earlier) = request.messages.split_last().ok_or("Nothing to ask")?;
    let Session { key, process, mut history, .. } = claude_session(WarmKey::new(model, request.system, request.schema), earlier)?;
    let text = match latest {
        Message::User(text) if !history.is_empty() => text.clone(),
        _ => flatten(request.messages),
    };
    let ClaudeProcess { child, mut stdin, mut stdout, stderr } = process;
    let message = serde_json::json!({ "type": "user", "message": { "role": "user", "content": text } });
    let written = writeln!(stdin, "{message}").and_then(|_| stdin.flush());
    let reader = thread::spawn(move || {
        let mut line = String::new();
        let answer = loop {
            line.clear();
            if !matches!(stdout.read_line(&mut line), Ok(1..)) {
                break None;
            }
            if let Some(answer) = claude_result(&line) {
                break Some(answer);
            }
        };
        (stdout, answer)
    });
    let (status, answer) = match supervise(child, || reader.is_finished())? {
        Outcome::Running(mut child) => {
            let (stdout, answer) = reader.join().unwrap();
            if let Some(Ok(answer)) = answer {
                history.extend(request.messages.iter().cloned());
                history.push(Message::Assistant(answer.clone()));
                let process = ClaudeProcess { child, stdin, stdout, stderr };
                *LIVE.lock().unwrap() = Some(Session { key, process, history, since: Instant::now() });
                return Ok(answer);
            }
            let _ = child.kill();
            (child.wait().map_err(|e| e.to_string())?, answer)
        }
        Outcome::Exited(status) => (status, reader.join().unwrap().1),
    };
    if let Some(answer) = answer {
        return answer;
    }
    written.map_err(|e| format!("Couldn't talk to Claude Code: {e}"))?;
    let detail = last_line(&stderr.join().unwrap_or_default());
    Err(detail.unwrap_or_else(|| format!("Claude Code stopped without answering ({status})")))
}

/// The answer from a stream-json line, or None if the line isn't the result.
fn claude_result(line: &str) -> Option<Result<String, String>> {
    let event: serde_json::Value = serde_json::from_str(line).ok()?;
    if event["type"] != "result" {
        return None;
    }
    let output = &event["structured_output"];
    if event["is_error"] != true && output.is_object() {
        return Some(Ok(output.to_string()));
    }
    let message = event["result"].as_str().map(str::trim).filter(|m| !m.is_empty());
    Some(Err(message.unwrap_or("Claude didn't return an answer").to_string()))
}

fn claude_status() -> ProviderStatus {
    let not = |detail: &str| ProviderStatus { id: Provider::Claude, ready: false, detail: detail.into() };
    let Ok(mut command) = command("claude", "") else { return not("Not installed") };
    let Ok(output) = command.args(["auth", "status"]).output() else { return not("Not installed") };
    let auth: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap_or_default();
    if auth["loggedIn"] != true {
        return not("Run `claude` in a terminal to sign in");
    }
    let detail = match auth["authMethod"].as_str() {
        Some("claude.ai") => "Signed in with Claude.ai".to_string(),
        Some(method) => format!("Signed in ({method})"),
        None => "Signed in".to_string(),
    };
    ProviderStatus { id: Provider::Claude, ready: true, detail }
}

// Codex

/// Temp files that go away with it.
struct TempFiles(Vec<PathBuf>);

impl Drop for TempFiles {
    fn drop(&mut self) {
        for path in &self.0 {
            let _ = fs::remove_file(path);
        }
    }
}

fn codex(model: &str, request: &Request) -> Result<String, String> {
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or_default();
    let base = std::env::temp_dir().join(format!("daybook-codex-{}-{stamp}", std::process::id()));
    let (schema_path, out_path) = (base.with_extension("schema.json"), base.with_extension("out"));
    let _files = TempFiles(vec![schema_path.clone(), out_path.clone()]);
    fs::write(&schema_path, request.schema.to_string()).map_err(|e| format!("Couldn't write the schema: {e}"))?;

    let mut command = command("codex", "Codex isn't installed")?;
    command.args(["exec", "--ephemeral", "--skip-git-repo-check", "--ignore-user-config", "-s", "read-only"]);
    command.args(["-c", "model_reasoning_effort=\"low\""]);
    if !model.is_empty() {
        command.args(["-m", model]);
    }
    let mut child = command
        .arg("--output-schema")
        .arg(&schema_path)
        .arg("-o")
        .arg(&out_path)
        .arg("-")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Couldn't start Codex: {e}"))?;
    let stderr = collect(child.stderr.take().unwrap());
    let mut stdin = child.stdin.take().unwrap();
    // The same opening every time, so OpenAI's prompt cache can reuse it on follow-ups.
    let written = write!(stdin, "{}\n\n{}", request.system, flatten(request.messages));
    drop(stdin);

    let Outcome::Exited(status) = supervise(child, || false)? else { unreachable!("never done before exiting") };
    if !status.success() {
        let detail = last_line(&stderr.join().unwrap_or_default());
        return Err(detail.unwrap_or_else(|| format!("Codex stopped without answering ({status})")));
    }
    written.map_err(|e| format!("Couldn't talk to Codex: {e}"))?;
    let answer = fs::read_to_string(&out_path).unwrap_or_default().trim().to_string();
    if answer.is_empty() {
        return Err("Codex didn't return an answer".into());
    }
    Ok(answer)
}

fn codex_status() -> ProviderStatus {
    let not = |detail: &str| ProviderStatus { id: Provider::Codex, ready: false, detail: detail.into() };
    let Ok(mut command) = command("codex", "") else { return not("Not installed") };
    let Ok(output) = command.args(["login", "status"]).output() else { return not("Not installed") };
    if !output.status.success() {
        return not("Run `codex login` in a terminal to sign in");
    }
    let text = [output.stdout, output.stderr].concat();
    let detail = last_line(&String::from_utf8_lossy(&text)).unwrap_or_else(|| "Signed in".into());
    ProviderStatus { id: Provider::Codex, ready: true, detail }
}

// OpenRouter

fn http() -> ureq::Agent {
    ureq::Agent::config_builder().timeout_global(Some(HTTP_TIMEOUT)).http_status_as_error(false).build().into()
}

fn openrouter_key() -> Option<String> {
    let mut cached = OPENROUTER_KEY.lock().unwrap();
    cached
        .get_or_insert_with(|| {
            security_framework::passwords::get_generic_password(KEYCHAIN_SERVICE, KEYCHAIN_OPENROUTER)
                .ok()
                .and_then(|bytes| String::from_utf8(bytes).ok())
        })
        .clone()
}

fn store_openrouter_key(key: &str) -> Result<(), String> {
    security_framework::passwords::set_generic_password(KEYCHAIN_SERVICE, KEYCHAIN_OPENROUTER, key.as_bytes())
        .map_err(|e| format!("Couldn't save to the Keychain: {e}"))?;
    *OPENROUTER_KEY.lock().unwrap() = Some(Some(key.to_string()));
    Ok(())
}

/// Checks the key against OpenRouter before keeping it in the Keychain.
pub fn set_openrouter_key(key: &str) -> Result<(), String> {
    let key = key.trim();
    let response = http()
        .get(format!("{OPENROUTER}/api/v1/key"))
        .header("Authorization", format!("Bearer {key}"))
        .call()
        .map_err(|e| format!("Couldn't reach OpenRouter: {e}"))?;
    match response.status().as_u16() {
        200 => store_openrouter_key(key),
        401 | 403 => Err("OpenRouter didn't accept that key".into()),
        status => Err(format!("OpenRouter couldn't check the key ({status})")),
    }
}

pub fn clear_openrouter_key() {
    let _ = security_framework::passwords::delete_generic_password(KEYCHAIN_SERVICE, KEYCHAIN_OPENROUTER);
    *OPENROUTER_KEY.lock().unwrap() = Some(None);
}

fn openrouter(model: &str, request: &Request) -> Result<String, String> {
    let key = openrouter_key().ok_or("Connect OpenRouter in Settings first")?;
    // Anthropic models cache only what's marked: the first message, with the notes in it.
    let cache = model.starts_with("anthropic/");
    let mut messages = vec![serde_json::json!({ "role": "system", "content": request.system })];
    for (i, message) in request.messages.iter().enumerate() {
        messages.push(match message {
            Message::User(text) if i == 0 && cache => serde_json::json!({
                "role": "user",
                "content": [{ "type": "text", "text": text, "cache_control": { "type": "ephemeral" } }],
            }),
            Message::User(text) => serde_json::json!({ "role": "user", "content": text }),
            Message::Assistant(text) => serde_json::json!({ "role": "assistant", "content": text }),
        });
    }
    let body = serde_json::json!({
        "model": model,
        "messages": messages,
        "response_format": { "type": "json_schema", "json_schema": { "name": "plan", "strict": true, "schema": request.schema } },
        "provider": { "require_parameters": true },
    });
    let mut response = http()
        .post(format!("{OPENROUTER}/api/v1/chat/completions"))
        .header("Authorization", format!("Bearer {key}"))
        .header("HTTP-Referer", REFERER)
        .header("X-Title", "Daybook")
        .send_json(body)
        .map_err(|e| match e {
            ureq::Error::Timeout(_) => "OpenRouter took too long to answer".to_string(),
            e => format!("Couldn't reach OpenRouter: {e}"),
        })?;
    let status = response.status().as_u16();
    let body: serde_json::Value = response.body_mut().read_json().unwrap_or_default();
    let message = body["error"]["message"].as_str().unwrap_or_default();
    if status != 200 || !body["error"].is_null() {
        return Err(openrouter_error(status, message, model));
    }
    body["choices"][0]["message"]["content"]
        .as_str()
        .map(|content| content.trim().to_string())
        .filter(|content| !content.is_empty())
        .ok_or_else(|| "OpenRouter didn't return an answer".into())
}

fn openrouter_error(status: u16, message: &str, model: &str) -> String {
    match status {
        401 | 403 => "OpenRouter didn't accept the key. Connect it again in Settings.".into(),
        402 => "Out of OpenRouter credits".into(),
        404 if message.contains("support") => format!("No OpenRouter provider for {model} supports structured output"),
        404 => format!("OpenRouter doesn't know the model {model}"),
        408 => "OpenRouter took too long to answer".into(),
        429 => "OpenRouter is busy. Try again in a moment.".into(),
        500.. => format!("OpenRouter is having trouble ({status})"),
        _ if !message.is_empty() => format!("OpenRouter: {message}"),
        _ => format!("OpenRouter couldn't answer ({status})"),
    }
}

// OpenRouter sign-in (OAuth PKCE)

/// Blocking OAuth PKCE: opens the browser, waits (≤3 min) for the localhost callback,
/// swaps the code for a key, stores it.
pub fn connect_openrouter(app: &tauri::AppHandle) -> Result<(), String> {
    let verifier = random_token()?;
    let state = random_token()?;
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| format!("Couldn't start the sign-in: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let callback = format!("http%3A%2F%2Flocalhost%3A{port}%2Fcallback");
    let url = format!(
        "{OPENROUTER}/auth?callback_url={callback}&code_challenge={}&code_challenge_method=S256&state={state}&key_label=Daybook",
        challenge(&verifier)
    );
    app.opener().open_url(url, None::<&str>).map_err(|e| format!("Couldn't open the browser: {e}"))?;
    let code = wait_for_code(&listener, &state)?;
    let mut response = http()
        .post(format!("{OPENROUTER}/api/v1/auth/keys"))
        .send_json(serde_json::json!({ "code": code, "code_verifier": verifier, "code_challenge_method": "S256" }))
        .map_err(|e| format!("Couldn't reach OpenRouter: {e}"))?;
    let status = response.status().as_u16();
    let body: serde_json::Value = response.body_mut().read_json().unwrap_or_default();
    match body["key"].as_str() {
        Some(key) if status == 200 => store_openrouter_key(key),
        _ => Err(format!("OpenRouter didn't hand over a key ({status}). Try connecting again.")),
    }
}

/// Answers browser requests until the callback with the code arrives.
fn wait_for_code(listener: &TcpListener, state: &str) -> Result<String, String> {
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let deadline = Instant::now() + CONNECT_TIMEOUT;
    while Instant::now() < deadline {
        let Ok((mut stream, _)) = listener.accept() else {
            thread::sleep(Duration::from_millis(100));
            continue;
        };
        let target = request_target(&mut stream).unwrap_or_default();
        if !target.starts_with("/callback") {
            respond(&mut stream, "404 Not Found", "Not found");
            continue;
        }
        let code = query_param(&target, "code").filter(|_| query_param(&target, "state").as_deref() == Some(state));
        let Some(code) = code else {
            respond(&mut stream, "400 Bad Request", "Daybook couldn't connect to OpenRouter. Close this tab and try again.");
            return Err("OpenRouter didn't finish connecting".into());
        };
        respond(&mut stream, "200 OK", "Daybook is connected to OpenRouter. You can close this tab.");
        return Ok(code);
    }
    Err("Timed out waiting for OpenRouter. Try connecting again.".into())
}

/// The path and query from an HTTP request line.
fn request_target(stream: &mut TcpStream) -> Option<String> {
    stream.set_nonblocking(false).ok()?;
    stream.set_read_timeout(Some(Duration::from_secs(5))).ok()?;
    let mut line = String::new();
    BufReader::new(stream.take(8192)).read_line(&mut line).ok()?;
    line.split_whitespace().nth(1).map(String::from)
}

fn respond(stream: &mut TcpStream, status: &str, message: &str) {
    let html = format!(
        "<!doctype html><meta charset=utf-8><title>Daybook</title>\
         <body style=\"font:16px -apple-system,system-ui,sans-serif;display:grid;place-items:center;height:90vh;margin:0;color:#333\">\
         <p>{message}</p>"
    );
    let _ = write!(
        stream,
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{html}",
        html.len()
    );
}

fn query_param(target: &str, name: &str) -> Option<String> {
    let query = target.split_once('?')?.1;
    query.split('&').find_map(|pair| {
        let (key, value) = pair.split_once('=')?;
        (key == name).then(|| percent_decode(value)).filter(|v| !v.is_empty())
    })
}

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let hex = bytes.get(i + 1..i + 3).and_then(|h| u8::from_str_radix(std::str::from_utf8(h).ok()?, 16).ok());
        match (bytes[i], hex) {
            (b'%', Some(byte)) => {
                out.push(byte);
                i += 3;
                continue;
            }
            (b'+', _) => out.push(b' '),
            (byte, _) => out.push(byte),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn random_token() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    security_framework::random::SecRandom::default()
        .copy_bytes(&mut bytes)
        .map_err(|e| format!("Couldn't start the sign-in: {e}"))?;
    Ok(base64url(&bytes))
}

fn challenge(verifier: &str) -> String {
    base64url(&Sha256::digest(verifier.as_bytes()))
}

/// Base64url without padding.
fn base64url(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = chunk.iter().enumerate().fold(0u32, |n, (i, b)| n | (*b as u32) << (16 - 8 * i));
        for i in 0..=chunk.len() {
            out.push(ALPHABET[(n >> (18 - 6 * i) & 63) as usize] as char);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64url_matches_rfc4648() {
        assert_eq!(base64url(b""), "");
        assert_eq!(base64url(b"f"), "Zg");
        assert_eq!(base64url(b"fo"), "Zm8");
        assert_eq!(base64url(b"foo"), "Zm9v");
        assert_eq!(base64url(b"foobar"), "Zm9vYmFy");
        assert_eq!(base64url(&[0xfb, 0xff, 0xbf]), "-_-_");
    }

    #[test]
    fn challenge_matches_rfc7636_example() {
        assert_eq!(challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    }

    #[test]
    fn random_tokens_differ() {
        let token = random_token().unwrap();
        assert_eq!(token.len(), 43);
        assert_ne!(token, random_token().unwrap());
    }

    #[test]
    fn reads_claude_result() {
        let ok = r#"{"type":"result","subtype":"success","is_error":false,"result":"","structured_output":{"ok":true}}"#;
        assert_eq!(claude_result(ok), Some(Ok(r#"{"ok":true}"#.into())));
        let failed = r#"{"type":"result","is_error":true,"result":"Not logged in · Please run /login"}"#;
        assert_eq!(claude_result(failed), Some(Err("Not logged in · Please run /login".into())));
        let empty = r#"{"type":"result","is_error":false,"result":""}"#;
        assert_eq!(claude_result(empty), Some(Err("Claude didn't return an answer".into())));
        assert_eq!(claude_result(r#"{"type":"system","subtype":"init"}"#), None);
        assert_eq!(claude_result("not json"), None);
    }

    #[test]
    fn reads_callback_query() {
        let target = "/callback?code=abc%2D123&state=xy+z";
        assert_eq!(query_param(target, "code").as_deref(), Some("abc-123"));
        assert_eq!(query_param(target, "state").as_deref(), Some("xy z"));
        assert_eq!(query_param(target, "missing"), None);
        assert_eq!(query_param("/callback?code=", "code"), None);
        assert_eq!(query_param("/callback", "code"), None);
    }

    #[test]
    fn prefs_fill_in_defaults() {
        let prefs: AgentPrefs = serde_json::from_str(r#"{"provider":"codex","claudeModel":""}"#).unwrap();
        assert_eq!(prefs.provider, Provider::Codex);
        assert_eq!(prefs.claude_model(), "sonnet");
        assert_eq!(prefs.openrouter_model(), OPENROUTER_MODEL);
    }
}
