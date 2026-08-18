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

async function settings() {
  return chrome.storage.local.get(DEFAULTS);
}

function endpoint(cfg, path) {
  return `${cfg.collectorUrl.replace(/\/$/, "")}${path}`;
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
  if (closeTab) await closeTaskTab(current);
  await chrome.storage.local.remove(CURRENT_TASK_KEY);
}

async function failCurrentTask(reason) {
  const current = await getCurrentTask();
  if (!current) return;
  const cfg = await settings();
  try {
    if (cfg.collectorUrl && cfg.token) {
      await collectorFetch(cfg, `/tasks/${current.taskId}/fail`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: reason || "页面没有读取到公开数据" })
      });
    }
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
    const payload = {
      ...message.payload,
      machine_name: cfg.machineName || "",
      collector_version: chrome.runtime.getManifest().version,
      task_id: queued ? current.taskId : null
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
        lastUploadMessage: queued ? `自动任务完成：${payload.platform}` : `${payload.platform} ${payload.page_type}`
      });

      if (queued) {
        await clearCurrentTask(current, true);
        await schedulePoll(12_000);
      }
      sendResponse({ ok: true, result });
    } catch (error) {
      await chrome.storage.local.set({
        lastUploadAt: new Date().toISOString(),
        lastUploadStatus: "error",
        lastUploadMessage: error instanceof Error ? error.message : String(error)
      });
      if (queued) await failCurrentTask(error instanceof Error ? error.message : String(error));
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
