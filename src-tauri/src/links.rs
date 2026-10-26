//! Live details for links: GitHub PRs and issues through `gh`, Linear issues through its API.

use serde::Serialize;
use std::collections::HashMap;
use std::path::Path;
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, Instant};

const TTL: Duration = Duration::from_secs(120);
const KEYCHAIN_SERVICE: &str = "daybook";
const KEYCHAIN_LINEAR: &str = "linear";
const LINEAR_API: &str = "https://api.linear.app/graphql";

#[derive(Serialize, Clone)]
pub struct LinkInfo {
    pub title: String,
    /// GitHub: open, draft, merged or closed. Linear: the state type (triage, backlog,
    /// unstarted, started, completed, canceled).
    pub state: String,
    /// Linear's own name for the state, like "In Review".
    pub status: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct LinearAccount {
    pub name: String,
    pub workspace: String,
}

enum Target {
    Github { owner: String, repo: String, kind: String, number: String },
    Linear { identifier: String },
}

fn target(url: &str) -> Option<(String, Target)> {
    let rest = url.split(['?', '#']).next()?;
    if let Some(path) = rest.strip_prefix("https://github.com/") {
        let parts: Vec<&str> = path.split('/').collect();
        let [owner, repo, kind @ ("pull" | "issues"), number, ..] = parts.as_slice() else { return None };
        if number.is_empty() || !number.chars().all(|c| c.is_ascii_digit()) {
            return None;
        }
        let key = format!("github:{owner}/{repo}/{kind}/{number}");
        return Some((key, Target::Github { owner: owner.to_string(), repo: repo.to_string(), kind: kind.to_string(), number: number.to_string() }));
    }
    if let Some(path) = rest.strip_prefix("https://linear.app/") {
        let parts: Vec<&str> = path.split('/').collect();
        let index = parts.iter().position(|p| *p == "issue")?;
        let identifier = parts.get(index + 1)?.to_ascii_uppercase();
        let (team, number) = identifier.split_once('-')?;
        if team.is_empty() || number.is_empty() || !number.chars().all(|c| c.is_ascii_digit()) {
            return None;
        }
        return Some((format!("linear:{identifier}"), Target::Linear { identifier }));
    }
    None
}

pub struct Links {
    cache: Mutex<HashMap<String, (Instant, Option<LinkInfo>)>>,
    /// The Linear key, read from the Keychain once and kept until it changes.
    linear_key: Mutex<Option<Option<String>>>,
}

impl Links {
    pub fn new() -> Self {
        Links { cache: Mutex::new(HashMap::new()), linear_key: Mutex::new(None) }
    }

    /// Blocking: runs `gh` or calls Linear. Call it off the main thread.
    pub fn lookup(&self, url: &str) -> Option<LinkInfo> {
        let (key, target) = target(url)?;
        if let Some((at, info)) = self.cache.lock().unwrap().get(&key) {
            if at.elapsed() < TTL {
                return info.clone();
            }
        }
        let info = match target {
            Target::Github { owner, repo, kind, number } => github(&owner, &repo, &kind, &number),
            Target::Linear { identifier } => self.linear_key().and_then(|k| linear_issue(&k, &identifier)),
        };
        self.cache.lock().unwrap().insert(key, (Instant::now(), info.clone()));
        info
    }

    pub fn linear_key(&self) -> Option<String> {
        let mut cached = self.linear_key.lock().unwrap();
        cached
            .get_or_insert_with(|| {
                security_framework::passwords::get_generic_password(KEYCHAIN_SERVICE, KEYCHAIN_LINEAR)
                    .ok()
                    .and_then(|bytes| String::from_utf8(bytes).ok())
            })
            .clone()
    }

