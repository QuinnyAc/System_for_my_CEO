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
const BASELINE_PREFIX = "monitorBaseline::";

async function settings() {
  return chrome.storage.local.get(DEFAULTS);
}

function endpoint(cfg, path) {
  return `${cfg.collectorUrl.replace(/\/$/, "")}${path}`;
}

function canonicalUrl(value) {
  try {
    const url = new URL(value);
    url.hash = "";
    if (url.hostname.replace(/^www\./, "").endsWith("youtube.com") && url.pathname === "/watch") {
      const videoId = url.searchParams.get("v") || "";
      url.search = videoId ? `?v=${encodeURIComponent(videoId)}` : "";
    } else {
      url.search = "";
    }
    url.hostname = url.hostname.replace(/^www\./, "");
    url.pathname = url.pathname.replace(/\/$/, "") || "/";
    return url.toString();
  } catch {
    return String(value || "").trim();
  }
}

function baselineKey(feedUrl) {
  return `${BASELINE_PREFIX}${canonicalUrl(feedUrl)}`;
}

function looksLikeContentUrl(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.replace(/^www\./, "").toLowerCase();
    const path = url.pathname;
    if (host.endsWith("youtube.com") || host === "youtu.be") return path === "/watch" || path.startsWith("/shorts/") || host === "youtu.be";
    if (host.endsWith("instagram.com")) return path.startsWith("/p/") || path.startsWith("/reel/");
    if (host.endsWith("facebook.com") || host === "fb.watch") return /\/(posts|videos|reel|watch|photo|permalink)\b/i.test(path) || url.searchParams.has("story_fbid") || host === "fb.watch";
    if (host.endsWith("pinterest.com") || host === "pin.it") return path.startsWith("/pin/") || host === "pin.it";
    return false;
  } catch {
    return false;
  }
}

async function hasAnyMonitorBaseline() {
  const stored = await chrome.storage.local.get(null);
  return Object.keys(stored).some((key) => key.startsWith(BASELINE_PREFIX));
}

async function applyMonitorBaseline(current, payload) {
  if (payload?.page_type !== "account") return payload;
  const discovered = [...new Set((payload.discovered_urls || []).map(canonicalUrl).filter(Boolean))];
  const key = baselineKey(current.url);
  const stored = await chrome.storage.local.get(key);
  const state = stored[key];

  if (!state) {
    await chrome.storage.local.set({
      [key]: {
        baseline: discovered,
        seen: discovered,
        initializedAt: new Date().toISOString()
      }
    });
    return { ...payload, discovered_urls: [] };
  }

  const baseline = Array.isArray(state.baseline) ? state.baseline : [];
  const seen = new Set(Array.isArray(state.seen) ? state.seen : baseline);
  const newUrls = discovered.filter((url) => !seen.has(url));
  discovered.forEach((url) => seen.add(url));
  await chrome.storage.local.set({
    [key]: {
      ...state,
      baseline,
      seen: [...seen],
      lastCheckedAt: new Date().toISOString()
    }
  });
  return { ...payload, discovered_urls: newUrls };
}

async function isBaselineContentUrl(value) {
  const target = canonicalUrl(value);
  if (!target) return false;
  const stored = await chrome.storage.local.get(null);
  for (const [key, state] of Object.entries(stored)) {
    if (!key.startsWith(BASELINE_PREFIX) || !state || !Array.isArray(state.baseline)) continue;
    if (state.baseline.includes(target)) return true;
  }
  return false;
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
    // The user or browser may already have closed it.
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
    // Server also releases stale processing tasks, so do not trap the extension here.
  }
  await clearCurrentTask(current, true);
  await chrome.storage.local.set({
    lastUploadAt: new Date().toISOString(),
    lastUploadStatus: "error",
    lastUploadMessage: `自动任务失败：${reason || "未读取到数据"}`
  });
  await schedulePoll(15_000);
}

async function pollQueue() {
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
      await schedulePoll(60_000);
      return;
    }

    if (looksLikeContentUrl(task.url) && !(await hasAnyMonitorBaseline())) {
      try {
        await reportTaskFailure(cfg, task.id, "等待首次账号基线，旧作品不登记");
      } catch {}
      await schedulePoll(1_500);
      return;
    }

    if (await isBaselineContentUrl(task.url)) {
      try {
        await reportTaskFailure(cfg, task.id, "基线旧作品，按设置跳过");
      } catch {}
      await chrome.storage.local.set({
        lastUploadAt: new Date().toISOString(),
        lastUploadStatus: "success",
        lastUploadMessage: "已跳过登记账号之前的旧作品"
      });
      await schedulePoll(1_500);
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
    await chrome.alarms.create(TIMEOUT_ALARM, { when: Date.now() + 60_000 });
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
    await schedulePoll(60_000);
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

    if (message.payload?.page_type === "content" && await isBaselineContentUrl(current.url)) {
      try {
        await reportTaskFailure(cfg, current.taskId, "基线旧作品，按设置跳过");
      } catch {}
      await clearCurrentTask(current, true);
      await schedulePoll(1_500);
      sendResponse({ ok: true, skipped: true, reason: "baseline_old_content" });
      return;
    }

    const baselinePayload = await applyMonitorBaseline(current, message.payload);
    const payload = {
      ...baselinePayload,
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
      await chrome.storage.local.set({
        lastUploadAt: new Date().toISOString(),
        lastUploadStatus: "success",
        lastUploadMessage: payload.page_type === "account"
          ? "账号数据已同步；仅新增作品会进入内容数据"
          : `自动任务完成：${payload.platform}`
      });

      await clearCurrentTask(current, true);
      await schedulePoll(12_000);
      sendResponse({ ok: true, result });
    } catch (error) {
      await chrome.storage.local.set({
        lastUploadAt: new Date().toISOString(),
        lastUploadStatus: "error",
        lastUploadMessage: error instanceof Error ? error.message : String(error)
      });
      await failCurrentTask(error instanceof Error ? error.message : String(error));
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  })();

  return true;
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === POLL_ALARM || alarm.name === HEARTBEAT_ALARM) {
    pollQueue().catch(() => null);
  } else if (alarm.name === TIMEOUT_ALARM) {
    failCurrentTask("页面在 60 秒内没有读取到公开数据").catch(() => null);
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
