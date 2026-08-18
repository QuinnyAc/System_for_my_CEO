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
  const cfg = await chrome.storage.sync.get(DEFAULTS);
  enabled.checked = cfg.enabled;
  collectorUrl.value = cfg.collectorUrl;
  token.value = cfg.token;
  machineName.value = cfg.machineName;

  const local = await chrome.storage.local.get(["lastUploadAt", "lastUploadStatus", "lastUploadMessage"]);
  if (local.lastUploadAt) {
    show(`最近上传：${new Date(local.lastUploadAt).toLocaleString()}\n状态：${local.lastUploadStatus}\n${local.lastUploadMessage || ""}`, local.lastUploadStatus === "success" ? "ok" : "error");
  } else {
    show("尚无上传记录");
  }
}

async function save() {
  const cfg = {
    enabled: enabled.checked,
    collectorUrl: collectorUrl.value.trim().replace(/\/$/, ""),
    token: token.value.trim(),
    machineName: machineName.value.trim()
  };
  await chrome.storage.sync.set(cfg);
  show("设置已保存。以后打开支持的平台页面会自动尝试读取公开数字。", "ok");
  return cfg;
}

async function test() {
  const cfg = await save();
  if (!cfg.collectorUrl || !cfg.token) {
    show("请先填写 Collector 地址和 Token。", "error");
    return;
  }
  try {
    const health = await fetch(`${cfg.collectorUrl}/health`);
    if (!health.ok) throw new Error(`Health ${health.status}`);

    const response = await fetch(`${cfg.collectorUrl}/ingest`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Collector-Token": cfg.token
      },
      body: JSON.stringify({
        platform: "youtube",
        page_type: "account",
        url: "https://youtube.com/@collector-connection-test",
        title: "Collector Connection Test",
        account_name: "Collector Connection Test",
        handle: "collector-connection-test",
        metrics: {},
        machine_name: cfg.machineName,
        collector_version: chrome.runtime.getManifest().version
      })
    });
    if (!response.ok) throw new Error(`${response.status} ${(await response.text()).slice(0, 160)}`);
    show("连接成功。采集助手可以向中央网站发送数据。", "ok");
  } catch (error) {
    show(`连接失败：${error instanceof Error ? error.message : String(error)}`, "error");
  }
}

document.getElementById("save").addEventListener("click", save);
document.getElementById("test").addEventListener("click", test);
load();
