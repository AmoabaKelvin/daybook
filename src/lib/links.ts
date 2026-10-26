export type LinkInfo =
  | { kind: 'github'; type: 'pull' | 'issue' | 'commit' | 'repo' | 'other'; ref: string }
  | { kind: 'slack'; ref: string }
  | { kind: 'linear'; ref: string }
  | { kind: 'web'; ref: string }

const URL_ONLY = /^https?:\/\/\S+$/

export function isUrl(text: string) {
  return URL_ONLY.test(text.trim())
}

export function classify(href: string): LinkInfo {
  let url: URL
  try {
    url = new URL(href)
  } catch {
    return { kind: 'web', ref: href }
  }
  const parts = url.pathname.split('/').filter(Boolean)

  if (url.hostname === 'github.com' && parts.length >= 2) {
    const [, repo, section, id] = parts
    if (section === 'pull' && id) return { kind: 'github', type: 'pull', ref: `${repo}#${id}` }
    if (section === 'issues' && id) return { kind: 'github', type: 'issue', ref: `${repo}#${id}` }
    if (section === 'commit' && id) return { kind: 'github', type: 'commit', ref: `${repo}@${id.slice(0, 7)}` }
    if (parts.length === 2) return { kind: 'github', type: 'repo', ref: `${parts[0]}/${repo}` }
    return { kind: 'github', type: 'other', ref: `${repo}/${parts.slice(2).join('/')}` }
  }

  if (url.hostname.endsWith('.slack.com') || url.hostname === 'app.slack.com') {
    const workspace = url.hostname.replace('.slack.com', '')
    const isThread = url.searchParams.has('thread_ts')
    return { kind: 'slack', ref: `${workspace === 'app' ? 'Slack' : workspace} ${isThread ? 'thread' : 'message'}` }
  }

  if (url.hostname === 'linear.app') {
    const issue = parts.indexOf('issue')
    if (issue >= 0 && parts[issue + 1]) return { kind: 'linear', ref: parts[issue + 1].toUpperCase() }
  }

  return { kind: 'web', ref: url.hostname.replace(/^www\./, '') + (url.pathname === '/' ? '' : url.pathname) }
}

/** The text a bare pasted URL should show until (or unless) we learn something better. */
export function labelFor(href: string) {
  return classify(href).ref
}

/** Links we can look up a title and state for: GitHub PRs and issues (via `gh`) and Linear issues. */
export function isEnrichable(href: string) {
  const info = classify(href)
  return (info.kind === 'github' && (info.type === 'pull' || info.type === 'issue')) || info.kind === 'linear'
}
