const DEFAULTS = { enabled: true, collectorUrl: "", token: "", machineName: "" };

const enabled = document.getElementById("enabled");
const collectorUrl = document.getElementById("collectorUrl");
const token = document.getElementById("token");
const machineName = document.getElementById("machineName");
const statusBox = document.getElementById("status");

function show(message, kind = "") {
  statusBox.textContent = message;
  statusBox.className = `status ${kind}`.trim();
}

async function load() {
  const cfg = await chrome.storage.local.get(DEFAULTS);
  enabled.checked = cfg.enabled;
  collectorUrl.value = cfg.collectorUrl;
  token.value = cfg.token;
  machineName.value = cfg.machineName;

  if (cfg.lastUploadAt) {
    const kind = cfg.lastUploadStatus === "success" ? "ok" : cfg.lastUploadStatus === "running" ? "" : "error";
    show(`最近状态：${new Date(cfg.lastUploadAt).toLocaleString()}\n${cfg.lastUploadStatus}\n${cfg.lastUploadMessage || ""}`, kind);
  } else {
    show("尚无后台读取记录");
  }
}

async function save() {
  const cfg = {
    enabled: enabled.checked,
    collectorUrl: collectorUrl.value.trim().replace(/\/$/, ""),
    token: token.value.trim(),
    machineName: machineName.value.trim()
  };
  await chrome.storage.local.set(cfg);
  try {
    await chrome.runtime.sendMessage({ type: "RUN_QUEUE" });
  } catch {
    // The background worker will retry from its heartbeat alarm.
  }
  show("设置已保存。扩展只会执行 Media Ops 后台分配的任务；普通手动浏览不会写入数据。", "ok");
  return cfg;
}

async function test() {
  const cfg = await save();
  if (!cfg.collectorUrl || !cfg.token) {
    show("请先填写 Collector 地址和 Token。", "error");
    return;
  }
  try {
    const health = await fetch(`${cfg.collectorUrl}/health`, { cache: "no-store" });
    if (!health.ok) throw new Error(`Health ${health.status}`);

    const response = await fetch(`${cfg.collectorUrl}/ingest`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Collector-Token": cfg.token
      },
      body: JSON.stringify({
        platform: "connection-test",
        page_type: "account",
        url: "https://example.invalid/collector-test",
        metrics: {}
      })
    });

    if (response.status === 401) throw new Error("Collector Token 不正确");
    if (response.status !== 422) {
      const detail = await response.text();
      if (!response.ok) throw new Error(`${response.status} ${detail.slice(0, 160)}`);
    }
    const info = await health.json().catch(() => ({}));
    const version = info.version ? `\nCollector ${info.version}` : "";
    show(`连接成功。后台自动读取已启用。${version}`, "ok");
    await chrome.runtime.sendMessage({ type: "RUN_QUEUE" }).catch(() => null);
  } catch (error) {
    show(`连接失败：${error instanceof Error ? error.message : String(error)}`, "error");
  }
}

document.getElementById("save").addEventListener("click", save);
document.getElementById("test").addEventListener("click", test);
load();
