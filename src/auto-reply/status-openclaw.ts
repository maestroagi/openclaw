import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchOpenClawUpstreamStatus } from "../infra/openclaw-upstream.js";
import { VERSION } from "../version.js";

export type ButtonRow = Array<{ text: string; callback_data: string }>;

export const VERSION_UPDATE_CALLBACK_DATA = "version_update_trigger";

/** Build info from dist/build-info.json (current running image). */
type BuildInfo = {
  version?: string | null;
  commit?: string | null;
  builtAt?: string | null;
  commitDateMs?: number | null;
  commitSubject?: string | null;
};

/** Build metadata from OPENCLAW_BUILD_INFO_URL (new format with upstream + sync). */
export type BuildMetadata = {
  version?: string | null;
  built_at?: string | null;
  image?: string | null;
  custom?: {
    commit?: string | null;
    short?: string | null;
  };
  upstream?: {
    commit?: string | null;
    short?: string | null;
    author?: string | null;
    message?: string | null;
    date?: string | null;
    total_commits?: number | null;
    repo?: string | null;
  };
  sync?: {
    behind?: number | null;
    ahead?: number | null;
  };
};

/** Update state for UPDATE button (popup + optional message + action). */
export type VersionUpdateState = {
  popup: string;
  message: string | null;
  action: "trigger_update" | "none";
};

function readBuildInfo(): BuildInfo | null {
  const bases = [
    path.join(path.dirname(fileURLToPath(import.meta.url)), ".."),
    process.cwd(),
    path.join(process.cwd(), "dist"),
  ];
  for (const base of bases) {
    try {
      const p = path.join(base, "build-info.json");
      const raw = fs.readFileSync(p, "utf-8");
      const info = JSON.parse(raw) as BuildInfo;
      if (info && (info.commit != null || info.version != null)) {
        return info;
      }
    } catch {
      continue;
    }
  }
  return null;
}

function resolveBuildInfoUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.OPENCLAW_BUILD_INFO_URL?.trim() || env.OPENCLAW_BUILD_METADATA_URL?.trim() || null;
}

async function fetchBuildMetadata(params: {
  url: string;
  timeoutMs?: number;
}): Promise<{ metadata: BuildMetadata | null; error?: string }> {
  const timeoutMs = params.timeoutMs ?? 3500;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(250, timeoutMs));
  try {
    const res = await fetch(params.url, { signal: ctrl.signal });
    if (!res.ok) {
      return { metadata: null, error: `HTTP ${res.status}` };
    }
    const payload = (await res.json()) as BuildMetadata;
    if (!payload) {
      return { metadata: null, error: "invalid build metadata" };
    }
    const hasData =
      (payload.custom?.commit ?? payload.custom?.short) ||
      (payload.upstream?.commit ?? payload.upstream?.short) ||
      payload.built_at;
    if (!hasData) {
      return { metadata: null, error: "invalid build metadata" };
    }
    return { metadata: payload };
  } catch (err) {
    return { metadata: null, error: String(err) };
  } finally {
    clearTimeout(timer);
  }
}

function formatUtcTime(ms?: number | null): string {
  if (ms == null || !Number.isFinite(ms)) {
    return "unknown";
  }
  const iso = new Date(ms).toISOString();
  return `${iso.slice(11, 19)} UTC`;
}

function formatGithubAge(ms?: number | null): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) {
    return "unknown";
  }
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) {
    return "just now";
  }
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function formatBuiltAt(builtAt?: string | null, now?: number): string {
  if (!builtAt) {
    return "unknown";
  }
  const ms = new Date(builtAt).getTime();
  if (!Number.isFinite(ms)) {
    return "unknown";
  }
  const timeLabel = formatUtcTime(ms);
  const ageLabel = formatGithubAge((now ?? Date.now()) - ms);
  return ageLabel && ageLabel !== "unknown"
    ? `${timeLabel} - ${ageLabel}`
    : timeLabel;
}

function formatUpstreamDate(iso?: string | null, now?: number): string {
  if (!iso) return "—";
  const ms = new Date(iso).getTime();
  if (!Number.isFinite(ms)) return "—";
  return `${formatUtcTime(ms)} (${formatGithubAge((now ?? Date.now()) - ms)})`;
}

export type VersionMessageResult = {
  text: string;
  buttons?: ButtonRow[];
};

/**
 * Get update state for the UPDATE button: popup text, optional chat message, and whether to trigger pull+restart.
 */
export async function getVersionUpdateState(params?: {
  env?: NodeJS.ProcessEnv;
}): Promise<VersionUpdateState> {
  const env = params?.env ?? process.env;
  const build = readBuildInfo();
  const currentCommit = (build?.commit?.trim() ?? "").slice(0, 7) || null;

  const buildInfoUrl = resolveBuildInfoUrl(env);
  const { metadata } = buildInfoUrl
    ? await fetchBuildMetadata({ url: buildInfoUrl })
    : { metadata: null };

  const readyShort = metadata?.custom?.short?.trim() ?? metadata?.custom?.commit?.trim()?.slice(0, 7) ?? null;
  const behind = metadata?.sync?.behind ?? 0;
  const hasNewBuildReady = Boolean(readyShort && currentCommit && readyShort !== currentCommit);
  const isBehindUpstream = Number(behind) > 0;

  if (hasNewBuildReady) {
    return {
      popup: "🔄 Request to update SENT",
      message: "🔄 UPDATING to latest build…\n⏳ Wait 1–2 minutes",
      action: "trigger_update",
    };
  }
  if (isBehindUpstream) {
    return {
      popup: "✅ Updated to latest available build",
      message: "🕐 New upstream commits detected\n📦 New build incoming ~15 min\nCome back soon!",
      action: "none",
    };
  }
  return {
    popup: "✅ FULLY UP TO DATE",
    message: null,
    action: "none",
  };
}