    /// Checks the key against Linear before keeping it in the Keychain.
    pub fn set_linear_key(&self, key: &str) -> Result<LinearAccount, String> {
        let key = key.trim();
        let account = linear_account(key)?;
        security_framework::passwords::set_generic_password(KEYCHAIN_SERVICE, KEYCHAIN_LINEAR, key.as_bytes())
            .map_err(|e| format!("Couldn't save to the Keychain: {e}"))?;
        *self.linear_key.lock().unwrap() = Some(Some(key.to_string()));
        self.forget("linear:");
        Ok(account)
    }

    pub fn clear_linear_key(&self) {
        let _ = security_framework::passwords::delete_generic_password(KEYCHAIN_SERVICE, KEYCHAIN_LINEAR);
        *self.linear_key.lock().unwrap() = Some(None);
        self.forget("linear:");
    }

    fn forget(&self, prefix: &str) {
        self.cache.lock().unwrap().retain(|key, _| !key.starts_with(prefix));
    }
}

/// Apps opened from Finder get a bare PATH, so look where Homebrew puts `gh`.
fn gh_binary() -> &'static str {
    ["/opt/homebrew/bin/gh", "/usr/local/bin/gh"].into_iter().find(|p| Path::new(p).exists()).unwrap_or("gh")
}

fn gh(args: &[&str]) -> Option<Vec<u8>> {
    let output = Command::new(gh_binary()).args(args).output().ok()?;
    output.status.success().then_some(output.stdout)
}

fn github(owner: &str, repo: &str, kind: &str, number: &str) -> Option<LinkInfo> {
    let endpoint = match kind {
        "pull" => format!("repos/{owner}/{repo}/pulls/{number}"),
        _ => format!("repos/{owner}/{repo}/issues/{number}"),
    };
    let data: serde_json::Value = serde_json::from_slice(&gh(&["api", &endpoint, "--jq", "{title,state,merged,draft}"])?).ok()?;
    let open = data["state"] == "open";
    let state = match () {
        _ if data["merged"] == true => "merged",
        _ if open && data["draft"] == true => "draft",
        _ if open => "open",
        _ => "closed",
    };
    Some(LinkInfo { title: data["title"].as_str()?.to_string(), state: state.into(), status: None })
}

/// The GitHub account `gh` is signed in as, if any.
pub fn github_login() -> Option<String> {
    let login = String::from_utf8(gh(&["api", "user", "--jq", ".login"])?).ok()?;
    Some(login.trim().to_string()).filter(|l| !l.is_empty())
}

fn linear_query(key: &str, query: &str, variables: serde_json::Value) -> Result<serde_json::Value, String> {
    let mut response = ureq::post(LINEAR_API)
        .header("Authorization", key)
        .send_json(serde_json::json!({ "query": query, "variables": variables }))
        .map_err(|e| match e {
            ureq::Error::StatusCode(400 | 401 | 403) => "Linear didn't accept that key.".to_string(),
            e => format!("Couldn't reach Linear: {e}"),
        })?;
    let body: serde_json::Value = response.body_mut().read_json().map_err(|e| e.to_string())?;
    if let Some(message) = body["errors"][0]["message"].as_str() {
        return Err(message.to_string());
    }
    Ok(body["data"].clone())
}

pub fn linear_account(key: &str) -> Result<LinearAccount, String> {
    let data = linear_query(key, "{ viewer { name } organization { name } }", serde_json::json!({}))?;
    Ok(LinearAccount {
        name: data["viewer"]["name"].as_str().unwrap_or_default().to_string(),
        workspace: data["organization"]["name"].as_str().unwrap_or_default().to_string(),
    })
}

fn linear_issue(key: &str, identifier: &str) -> Option<LinkInfo> {
    let query = "query($id: String!) { issue(id: $id) { title state { name type } } }";
    let data = linear_query(key, query, serde_json::json!({ "id": identifier })).ok()?;
    let issue = &data["issue"];
    Some(LinkInfo {
        title: issue["title"].as_str()?.to_string(),
        state: issue["state"]["type"].as_str().unwrap_or("unstarted").to_string(),
        status: issue["state"]["name"].as_str().map(String::from),
    })
}
