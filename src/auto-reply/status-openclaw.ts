import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  fetchCommitBySha,
  fetchOpenClawUpstreamStatus,
} from "../infra/openclaw-upstream.js";
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

export type VersionMessageResult = {
  text: string;
  buttons?: ButtonRow[];
};

/**
 * Build /version message: CURRENT VERSION (image build) + NEW VERSION INSTALLED (upstream)
 * and an UPDATE button for Telegram.
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
  const currentCommitUrl = currentCommitRaw
    ? `https://github.com/openclaw/openclaw/commit/${currentCommitRaw}`
    : "https://github.com/openclaw/openclaw";

  // Fetch current commit details from GitHub so we can show Usuario, Description, Time, Total (same structure as upstream)
  const currentCommitRes = currentCommitRaw
    ? await fetchCommitBySha({ sha: currentCommitRaw })
    : { status: null };
  const currentCommitStatus = currentCommitRes.status;

  const currentTime =
    currentCommitStatus?.committedAtMs != null
      ? `${formatUtcTime(currentCommitStatus.committedAtMs)} - ${formatGithubAge(now - currentCommitStatus.committedAtMs)}`
      : build?.commitDateMs != null
        ? `${formatUtcTime(build.commitDateMs)} - ${formatGithubAge(now - build.commitDateMs)}`
        : formatBuiltAt(build?.builtAt, now);

  const currentAuthor = currentCommitStatus?.author ?? "—";
  const currentDescription =
    currentCommitStatus?.subject ?? build?.commitSubject?.trim().split("\n")[0] ?? "—";
  const currentTotal =
    currentCommitStatus?.totalCommits != null ? currentCommitStatus.totalCommits : "—";

  const currentLines = [
    "CURRENT VERSION",
    `🦞 OpenClaw ${currentVersion}`,
    `👤 Usuario: ${currentAuthor}`,
    `📝 Description: ${currentDescription}`,
    ...(currentCommit
      ? [`🔗 Commit: ${currentCommit} · ${currentCommitUrl}`]
      : []),
    `🕒 Time: ${currentTime}`,
    `🧮 Total: ${currentTotal} commits`,
  ];

  const { status: upstream, error } = await fetchOpenClawUpstreamStatus({ now });
  const upstreamTime =
    upstream?.committedAtMs != null
      ? `${formatUtcTime(upstream.committedAtMs)} - ${formatGithubAge(now - upstream.committedAtMs)}`
      : "unknown";
  const upstreamLines = [
    "",
    "NEW VERSION INSTALLED",
    `🦞 OpenClaw ${upstream ? "(upstream)" : currentVersion}`,
    ...(upstream
      ? [
          `👤 Usuario: ${upstream.author}`,
          `📝 Description: ${upstream.subject}`,
          `🔗 Commit: ${upstream.commit} · ${upstream.commitUrl}`,
          `🕒 Time: ${upstreamTime}`,
          `🧮 Total: ${typeof upstream.totalCommits === "number" ? upstream.totalCommits : "unknown"} commits`,
        ]
      : [
          error
            ? `⚠️ No pude consultar GitHub (${error})`
            : "⚠️ No pude consultar GitHub",
        ]),
    "",
    "🌐 Repo: https://github.com/openclaw/openclaw",
  ];

  const text = [...currentLines, ...upstreamLines].join("\n");
  const buttons: ButtonRow[] | undefined =
    includeUpdateButton ? [[{ text: "UPDATE", callback_data: VERSION_UPDATE_CALLBACK_DATA }]] : undefined;

  return { text, buttons };
}
