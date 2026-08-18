const DEFAULTS = {
  enabled: true,
  collectorUrl: "",
  token: "",
  machineName: ""
};

const CURRENT_TASK_KEY = "queueCurrentTask";
const POLL_ALARM = "queue-poll";
const HEARTBEAT_ALARM = "queue-heartbeat";
const TIMEOUT_ALARM = "queue-timeout";
const LEGACY_BASELINE_PREFIX = "monitorBaseline::";
let pollInFlight = false;

async function settings() {
  return chrome.storage.local.get(DEFAULTS);
}

function endpoint(cfg, path) {
  return `${cfg.collectorUrl.replace(/\/$/, "")}${path}`;
}

function canonicalUrl(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.replace(/^www\./, "").toLowerCase();
    url.hostname = host;
    url.hash = "";
    url.pathname = url.pathname.replace(/\/$/, "") || "/";

    if (host.endsWith("youtube.com") && url.pathname === "/watch") {
      const videoId = url.searchParams.get("v") || "";
      url.search = videoId ? `?v=${encodeURIComponent(videoId)}` : "";
    } else if (host.endsWith("facebook.com")) {
      const original = new URL(value);
      const keep = new URLSearchParams();
      if (url.pathname === "/watch" && original.searchParams.get("v")) {
        keep.set("v", original.searchParams.get("v"));
      } else if (url.pathname.endsWith("/profile.php") && original.searchParams.get("id")) {
        keep.set("id", original.searchParams.get("id"));
      } else if (original.searchParams.get("story_fbid")) {
        keep.set("story_fbid", original.searchParams.get("story_fbid"));
        if (original.searchParams.get("id")) keep.set("id", original.searchParams.get("id"));
      } else if (original.searchParams.get("fbid")) {
        keep.set("fbid", original.searchParams.get("fbid"));
        if (original.searchParams.get("id")) keep.set("id", original.searchParams.get("id"));
      }
      url.search = keep.toString() ? `?${keep.toString()}` : "";
    } else {
      url.search = "";
    }
    return url.toString();
  } catch {
    return String(value || "").trim();
  }
}

function legacyBaselineKey(feedUrl) {
  return `${LEGACY_BASELINE_PREFIX}${canonicalUrl(feedUrl)}`;
}

async function legacySeenUrls(feedUrl) {
  const key = legacyBaselineKey(feedUrl);
  const stored = await chrome.storage.local.get(key);
  const state = stored[key];
  if (!state) return [];
  const seen = Array.isArray(state.seen) ? state.seen : Array.isArray(state.baseline) ? state.baseline : [];
  return [...new Set(seen.map(canonicalUrl).filter(Boolean))].slice(0, 240);
}

async function clearLegacyBaseline(feedUrl) {
  await chrome.storage.local.remove(legacyBaselineKey(feedUrl));
}

