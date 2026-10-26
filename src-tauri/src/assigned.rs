//! Work waiting on you: PRs that want your review and issues and PRs assigned to you
//! (through `gh`), and the Linear issues assigned to you.

use crate::links::{gh, linear_query, Links};
use serde::Serialize;
use std::collections::HashSet;
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

const TTL: Duration = Duration::from_secs(60);
const REVIEW: &str = "review-requested:@me is:pr is:open archived:false";
const ASSIGNED: &str = "assignee:@me is:open archived:false";
const SEARCH_JQ: &str = "[.items[] | {url: .html_url, title, pull: (.pull_request != null), draft, updated: .updated_at}]";
const LINEAR_ASSIGNED: &str = r#"{ viewer { assignedIssues(filter: { state: { type: { nin: ["completed", "canceled", "duplicate"] } } }, first: 100, orderBy: updatedAt) { nodes { identifier title url updatedAt state { name type } } } } }"#;

static CACHE: Mutex<Option<(Instant, Assigned)>> = Mutex::new(None);

#[derive(Serialize, Clone)]
pub struct Item {
    source: &'static str,
    kind: &'static str,
    url: String,
    title: String,
    #[serde(rename = "ref")]
    reference: String,
    /// GitHub: open or draft. Linear: the state type, as in `LinkInfo`.
    state: String,
    /// Linear's own name for the state, like "In Review".
    status: Option<String>,
    /// "review" for PRs waiting on your review, otherwise "assigned".
    group: &'static str,
    /// Milliseconds since the epoch.
    updated: i64,
}

/// A source is None when it isn't connected (no `gh` login, no Linear key) or couldn't be loaded.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Assigned {
    github: Option<Vec<Item>>,
    linear: Option<Vec<Item>>,
    github_error: Option<String>,
    linear_error: Option<String>,
}

/// Blocking: asks GitHub and Linear at the same time. Answers from a short cache unless `fresh`.
pub fn fetch(links: &Links, fresh: bool) -> Assigned {
    if !fresh {
        if let Some((at, cached)) = CACHE.lock().unwrap().as_ref() {
            if at.elapsed() < TTL {
                return cached.clone();
            }
        }
    }
    let ((github, github_error), (linear, linear_error)) = thread::scope(|scope| {
        let linear = scope.spawn(|| match links.linear_key().map(|key| linear_issues(&key)) {
            None => (None, None),
            Some(Ok(items)) => (Some(items), None),
            Some(Err(error)) => (None, Some(error)),
        });
        (github(), linear.join().unwrap_or((None, Some("Couldn't load Linear.".into()))))
    });
    let assigned = Assigned { github, linear, github_error, linear_error };
    if assigned.github_error.is_none() && assigned.linear_error.is_none() {
        *CACHE.lock().unwrap() = Some((Instant::now(), assigned.clone()));
    }
    assigned
}

/// Review requests first; anything that's both a review request and assigned shows once, as a review.
fn github() -> (Option<Vec<Item>>, Option<String>) {
    let (review, assigned) = thread::scope(|scope| {
        let review = scope.spawn(|| search(REVIEW, "review"));
        let assigned = search(ASSIGNED, "assigned");
        (review.join().ok().flatten(), assigned)
    });
    match (review, assigned) {
        (Some(review), Some(assigned)) => {
            let seen: HashSet<String> = review.iter().map(|item| item.url.clone()).collect();
            let items = review.into_iter().chain(assigned.into_iter().filter(|item| !seen.contains(&item.url))).collect();
            (Some(items), None)
        }
        // `gh auth token` fails when nobody is signed in, without going to the network.
        _ if gh(&["auth", "token"]).is_none() => (None, None),
        _ => (None, Some("Couldn't reach GitHub.".into())),
    }
}

fn search(query: &str, group: &'static str) -> Option<Vec<Item>> {
    let q = format!("q={query}");
    let out = gh(&["api", "-X", "GET", "search/issues", "-f", &q, "-f", "sort=updated", "-f", "per_page=50", "--jq", SEARCH_JQ])?;
    let found: Vec<serde_json::Value> = serde_json::from_slice(&out).ok()?;
    Some(found.iter().filter_map(|item| github_item(item, group)).collect())
}

fn github_item(found: &serde_json::Value, group: &'static str) -> Option<Item> {
    let url = found["url"].as_str()?;
    let parts: Vec<&str> = url.strip_prefix("https://github.com/")?.split('/').collect();
    let [_, repo, _, number] = parts.as_slice() else { return None };
    Some(Item {
        source: "github",
        kind: if found["pull"] == true { "pull" } else { "issue" },
        url: url.to_string(),
        title: found["title"].as_str()?.to_string(),
        reference: format!("{repo}#{number}"),
        state: if found["draft"] == true { "draft" } else { "open" }.into(),
        status: None,
        group,
        updated: millis(&found["updated"]),
    })
}

fn linear_issues(key: &str) -> Result<Vec<Item>, String> {
    let data = linear_query(key, LINEAR_ASSIGNED, serde_json::json!({}))?;
    let nodes = data["viewer"]["assignedIssues"]["nodes"].as_array().cloned().unwrap_or_default();
    Ok(nodes
        .iter()
        .filter_map(|issue| {
            Some(Item {
                source: "linear",
                kind: "issue",
                url: issue["url"].as_str()?.to_string(),
                title: issue["title"].as_str()?.to_string(),
                reference: issue["identifier"].as_str()?.to_string(),
                state: issue["state"]["type"].as_str().unwrap_or("unstarted").to_string(),
                status: issue["state"]["name"].as_str().map(String::from),
                group: "assigned",
                updated: millis(&issue["updatedAt"]),
            })
        })
        .collect())
}

fn millis(time: &serde_json::Value) -> i64 {
    time.as_str().and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok()).map_or(0, |t| t.timestamp_millis())
}
