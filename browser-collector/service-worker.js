const DEFAULTS = {
  enabled: true,
  collectorUrl: "",
  token: "",
  machineName: ""
};

async function settings() {
  return chrome.storage.sync.get(DEFAULTS);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
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

    const endpoint = `${cfg.collectorUrl.replace(/\/$/, "")}/ingest`;
    const payload = {
      ...message.payload,
      machine_name: cfg.machineName || "",
      collector_version: chrome.runtime.getManifest().version
    };

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Collector-Token": cfg.token
        },
        body: JSON.stringify(payload)
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`${response.status} ${text.slice(0, 200)}`);
      const result = text ? JSON.parse(text) : { ok: true };
      await chrome.storage.local.set({
        lastUploadAt: new Date().toISOString(),
        lastUploadStatus: "success",
        lastUploadMessage: `${payload.platform} ${payload.page_type}`
      });
      sendResponse({ ok: true, result });
    } catch (error) {
      await chrome.storage.local.set({
        lastUploadAt: new Date().toISOString(),
        lastUploadStatus: "error",
        lastUploadMessage: error instanceof Error ? error.message : String(error)
      });
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  })();

  return true;
});

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
