import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  fetchOpenClawUpstreamStatus,
  fetchCommitBySha,
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

/** Build metadata from OPENCLAW_BUILD_INFO_URL (new format with upstream + sync). */
export type BuildMetadata = {
  version?: string | null;
  built_at?: string | null;
  image?: string | null;
  custom?: {
    commit?: string | null;
    short?: string | null;
    author?: string | null;
    message?: string | null;
    date?: string | null;
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

export type VersionMessageResult = {
  text: string;
  buttons?: ButtonRow[];
};

// ─── Internal helpers ────────────────────────────────────────────

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

// ─── Date/time formatting ────────────────────────────────────────

function formatUtcDateTime(ms?: number | null): string {
  if (ms == null || !Number.isFinite(ms)) return "—";
  const d = new Date(ms);
  const date = d.toISOString().slice(0, 10);
  const time = d.toISOString().slice(11, 16);
  return `${date} ${time} UTC`;
}

function formatAge(ms?: number | null): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function formatDateWithAge(iso?: string | null, now?: number): string {
  if (!iso) return "—";
  const ms = new Date(iso).getTime();
  if (!Number.isFinite(ms)) return "—";
  const age = formatAge((now ?? Date.now()) - ms);
  return age ? `${formatUtcDateTime(ms)} (${age})` : formatUtcDateTime(ms);
}

function formatBuiltAt(builtAt?: string | null, now?: number): string {
  if (!builtAt) return "—";
  return formatDateWithAge(builtAt, now);
}

// ─── Sub-block formatting (upstream / custom) ────────────────────

const SEPARATOR = "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━";

interface SubBlockData {
  type: "upstream" | "custom";
  commitShort?: string | null;
  author?: string | null;
  message?: string | null;
  date?: string | null;
  commitUrl?: string | null;
  totalInfo?: string | null;
  changed: boolean;
  available: boolean;
  showIndicator?: boolean; // false for RUNNING (always full), true for READY/QUEUED
  now?: number;
}

function formatSubBlock(data: SubBlockData): string {
  const icon = data.type === "upstream" ? "🌐" : "🔧";
  const label = data.type === "upstream" ? "Upstream" : "Custom";

  if (!data.available || !data.commitShort) {
    return `  ${icon} ${label}: —`;
  }

  // In READY/QUEUED: unchanged sub-block shows "✅ same"
  if (data.showIndicator && !data.changed) {
    return `  ${icon} ${label}: ${data.commitShort} ✅ same\n     (sin cambios)`;
  }

  const authorPart = data.author ? ` · ${data.author}` : "";
  const indicator = data.showIndicator && data.changed ? " ⬆️ 𝗡𝗘𝗪" : "";
  const lines = [
    `  ${icon} ${label}: ${data.commitShort}${authorPart}${indicator}`,
  ];

  if (data.message) lines.push(`     📝 ${data.message.split("\n")[0].trim()}`);
  if (data.date) lines.push(`     🕐 ${formatDateWithAge(data.date, data.now)}`);
  if (data.commitUrl) lines.push(`     🔗 ${data.commitUrl}`);
  if (data.totalInfo) lines.push(`     📊 ${data.totalInfo}`);

  return lines.join("\n");
}

// ─── Version block formatting (RUNNING, READY, QUEUED) ───────────

interface VersionBlockData {
  title: string;
  emoji: string;
  version?: string | null;
  upstream: SubBlockData;
  custom: SubBlockData;
  builtAt?: string | null;
  isEmpty: boolean;
  emptyMessage?: string;
  now?: number;
}

function formatVersionBlock(data: VersionBlockData): string {
  if (data.isEmpty) {
    const lines = [`${data.emoji} ${data.title}`];
    if (data.emptyMessage) {
      for (const l of data.emptyMessage.split("\n")) {
        lines.push(`  ${l}`);
      }
    }
    return lines.join("\n");
  }

  const lines = [`${data.emoji} ${data.title}`];

  if (data.version) lines.push(`🦞 OpenClaw v${data.version}`);
  lines.push("");
  lines.push(formatSubBlock(data.upstream));
  lines.push("");
  lines.push(formatSubBlock(data.custom));

  if (data.builtAt) {
    lines.push("");
    lines.push(`  🔨 Built: ${formatBuiltAt(data.builtAt, data.now)}`);
  }

  return lines.join("\n");
}

// ─── Public API ──────────────────────────────────────────────────

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
 * Build /version message with 4 Unicode bold blocks:
 *   📦 𝗥𝗨𝗡𝗡𝗜𝗡𝗚 𝗕𝗨𝗜𝗟𝗗  — current running container
 *   ✅ 𝗥𝗘𝗔𝗗𝗬 𝗧𝗢 𝗨𝗣𝗗𝗔𝗧𝗘 — latest built image (from build-info URL)
 *   🔜 𝗤𝗨𝗘𝗨𝗘𝗗 𝗕𝗨𝗜𝗟𝗗     — new upstream commits not yet built
 *   🔄 𝗦𝗬𝗡𝗖 𝗦𝗧𝗔𝗧𝗨𝗦     — behind/ahead of upstream
 *
 * UPDATE button shown when READY has a different commit than RUNNING.
 */
export async function buildOpenClawStatusMessage(params?: {
  now?: number;
  includeUpdateButton?: boolean;
}): Promise<VersionMessageResult> {
  const now = params?.now ?? Date.now();
  const includeUpdateButton = params?.includeUpdateButton !== false;

  // ── 1. RUNNING data: local build-info.json ──
  const build = readBuildInfo();
  const runningVersion = build?.version ?? VERSION;
  const runningCommitRaw = build?.commit?.trim() ?? null;
  const runningCommit = runningCommitRaw ? runningCommitRaw.slice(0, 7) : null;
  const runningBuiltAt = build?.builtAt ?? null;

  // ── 2. READY data: from build metadata URL ──
  const buildInfoUrl = resolveBuildInfoUrl();
  const { metadata, error: metaError } = buildInfoUrl
    ? await fetchBuildMetadata({ url: buildInfoUrl })
    : { metadata: null, error: "missing OPENCLAW_BUILD_INFO_URL" };

  const metaUpstream = metadata?.upstream;
  const metaCustom = metadata?.custom;
  const metaSync = metadata?.sync;
  const upstreamRepo = metaUpstream?.repo ?? "openclaw/openclaw";

  // Resolve RUNNING upstream short from metadata (the metadata describes the READY build,
  // but upstream.short from the running container is the commit it was built with).
  // We use build-info.json commit as the RUNNING custom, and metadata for READY.
  const readyUpstreamShort = metaUpstream?.short ?? metaUpstream?.commit?.slice(0, 7) ?? null;
  const readyCustomShort = metaCustom?.short ?? metaCustom?.commit?.slice(0, 7) ?? null;

  // ── 3. QUEUED data: live GitHub API ──
  const { status: liveUpstream, error: liveError } = await fetchOpenClawUpstreamStatus({ now });

  // ── 4. Enrich RUNNING upstream data from GitHub if we have metadata ──
  // The RUNNING upstream commit = what the running container was built with.
  // If metadata has upstream info, that's the READY upstream. For RUNNING we need
  // to look at the actual running commit from build-info, or fallback to metadata
  // if the running commit matches.
  const runningUpstreamShort = metaUpstream?.short ?? liveUpstream?.commit ?? null;
  let runningUpstreamAuthor = metaUpstream?.author ?? null;
  let runningUpstreamMessage = metaUpstream?.message ?? null;
  let runningUpstreamDate = metaUpstream?.date ?? null;
  let runningUpstreamCommitUrl: string | null = runningUpstreamShort
    ? `https://github.com/${upstreamRepo}/commit/${runningUpstreamShort}`
    : null;
  let runningUpstreamTotal: string | null = null;
  if (metaUpstream?.total_commits != null) {
    runningUpstreamTotal = `${metaUpstream.total_commits.toLocaleString()} commits`;
  }

  // If metadata upstream doesn't match, try fetching the running upstream commit
  if (!metaUpstream && runningCommitRaw) {
    const bysha = await fetchCommitBySha({ sha: runningCommitRaw });
    if (bysha.status) {
      runningUpstreamAuthor = bysha.status.author;
      runningUpstreamMessage = bysha.status.subject;
      runningUpstreamDate = bysha.status.committedAt;
      runningUpstreamCommitUrl = bysha.status.commitUrl;
      if (bysha.status.totalCommits != null) {
        runningUpstreamTotal = `${bysha.status.totalCommits.toLocaleString()} commits`;
      }
    }
  }

  // RUNNING custom = the running container's custom commit
  const runningCustomShort = runningCommit;
  const runningCustomAuthor = metaCustom?.author ?? null;
  const runningCustomMessage = metaCustom?.message ?? null;
  const runningCustomDate = metaCustom?.date ?? null;
  const runningCustomCommitUrl = runningCustomShort
    ? `https://github.com/maestroagi/openclaw/commit/${runningCustomShort}`
    : null;
  const aheadNum = metaSync?.ahead ?? 0;
  const runningCustomTotal = Number(aheadNum) > 0 ? `+${aheadNum} ahead of upstream` : null;

  // ── 5. Change detection: RUNNING vs READY ──
  const readyHasNewUpstream = Boolean(
    runningUpstreamShort && readyUpstreamShort && runningUpstreamShort !== readyUpstreamShort,
  );
  const readyHasNewCustom = Boolean(
    runningCustomShort && readyCustomShort && runningCustomShort !== readyCustomShort,
  );
  const hasUpdate = readyHasNewUpstream || readyHasNewCustom;

  // QUEUED: compare READY upstream vs live GitHub HEAD
  const liveUpstreamShort = liveUpstream?.commit ?? null;
  const queuedHasNewUpstream = Boolean(
    readyUpstreamShort && liveUpstreamShort && readyUpstreamShort !== liveUpstreamShort,
  );

  // ══════════════════════════════════════════════════════════════
  // BUILD BLOCKS
  // ══════════════════════════════════════════════════════════════

  // ── RUNNING BUILD — always show full data, no change indicators ──
  const runningBlock = formatVersionBlock({
    title: "𝗥𝗨𝗡𝗡𝗜𝗡𝗚 𝗕𝗨𝗜𝗟𝗗",
    emoji: "📦",
    version: runningVersion,
    upstream: {
      type: "upstream",
      commitShort: runningUpstreamShort,
      author: runningUpstreamAuthor,
      message: runningUpstreamMessage,
      date: runningUpstreamDate,
      commitUrl: runningUpstreamCommitUrl,
      totalInfo: runningUpstreamTotal,
      changed: true,
      available: Boolean(runningUpstreamShort),
      showIndicator: false, // RUNNING never shows ⬆️ 𝗡𝗘𝗪
      now,
    },
    custom: {
      type: "custom",
      commitShort: runningCustomShort,
      author: runningCustomAuthor,
      message: runningCustomMessage,
      date: runningCustomDate,
      commitUrl: runningCustomCommitUrl,
      totalInfo: runningCustomTotal,
      changed: true,
      available: Boolean(runningCustomShort),
      showIndicator: false,
      now,
    },
    builtAt: runningBuiltAt,
    isEmpty: false,
    now,
  });

  // ── READY TO UPDATE ──
  let readyBlock: string;
  if (hasUpdate && metadata) {
    const readyUpstreamCommitUrl = readyUpstreamShort
      ? `https://github.com/${upstreamRepo}/commit/${readyUpstreamShort}`
      : null;
    const readyCustomCommitUrl = readyCustomShort
      ? `https://github.com/maestroagi/openclaw/commit/${readyCustomShort}`
      : null;
    const readyUpstreamTotalBase = metaUpstream?.total_commits != null
      ? metaUpstream.total_commits.toLocaleString()
      : null;
    const readyUpstreamTotal = readyUpstreamTotalBase
      ? `${readyUpstreamTotalBase} commits${readyHasNewUpstream ? " (+new)" : ""}`
      : null;
    const readyCustomTotal = Number(aheadNum) > 0 ? `+${aheadNum} ahead of upstream` : null;

    readyBlock = formatVersionBlock({
      title: "𝗥𝗘𝗔𝗗𝗬 𝗧𝗢 𝗨𝗣𝗗𝗔𝗧𝗘",
      emoji: "✅",
      version: metadata.version,
      upstream: {
        type: "upstream",
        commitShort: readyUpstreamShort,
        author: metaUpstream?.author,
        message: metaUpstream?.message,
        date: metaUpstream?.date,
        commitUrl: readyUpstreamCommitUrl,
        totalInfo: readyUpstreamTotal,
        changed: readyHasNewUpstream,
        available: Boolean(readyUpstreamShort),
        showIndicator: true,
        now,
      },
      custom: {
        type: "custom",
        commitShort: readyCustomShort,
        author: metaCustom?.author,
        message: metaCustom?.message,
        date: metaCustom?.date,
        commitUrl: readyCustomCommitUrl,
        totalInfo: readyCustomTotal,
        changed: readyHasNewCustom,
        available: Boolean(readyCustomShort),
        showIndicator: true,
        now,
      },
      builtAt: metadata.built_at,
      isEmpty: false,
      now,
    });
  } else {
    readyBlock = formatVersionBlock({
      title: "𝗥𝗘𝗔𝗗𝗬 𝗧𝗢 𝗨𝗣𝗗𝗔𝗧𝗘",
      emoji: "✅",
      isEmpty: true,
      emptyMessage: metaError
        ? `⚠️ Could not check (${metaError})`
        : "✅ Running the latest build\nNo update available",
      upstream: { type: "upstream", changed: false, available: false, now },
      custom: { type: "custom", changed: false, available: false, now },
      now,
    });
  }

  // ── QUEUED BUILD ──
  let queuedBlock: string;
  if (queuedHasNewUpstream && liveUpstream) {
    const queuedUpstreamCommitUrl = liveUpstreamShort
      ? `https://github.com/${upstreamRepo}/commit/${liveUpstreamShort}`
      : null;
    queuedBlock = formatVersionBlock({
      title: "𝗤𝗨𝗘𝗨𝗘𝗗 𝗕𝗨𝗜𝗟𝗗",
      emoji: "🔜",
      upstream: {
        type: "upstream",
        commitShort: liveUpstreamShort,
        author: liveUpstream.author,
        message: liveUpstream.subject,
        date: liveUpstream.committedAt,
        commitUrl: queuedUpstreamCommitUrl,
        totalInfo: liveUpstream.totalCommits != null
          ? `${liveUpstream.totalCommits.toLocaleString()} commits (+new)`
          : null,
        changed: true,
        available: true,
        showIndicator: true,
        now,
      },
      custom: {
        type: "custom",
        commitShort: null,
        changed: false,
        available: false,
        showIndicator: true,
        now,
      },
      isEmpty: false,
      now,
    });
    queuedBlock += "\n\n  ⏳ Build pending · coming in ~15 min";
  } else {
    queuedBlock = formatVersionBlock({
      title: "𝗤𝗨𝗘𝗨𝗘𝗗 𝗕𝗨𝗜𝗟𝗗",
      emoji: "🔜",
      isEmpty: true,
      emptyMessage: liveError
        ? `⚠️ Could not check upstream (${liveError})`
        : "✅ No new upstream commits\nEverything is up to date",
      upstream: { type: "upstream", changed: false, available: false, now },
      custom: { type: "custom", changed: false, available: false, now },
      now,
    });
  }

  // ── SYNC STATUS ──
  const behindNum = metaSync?.behind ?? 0;
  const syncLines = ["🔄 𝗦𝗬𝗡𝗖 𝗦𝗧𝗔𝗧𝗨𝗦"];
  if (metaSync != null) {
    if (Number(behindNum) === 0) {
      syncLines.push("  ✅ Fully synced with upstream");
    } else {
      syncLines.push(`  ⬇️ ${behindNum} commit(s) behind upstream`);
    }
    if (Number(aheadNum) > 0) {
      syncLines.push(`  ⬆️ ${aheadNum} commit(s) ahead (custom changes)`);
    }
  } else {
    // Fallback: use live upstream comparison
    if (liveUpstream && runningUpstreamShort && liveUpstreamShort !== runningUpstreamShort) {
      syncLines.push("  ⬇️ Behind upstream (exact count unknown)");
    } else {
      syncLines.push("  ✅ Fully synced with upstream");
    }
  }
  const syncBlock = syncLines.join("\n");

  // ══════════════════════════════════════════════════════════════
  // FINAL MESSAGE
  // ══════════════════════════════════════════════════════════════

  const text = [
    "🦞 𝗢𝗣𝗘𝗡𝗖𝗟𝗔𝗪 /𝗩𝗘𝗥𝗦𝗜𝗢𝗡",
    SEPARATOR,
    runningBlock,
    SEPARATOR,
    readyBlock,
    SEPARATOR,
    queuedBlock,
    SEPARATOR,
    syncBlock,
    SEPARATOR,
  ].join("\n\n");

  // Show UPDATE button always (user can press to check / trigger)
  const buttons: ButtonRow[] | undefined = includeUpdateButton
    ? [[{ text: "🔄 UPDATE", callback_data: VERSION_UPDATE_CALLBACK_DATA }]]
    : undefined;

  return { text, buttons };
}