/**
 * Build /version message: RUNNING (current build) + UPSTREAM (openclaw/openclaw) + SYNC STATUS.
 * Data comes from build-info.json (URL) when available; RUNNING from local build-info or readBuildInfo.
 * UPDATE button is always shown.
 */
export async function buildOpenClawStatusMessage(params?: {
  now?: number;
  includeUpdateButton?: boolean;
}): Promise<VersionMessageResult> {
  const now = params?.now ?? Date.now();
  const includeUpdateButton = params?.includeUpdateButton !== false;

  const build = readBuildInfo();
  const currentVersion = build?.version ?? VERSION;
  const currentCommitRaw = build?.commit?.trim() ?? null;
  const currentCommit = currentCommitRaw ? currentCommitRaw.slice(0, 7) : null;
  const runningBuiltAt = build?.builtAt ?? null;

  const buildInfoUrl = resolveBuildInfoUrl();
  const { metadata, error: fetchError } = buildInfoUrl
    ? await fetchBuildMetadata({ url: buildInfoUrl })
    : { metadata: null, error: "missing OPENCLAW_BUILD_INFO_URL" };

  const upstream = metadata?.upstream;
  const sync = metadata?.sync;
  const upstreamRepo = upstream?.repo ?? "openclaw/openclaw";
  const upstreamUrl = `https://github.com/${upstreamRepo}`;
  const upstreamCommitUrl = upstream?.commit
    ? `${upstreamUrl}/commit/${upstream.commit}`
    : upstreamUrl;

  const runningTime = formatBuiltAt(runningBuiltAt, now);
  const runningLines = [
    "🦞 OPENCLAW /VERSION",
    "",
    "📦 RUNNING",
    `OpenClaw v${currentVersion} · build ${currentCommit ?? "—"}`,
    `Built: ${runningTime}`,
  ];

  const upstreamShort = upstream?.short ?? upstream?.commit?.slice(0, 7) ?? "—";
  const upstreamAuthor = upstream?.author ?? "—";
  const upstreamMessage = (upstream?.message ?? "—").toString().split("\n")[0].trim();
  const upstreamTime = formatUpstreamDate(upstream?.date, now);
  const upstreamTotal =
    typeof upstream?.total_commits === "number"
      ? upstream.total_commits.toLocaleString()
      : "—";

  const upstreamLines = [
    "",
    "🌐 UPSTREAM (openclaw/openclaw)",
    `Latest: ${upstreamShort}`,
    `Author: ${upstreamAuthor}`,
    `Message: ${upstreamMessage}`,
    `Date: ${upstreamTime}`,
    `Commits: ${upstreamTotal} total`,
  ];

  if (!metadata?.upstream) {
    const fallback = await fetchOpenClawUpstreamStatus({ now });
    if (fallback.status) {
      const u = fallback.status;
      upstreamLines.length = 0;
      upstreamLines.push(
        "",
        "🌐 UPSTREAM (openclaw/openclaw)",
        `Latest: ${u.commit}`,
        `Author: ${u.author}`,
        `Message: ${u.subject}`,
        `Date: ${u.committedAtMs != null ? formatUtcTime(u.committedAtMs) + " (" + formatGithubAge(now - u.committedAtMs) + ")" : "—"}`,
        `Commits: ${typeof u.totalCommits === "number" ? u.totalCommits.toLocaleString() : "—"} total`,
      );
    } else if (fetchError) {
      upstreamLines.push("", `⚠️ Could not load upstream (${fetchError})`);
    }
  } else if (fetchError) {
    upstreamLines.push("", `⚠️ Could not load upstream (${fetchError})`);
  }

  const behindNum = sync?.behind ?? 0;
  const aheadNum = sync?.ahead ?? 0;
  const syncLines: string[] = [];
  if (metadata?.sync != null) {
    syncLines.push("", "🔄 SYNC STATUS");
    if (Number(behindNum) > 0) {
      syncLines.push(`Custom is ${behindNum} commit(s) behind upstream`);
    }
    if (Number(aheadNum) > 0) {
      syncLines.push(`Custom is ${aheadNum} commit(s) ahead of upstream`);
    }
    if (Number(behindNum) === 0 && Number(aheadNum) === 0) {
      syncLines.push("Custom is in sync with upstream");
    }
  }

  const text = [...runningLines, ...upstreamLines, ...syncLines].join("\n");
  const buttons: ButtonRow[] | undefined = includeUpdateButton
    ? [[{ text: "🔄 UPDATE", callback_data: VERSION_UPDATE_CALLBACK_DATA }]]
    : undefined;

  return { text, buttons };
}
