import { execFile } from 'node:child_process'
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { Plugin } from 'vite'
import { summarize } from '../shared/summary.ts'

const run = promisify(execFile)

// Notes live as plain markdown files, one per day, so they stay readable outside the app.
const NOTES_DIR = resolve(process.env.DAYBOOK_DIR?.replace(/^~/, homedir()) ?? join(homedir(), 'Daybook'))
const ID = /^[a-z0-9-]{1,64}$/
const KEEP_WHEN_EMPTY = new Set(['backlog'])

type GithubInfo = { title: string; state: 'open' | 'closed' | 'merged' | 'draft'; kind: 'pull' | 'issue' }
const githubCache = new Map<string, { at: number; info: GithubInfo | null }>()
const GITHUB_TTL = 2 * 60 * 1000

type WorkItem = {
  source: 'github'
  kind: 'pull' | 'issue'
  url: string
  title: string
  ref: string
  state: 'open' | 'draft'
  status: null
  group: 'review' | 'assigned'
  updated: number
}
type Assigned = { github: WorkItem[] | null; linear: null; githubError: string | null; linearError: null }
let assignedCache: { at: number; value: Assigned } | null = null
const ASSIGNED_TTL = 60 * 1000
const SEARCH_JQ = '[.items[] | {url: .html_url, title, pull: (.pull_request != null), draft, updated: .updated_at}]'

function send(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status
  res.setHeader('content-type', typeof body === 'string' ? 'text/markdown; charset=utf-8' : 'application/json')
  res.end(typeof body === 'string' ? body : JSON.stringify(body))
}

async function readBody(req: IncomingMessage) {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

async function listNotes() {
  const files = (await readdir(NOTES_DIR)).filter((f) => f.endsWith('.md'))
  const notes = await Promise.all(
    files.map(async (file) => {
      const path = join(NOTES_DIR, file)
      const [content, info] = await Promise.all([readFile(path, 'utf8'), stat(path)])
      return summarize(file.slice(0, -3), content, info.mtimeMs)
    }),
  )
  return notes.filter((n) => ID.test(n.id))
}

async function githubInfo(url: string): Promise<GithubInfo | null> {
  const match = url.match(/^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(pull|issues)\/(\d+)/)
  if (!match) return null
  const [, owner, repo, type, number] = match
  const key = `${owner}/${repo}/${type}/${number}`
  const cached = githubCache.get(key)
  if (cached && Date.now() - cached.at < GITHUB_TTL) return cached.info

  const endpoint = type === 'pull' ? `repos/${owner}/${repo}/pulls/${number}` : `repos/${owner}/${repo}/issues/${number}`
  let info: GithubInfo | null = null
  try {
    const { stdout } = await run('gh', ['api', endpoint, '--jq', '{title,state,merged,draft}'], { timeout: 8000 })
    const data = JSON.parse(stdout) as { title: string; state: string; merged?: boolean; draft?: boolean }
    const state = data.merged ? 'merged' : data.draft && data.state === 'open' ? 'draft' : data.state === 'open' ? 'open' : 'closed'
    info = { title: data.title, state, kind: type === 'pull' ? 'pull' : 'issue' }
  } catch {
    // gh missing, not authenticated, or no access: the link still works, it just isn't enriched.
  }
  githubCache.set(key, { at: Date.now(), info })
  return info
}

async function search(query: string, group: WorkItem['group']): Promise<WorkItem[]> {
  const args = ['api', '-X', 'GET', 'search/issues', '-f', `q=${query}`, '-f', 'sort=updated', '-f', 'per_page=50', '--jq', SEARCH_JQ]
  const { stdout } = await run('gh', args, { timeout: 8000 })
  const found = JSON.parse(stdout) as { url: string; title: string; pull: boolean; draft: boolean | null; updated: string }[]
  return found.map((item) => {
    const [, , repo, , number] = new URL(item.url).pathname.split('/')
    return {
      source: 'github',
      kind: item.pull ? 'pull' : 'issue',
      url: item.url,
      title: item.title,
      ref: `${repo}#${number}`,
      state: item.draft ? 'draft' : 'open',
      status: null,
      group,
      updated: Date.parse(item.updated),
    }
  })
}

/** Review requests and assignments through `gh`. Linear needs the Mac app, where its key lives. */
async function assigned(fresh: boolean): Promise<Assigned> {
  if (!fresh && assignedCache && Date.now() - assignedCache.at < ASSIGNED_TTL) return assignedCache.value
  let value: Assigned
  try {
    const [review, mine] = await Promise.all([
      search('review-requested:@me is:pr is:open archived:false', 'review'),
      search('assignee:@me is:open archived:false', 'assigned'),
    ])
    const seen = new Set(review.map((item) => item.url))
    value = { github: [...review, ...mine.filter((item) => !seen.has(item.url))], linear: null, githubError: null, linearError: null }
  } catch {
    const signedIn = await run('gh', ['auth', 'token']).then(() => true, () => false)
    value = { github: null, linear: null, githubError: signedIn ? "Couldn't reach GitHub." : null, linearError: null }
  }
  if (!value.githubError) assignedCache = { at: Date.now(), value }
  return value
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://local')
  const path = url.pathname.replace(/^\/api/, '')

  if (path === '/notes' && req.method === 'GET') return send(res, 200, await listNotes())

  if (path === '/github' && req.method === 'GET') {
    return send(res, 200, await githubInfo(url.searchParams.get('url') ?? ''))
  }

  if (path === '/assigned' && req.method === 'GET') return send(res, 200, await assigned(url.searchParams.has('fresh')))

  const note = path.match(/^\/notes\/([^/]+)$/)
  if (note && ID.test(note[1])) {
    const id = note[1]
    const file = join(NOTES_DIR, `${id}.md`)
    if (req.method === 'GET') {
      const content = await readFile(file, 'utf8').catch(() => '')
      return send(res, 200, content)
    }
    if (req.method === 'PUT') {
      const content = await readBody(req)
      if (!content.trim() && !KEEP_WHEN_EMPTY.has(id)) {
        await unlink(file).catch(() => {})
        return send(res, 200, { id, deleted: true })
      }
      const tmp = `${file}.${process.pid}.tmp`
      await writeFile(tmp, content.endsWith('\n') ? content : `${content}\n`)
      await rename(tmp, file)
      return send(res, 200, summarize(id, content))
    }
  }

  send(res, 404, { error: 'not found' })
}

export function daybookApi(): Plugin {
  const middleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    if (!req.url?.startsWith('/api/')) return next()
    handle(req, res).catch((error: Error) => send(res, 500, { error: error.message }))
  }
  return {
    name: 'daybook-api',
    async configureServer(server) {
      await mkdir(NOTES_DIR, { recursive: true })
      server.config.logger.info(`  daybook notes → ${NOTES_DIR}`)
      server.middlewares.use(middleware)
    },
    async configurePreviewServer(server) {
      await mkdir(NOTES_DIR, { recursive: true })
      server.middlewares.use(middleware)
    },
  }
}
