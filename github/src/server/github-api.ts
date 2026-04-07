import { createIntegrationClient } from "./holaboss-bridge"

const GITHUB_API = "https://api.github.com"
const github = createIntegrationClient("github")

async function ghfetch<T>(path: string): Promise<T> {
  const result = await github.proxy<T>({
    method: "GET",
    endpoint: `${GITHUB_API}${path}`,
  })
  if (result.status >= 400) {
    throw new Error(`GitHub API error (${result.status}): ${JSON.stringify(result.data).slice(0, 500)}`)
  }
  return result.data as T
}

export async function listUserRepos(username?: string, perPage = 10) {
  try {
    const path = username
      ? `/users/${username}/repos?sort=pushed&per_page=${perPage}`
      : `/user/repos?sort=pushed&per_page=${perPage}`
    const repos = await ghfetch<Array<Record<string, unknown>>>(path)
    return repos.map((r) => ({
      name: r.name as string,
      full_name: r.full_name as string,
      description: (r.description as string) ?? null,
      language: (r.language as string) ?? null,
      stargazers_count: r.stargazers_count as number,
      updated_at: r.updated_at as string,
      html_url: r.html_url as string,
      private: r.private as boolean,
    }))
  } catch (err) {
    throw err
  }
}

export async function listRecentCommits(owner: string, repo: string, perPage = 10) {
  try {
    const commits = await ghfetch<Array<Record<string, unknown>>>(
      `/repos/${owner}/${repo}/commits?per_page=${perPage}`,
    )
    return commits.map((c) => {
      const commit = c.commit as Record<string, unknown>
      const author = commit.author as Record<string, unknown>
      return {
        sha: c.sha as string,
        message: commit.message as string,
        author_name: author.name as string,
        author_date: author.date as string,
        html_url: c.html_url as string,
      }
    })
  } catch {
    return []
  }
}

export async function getCommit(owner: string, repo: string, sha: string) {
  try {
    const c = await ghfetch<Record<string, unknown>>(
      `/repos/${owner}/${repo}/commits/${sha}`,
    )
    const commit = c.commit as Record<string, unknown>
    const author = commit.author as Record<string, unknown>
    const stats = c.stats as Record<string, number> | undefined
    const files = (c.files as Array<Record<string, unknown>> | undefined) ?? []
    return {
      sha: c.sha as string,
      message: commit.message as string,
      author_name: author.name as string,
      author_date: author.date as string,
      html_url: c.html_url as string,
      stats: stats
        ? { additions: stats.additions, deletions: stats.deletions, total: stats.total }
        : { additions: 0, deletions: 0, total: 0 },
      files: files.slice(0, 20).map((f) => ({
        filename: f.filename as string,
        status: f.status as string,
        additions: f.additions as number,
        deletions: f.deletions as number,
      })),
    }
  } catch {
    return null
  }
}

export async function listPullRequests(owner: string, repo: string, state = "all", perPage = 10) {
  try {
    const prs = await ghfetch<Array<Record<string, unknown>>>(
      `/repos/${owner}/${repo}/pulls?state=${state}&sort=updated&per_page=${perPage}`,
    )
    return prs.map((pr) => {
      const user = pr.user as Record<string, unknown> | null
      return {
        number: pr.number as number,
        title: pr.title as string,
        state: pr.state as string,
        user: user ? (user.login as string) : null,
        created_at: pr.created_at as string,
        updated_at: pr.updated_at as string,
        html_url: pr.html_url as string,
        draft: pr.draft as boolean,
      }
    })
  } catch {
    return []
  }
}

export async function getPullRequest(owner: string, repo: string, number: number) {
  try {
    const pr = await ghfetch<Record<string, unknown>>(
      `/repos/${owner}/${repo}/pulls/${number}`,
    )
    const user = pr.user as Record<string, unknown> | null
    const body = (pr.body as string) ?? ""
    return {
      number: pr.number as number,
      title: pr.title as string,
      state: pr.state as string,
      body: body.length > 2000 ? body.slice(0, 2000) + "..." : body,
      user: user ? (user.login as string) : null,
      created_at: pr.created_at as string,
      merged_at: (pr.merged_at as string) ?? null,
      html_url: pr.html_url as string,
      additions: pr.additions as number,
      deletions: pr.deletions as number,
      changed_files: pr.changed_files as number,
    }
  } catch {
    return null
  }
}

export async function listReleases(owner: string, repo: string, perPage = 5) {
  try {
    const releases = await ghfetch<Array<Record<string, unknown>>>(
      `/repos/${owner}/${repo}/releases?per_page=${perPage}`,
    )
    return releases.map((r) => {
      const body = (r.body as string) ?? ""
      return {
        tag_name: r.tag_name as string,
        name: (r.name as string) ?? null,
        body: body.length > 1000 ? body.slice(0, 1000) + "..." : body,
        published_at: r.published_at as string,
        html_url: r.html_url as string,
        draft: r.draft as boolean,
        prerelease: r.prerelease as boolean,
      }
    })
  } catch {
    return []
  }
}

export async function listRecentActivity(owner: string, repo: string, days = 7) {
  let commits: Awaited<ReturnType<typeof listRecentCommits>> = []
  let pull_requests: Awaited<ReturnType<typeof listPullRequests>> = []
  let latest_release: Awaited<ReturnType<typeof listReleases>>[number] | null = null

  try {
    commits = await listRecentCommits(owner, repo, 20)
  } catch {
    /* partial failure ok */
  }

  try {
    pull_requests = await listPullRequests(owner, repo, "open", 10)
  } catch {
    /* partial failure ok */
  }

  try {
    const releases = await listReleases(owner, repo, 1)
    latest_release = releases.length > 0 ? releases[0] : null
  } catch {
    /* partial failure ok */
  }

  const releaseCount = latest_release ? 1 : 0
  const summary = `${commits.length} commits, ${pull_requests.length} open PRs, ${releaseCount} releases in last ${days} days`

  return {
    commits,
    pull_requests,
    latest_release,
    summary,
  }
}