async function collectorFetch(cfg, path, options = {}) {
  const response = await fetch(endpoint(cfg, path), {
    ...options,
    headers: {
      ...(options.headers || {}),
      "X-Collector-Token": cfg.token
    }
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status} ${text.slice(0, 240)}`);
  return text ? JSON.parse(text) : {};
}

async function getCurrentTask() {
  const stored = await chrome.storage.local.get(CURRENT_TASK_KEY);
  return stored[CURRENT_TASK_KEY] || null;
}

async function schedulePoll(delayMs = 12_000) {
  await chrome.alarms.create(POLL_ALARM, { when: Date.now() + delayMs });
}

async function closeTaskTab(current) {
  if (!current?.tabId) return;
  try {
    await chrome.tabs.remove(current.tabId);
  } catch {
    // It may already be closed.
  }
}

async function clearCurrentTask(current, closeTab = true) {
  await chrome.alarms.clear(TIMEOUT_ALARM);
  await chrome.storage.local.remove(CURRENT_TASK_KEY);
  if (closeTab) await closeTaskTab(current);
}

async function reportTaskFailure(cfg, taskId, reason) {
  if (!cfg.collectorUrl || !cfg.token || !taskId) return;
  await collectorFetch(cfg, `/tasks/${taskId}/fail`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ error: reason || "页面没有读取到公开数据" })
  });
}

async function failCurrentTask(reason) {
  const current = await getCurrentTask();
  if (!current) return;
  const cfg = await settings();
  try {
    await reportTaskFailure(cfg, current.taskId, reason);
  } catch {
    // The server also releases stale tasks.
  }
  await clearCurrentTask(current, true);
  await chrome.storage.local.set({
    lastUploadAt: new Date().toISOString(),
    lastUploadStatus: "error",
    lastUploadMessage: `自动任务失败：${reason || "未读取到数据"}`
  });
  await schedulePoll(12_000);
}

async function pollQueue() {
  if (pollInFlight) return;
  pollInFlight = true;
  try {
    const cfg = await settings();
    if (!cfg.enabled || !cfg.collectorUrl || !cfg.token) return;

    const current = await getCurrentTask();
    if (current) {
      try {
        await chrome.tabs.get(current.tabId);
        return;
      } catch {
        await failCurrentTask("自动采集标签页被关闭");
        return;
      }
    }

    try {
      const query = `?machine_name=${encodeURIComponent(cfg.machineName || "")}`;
      const result = await collectorFetch(cfg, `/tasks/next${query}`);
      const task = result?.task;
      if (!task) {
        await schedulePoll(15_000);
        return;
      }

      const tab = await chrome.tabs.create({ url: task.url, active: false });
      const queueState = {
        taskId: task.id,
        tabId: tab.id,
        url: task.url,
        platform: task.platform,
        startedAt: new Date().toISOString()
      };
      await chrome.storage.local.set({ [CURRENT_TASK_KEY]: queueState });
      await chrome.alarms.create(TIMEOUT_ALARM, { when: Date.now() + 75_000 });
      await chrome.storage.local.set({
        lastUploadAt: new Date().toISOString(),
        lastUploadStatus: "running",
        lastUploadMessage: `自动读取：${task.platform}`
      });
    } catch (error) {
      await chrome.storage.local.set({
        lastUploadAt: new Date().toISOString(),
        lastUploadStatus: "error",
        lastUploadMessage: `读取任务队列失败：${error instanceof Error ? error.message : String(error)}`
      });
      await schedulePoll(30_000);
    }
  } finally {
    pollInFlight = false;
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "RUN_QUEUE") {
    pollQueue().then(() => sendResponse({ ok: true })).catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }
  if (message?.type !== "PUBLIC_METRICS") return;

  (async () => {
    const cfg = await settings();
    if (!cfg.enabled) {
      sendResponse({ ok: false, skipped: true, reason: "disabled" });
      return;
    }
    if (!cfg.collectorUrl || !cfg.token) {
      sendResponse({ ok: false, skipped: true, reason: "not_configured" });
      return;
    }

    const current = await getCurrentTask();
    const queued = Boolean(current && sender.tab?.id && sender.tab.id === current.tabId);
    if (!queued) {
      sendResponse({ ok: false, skipped: true, reason: "queue_only" });
      return;
    }

    const previousSeen = message.payload?.page_type === "account"
      ? await legacySeenUrls(current.url)
      : [];
    const payload = {
      ...message.payload,
      previous_seen_urls: previousSeen,
      machine_name: cfg.machineName || "",
      collector_version: chrome.runtime.getManifest().version,
      task_id: current.taskId
    };

    try {
      const result = await collectorFetch(cfg, "/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      if (payload.page_type === "account" && result?.baseline_ready) {
        await clearLegacyBaseline(current.url);
      }
      await chrome.storage.local.set({
        lastUploadAt: new Date().toISOString(),
        lastUploadStatus: "success",
        lastUploadMessage: payload.page_type === "account"
          ? "账号数据已同步；服务器已维护新增作品基线"
          : `自动任务完成：${payload.platform}`
      });
      await clearCurrentTask(current, true);
      await schedulePoll(6_000);
      sendResponse({ ok: true, result });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await chrome.storage.local.set({
        lastUploadAt: new Date().toISOString(),
        lastUploadStatus: "error",
        lastUploadMessage: reason
      });
      await failCurrentTask(reason);
      sendResponse({ ok: false, error: reason });
    }
  })();
  return true;
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === POLL_ALARM || alarm.name === HEARTBEAT_ALARM) {
    pollQueue().catch(() => null);
  } else if (alarm.name === TIMEOUT_ALARM) {
    failCurrentTask("页面在 75 秒内没有读取到公开数据").catch(() => null);
  }
});

async function initializeQueue() {
  await chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: 1 });
  await schedulePoll(2_000);
}

chrome.runtime.onInstalled.addListener(() => initializeQueue().catch(() => null));
chrome.runtime.onStartup.addListener(() => initializeQueue().catch(() => null));
chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

initializeQueue().catch(() => null);
