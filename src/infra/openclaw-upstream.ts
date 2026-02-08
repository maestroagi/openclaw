const OPENCLAW_REPO_URL = "https://github.com/openclaw/openclaw";
const OPENCLAW_COMMITS_URL = "https://api.github.com/repos/openclaw/openclaw/commits";
const CACHE_TTL_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 3500;

export type OpenClawUpstreamStatus = {
  author: string;
  subject: string;
  commit: string;
  commitUrl: string;
  committedAt: string | null;
  committedAtMs: number | null;
  totalCommits: number | null;
  repoUrl: string;
};

type StatusCacheEntry = {
  value: OpenClawUpstreamStatus;
  expiresAt: number;
};

export type FetchUpstreamStatusResult = {
  status: OpenClawUpstreamStatus | null;
  error?: string;
  cached?: boolean;
};

let cachedStatus: StatusCacheEntry | null = null;

function resolveGithubToken(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.GH_TOKEN ?? env.GITHUB_TOKEN ?? env.COPILOT_GITHUB_TOKEN ?? null;
}

async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
  init?: RequestInit,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(250, timeoutMs));
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

function parseLastPageCount(linkHeader: string | null): number | null {
  if (!linkHeader) {
    return null;
  }
  const parts = linkHeader.split(",");
  for (const part of parts) {
    const match = part.match(/<([^>]+)>;\s*rel="([^"]+)"/);
    if (!match || match[2] !== "last") {
      continue;
    }
    try {
      const url = new URL(match[1]);
      const page = url.searchParams.get("page");
      if (page && /^\d+$/.test(page)) {
        return Number(page);
      }
    } catch {
      // ignore malformed URL
    }
  }
  return null;
}

function firstLine(value?: string | null): string {
  if (!value) {
    return "unknown";
  }
  const trimmed = value.split(/\r?\n/)[0]?.trim();
  return trimmed ? trimmed : "unknown";
}

export async function fetchOpenClawUpstreamStatus(
  params: {
    timeoutMs?: number;
    now?: number;
    env?: NodeJS.ProcessEnv;
    forceRefresh?: boolean;
  } = {},
): Promise<FetchUpstreamStatusResult> {
  const now = params.now ?? Date.now();
  if (!params.forceRefresh && cachedStatus && cachedStatus.expiresAt > now) {
    return { status: cachedStatus.value, cached: true };
  }

  const token = resolveGithubToken(params.env);
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "OpenClaw",
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  try {
    const url = `${OPENCLAW_COMMITS_URL}?sha=main&per_page=1`;
    const res = await fetchWithTimeout(url, timeoutMs, { headers });
    if (!res.ok) {
      return { status: null, error: `HTTP ${res.status}` };
    }

    const payload = (await res.json()) as Array<{
      sha?: string;
      html_url?: string;
      author?: { login?: string | null } | null;
      commit?: {
        message?: string | null;
        author?: { name?: string | null; date?: string | null } | null;
        committer?: { name?: string | null; date?: string | null } | null;
      } | null;
    }>;

    const entry = payload?.[0];
    if (!entry) {
      return { status: null, error: "empty response" };
    }

    const fullSha = entry.sha?.trim() ?? "";
    const commit = fullSha ? fullSha.slice(0, 7) : "unknown";
    const commitUrl = fullSha
      ? `${OPENCLAW_REPO_URL}/commit/${fullSha}`
      : `${OPENCLAW_REPO_URL}/commits/main`;
    const subject = firstLine(entry.commit?.message);
    const author =
      entry.author?.login?.trim() ||
      entry.commit?.author?.name?.trim() ||
      entry.commit?.committer?.name?.trim() ||
      "unknown";
    const committedAt = entry.commit?.author?.date ?? entry.commit?.committer?.date ?? null;
    const committedAtMs = committedAt ? Date.parse(committedAt) : NaN;
    const totalCommits =
      parseLastPageCount(res.headers.get("link")) ??
      (Array.isArray(payload) ? payload.length : null);

    const status: OpenClawUpstreamStatus = {
      author,
      subject,
      commit,
      commitUrl,
      committedAt,
      committedAtMs: Number.isNaN(committedAtMs) ? null : committedAtMs,
      totalCommits: Number.isFinite(totalCommits ?? NaN) ? totalCommits : null,
      repoUrl: OPENCLAW_REPO_URL,
    };

    cachedStatus = { value: status, expiresAt: now + CACHE_TTL_MS };
    return { status };
  } catch (err) {
    return { status: null, error: String(err) };
  }
}

const OPENCLAW_COMMIT_BY_SHA_URL = "https://api.github.com/repos/openclaw/openclaw/commits";

/**
 * Fetch a single commit by SHA (full or short) to get author, subject, date for CURRENT VERSION.
 */
export async function fetchCommitBySha(params: {
  sha: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}): Promise<FetchUpstreamStatusResult> {
  const sha = params.sha?.trim();
  if (!sha) {
    return { status: null, error: "missing sha" };
  }
  const token = resolveGithubToken(params.env ?? process.env);
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "OpenClaw",
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  try {
    const url = `${OPENCLAW_COMMIT_BY_SHA_URL}/${sha}`;
    const res = await fetchWithTimeout(url, timeoutMs, { headers });
    if (!res.ok) {
      return { status: null, error: `HTTP ${res.status}` };
    }
    const entry = (await res.json()) as {
      sha?: string;
      html_url?: string;
      author?: { login?: string | null } | null;
      commit?: {
        message?: string | null;
        author?: { name?: string | null; date?: string | null } | null;
        committer?: { name?: string | null; date?: string | null } | null;
      } | null;
    };
    const fullSha = entry.sha?.trim() ?? "";
    const commitShort = fullSha ? fullSha.slice(0, 7) : "unknown";
    const commitUrl = fullSha
      ? `${OPENCLAW_REPO_URL}/commit/${fullSha}`
      : `${OPENCLAW_REPO_URL}/commits/main`;
    const subject = firstLine(entry.commit?.message);
    const author =
      entry.author?.login?.trim() ||
      entry.commit?.author?.name?.trim() ||
      entry.commit?.committer?.name?.trim() ||
      "unknown";
    const committedAt = entry.commit?.author?.date ?? entry.commit?.committer?.date ?? null;
    const committedAtMs = committedAt ? Date.parse(committedAt) : NaN;
    const status: OpenClawUpstreamStatus = {
      author,
      subject,
      commit: commitShort,
      commitUrl,
      committedAt,
      committedAtMs: Number.isNaN(committedAtMs) ? null : committedAtMs,
      totalCommits: null,
      repoUrl: OPENCLAW_REPO_URL,
    };
    return { status };
  } catch (err) {
    return { status: null, error: String(err) };
  }
}
