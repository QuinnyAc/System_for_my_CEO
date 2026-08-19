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
let serverBaselineReady = false;

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
    if ((payload.discovered_urls || []).length > 0 || payload.feed_empty || payload.metrics?.content_count === 0) {
      serverBaselineReady = true;
    }
    const body = {
      ok: true,
      account_id: "00000000-0000-0000-0000-000000000001",
      baseline_ready: serverBaselineReady,
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

function resetTask(tabId, taskId) {
  serverBaselineReady = false;
  removedTabs.length = 0;
  store.queueCurrentTask = {
    taskId,
    tabId,
    url: "https://youtube.com/@example/videos",
    platform: "youtube",
    waitingForBaseline: false,
    waitingForAccountMetrics: false,
    accountMetricsReceived: false,
    startedAt: new Date().toISOString()
  };
}

function send(tabId, payload) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("message response timeout")), 1000);
    const keepAlive = onMessage(
      { type: "PUBLIC_METRICS", payload },
      { tab: { id: tabId } },
      (response) => {
        clearTimeout(timeout);
        resolve(response);
      }
    );
    assert.equal(keepAlive, true);
  });
}

const discoveryPayload = {
  platform: "youtube",
  page_type: "account",
  url: "https://youtube.com/@example/videos",
  profile_url: "https://youtube.com/@example",
  metrics: {},
  discovered_urls: ["https://youtube.com/watch?v=old1"],
  discovery_complete: true,
  feed_empty: false
};
const metricPayload = {
  platform: "youtube",
  page_type: "account",
  url: "https://youtube.com/@example/videos",
  profile_url: "https://youtube.com/@example",
  metrics: { followers: 123, content_count: 45 },
  discovered_urls: [],
  discovery_complete: false,
  feed_empty: false
};

(async () => {
  resetTask(55, "00000000-0000-0000-0000-000000000002");
  const discoveryFirst = await send(55, discoveryPayload);
  assert.equal(discoveryFirst.ok, true);
  assert.equal(discoveryFirst.waiting, true);
  assert.equal(store.queueCurrentTask.waitingForAccountMetrics, true);
  assert.equal(store.queueCurrentTask.accountMetricsReceived, false);
  assert.deepEqual(removedTabs, [], "tab closed before account metrics arrived");

  const metricsSecond = await send(55, metricPayload);
  assert.equal(metricsSecond.ok, true);
  assert.equal(store.queueCurrentTask, undefined, "task should clear after baseline and metrics are both known");
  assert.deepEqual(removedTabs, [55], "tab should close only after account metrics arrive");

  resetTask(56, "00000000-0000-0000-0000-000000000003");
  const metricsFirst = await send(56, metricPayload);
  assert.equal(metricsFirst.ok, true);
  assert.equal(metricsFirst.waiting, true);
  assert.equal(store.queueCurrentTask.waitingForBaseline, true);
  assert.equal(store.queueCurrentTask.accountMetricsReceived, true);
  assert.deepEqual(removedTabs, [], "tab closed before baseline discovery arrived");

  const discoverySecond = await send(56, discoveryPayload);
  assert.equal(discoverySecond.ok, true);
  assert.equal(store.queueCurrentTask, undefined, "task should clear after metrics and baseline are both known");
  assert.deepEqual(removedTabs, [56], "tab should close only after baseline discovery arrives");

  console.log("service worker account wait-state ok in both arrival orders");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
