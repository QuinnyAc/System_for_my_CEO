const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "service-worker.js"), "utf8");
const store = {
  enabled: true,
  collectorUrl: "https://collector.example",
  token: "test-token",
  machineName: ""
};
const removedTabs = [];
let onMessage = null;

const chrome = {
  storage: {
    local: {
      async get(input) {
        if (typeof input === "string") return { [input]: store[input] };
        if (Array.isArray(input)) return Object.fromEntries(input.map((key) => [key, store[key]]));
        if (input && typeof input === "object") return { ...input, ...store };
        return { ...store };
      },
      async set(values) { Object.assign(store, values); },
      async remove(key) {
        for (const item of Array.isArray(key) ? key : [key]) delete store[item];
      }
    }
  },
  alarms: {
    async create() {},
    async clear() {},
    onAlarm: { addListener() {} }
  },
  tabs: {
    async remove(tabId) { removedTabs.push(tabId); },
    async get(tabId) { return { id: tabId }; },
    async create() { return { id: 999 }; }
  },
  runtime: {
    getManifest() { return { version: "0.5.3" }; },
    onMessage: { addListener(listener) { onMessage = listener; } },
    onInstalled: { addListener() {} },
    onStartup: { addListener() {} },
    async openOptionsPage() {}
  },
  action: { onClicked: { addListener() {} } }
};

async function fetchMock(url, options = {}) {
  if (url.endsWith("/ingest")) {
    const payload = JSON.parse(options.body || "{}");
    const body = {
      ok: true,
      account_id: "00000000-0000-0000-0000-000000000001",
      baseline_ready: true,
      account_snapshot_created: Boolean(
        Number.isFinite(payload.metrics?.followers) ||
        Number.isFinite(payload.metrics?.account_views) ||
        Number.isFinite(payload.metrics?.content_count)
      )
    };
    return { ok: true, status: 200, async text() { return JSON.stringify(body); } };
  }
  return { ok: true, status: 200, async text() { return JSON.stringify({}); } };
}

const context = {
  chrome,
  fetch: fetchMock,
  URL,
  URLSearchParams,
  encodeURIComponent,
  Date,
  Number,
  Object,
  Array,
  Set,
  String,
  Boolean,
  JSON,
  console
};
context.globalThis = context;
vm.runInNewContext(source, context, { filename: "service-worker.js" });
assert.equal(typeof onMessage, "function", "service worker did not register message listener");

store.queueCurrentTask = {
  taskId: "00000000-0000-0000-0000-000000000002",
  tabId: 55,
  url: "https://youtube.com/@example/videos",
  platform: "youtube",
  waitingForBaseline: false,
  waitingForAccountMetrics: false,
  accountMetricsReceived: false,
  startedAt: new Date().toISOString()
};

function send(payload) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("message response timeout")), 1000);
    const keepAlive = onMessage(
      { type: "PUBLIC_METRICS", payload },
      { tab: { id: 55 } },
      (response) => {
        clearTimeout(timeout);
        resolve(response);
      }
    );
    assert.equal(keepAlive, true);
  });
}

(async () => {
  const discoveryFirst = await send({
    platform: "youtube",
    page_type: "account",
    url: "https://youtube.com/@example/videos",
    profile_url: "https://youtube.com/@example",
    metrics: {},
    discovered_urls: ["https://youtube.com/watch?v=old1"],
    discovery_complete: true,
    feed_empty: false
  });
  assert.equal(discoveryFirst.ok, true);
  assert.equal(discoveryFirst.waiting, true);
  assert.equal(store.queueCurrentTask.waitingForAccountMetrics, true);
  assert.equal(store.queueCurrentTask.accountMetricsReceived, false);
  assert.deepEqual(removedTabs, [], "tab closed before account metrics arrived");

  const metricsSecond = await send({
    platform: "youtube",
    page_type: "account",
    url: "https://youtube.com/@example/videos",
    profile_url: "https://youtube.com/@example",
    metrics: { followers: 123, content_count: 45 },
    discovered_urls: [],
    discovery_complete: false,
    feed_empty: false
  });
  assert.equal(metricsSecond.ok, true);
  assert.equal(store.queueCurrentTask, undefined, "task should clear after baseline and metrics are both known");
  assert.deepEqual(removedTabs, [55], "tab should close only after account metrics arrive");
  console.log("service worker account wait-state ok");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
