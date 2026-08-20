const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const entrySource = fs.readFileSync(path.join(__dirname, "..", "service-worker-entry.js"), "utf8");
const context = {
  importScripts() {},
  Number,
  Array,
  Object
};
// Simulate the original worker helper before the entry script overrides it.
context.payloadHasAccountMetrics = () => true;
vm.runInNewContext(entrySource, context, { filename: "service-worker-entry.js" });

assert.equal(
  context.payloadHasAccountMetrics({
    platform: "youtube",
    page_type: "account",
    metrics: { content_count: 45 }
  }),
  false,
  "YouTube content_count alone must not close the account task before followers arrive"
);

assert.equal(
  context.payloadHasAccountMetrics({
    platform: "youtube",
    page_type: "account",
    metrics: { followers: 123, content_count: 45 }
  }),
  true,
  "YouTube account task should complete once followers are available"
);

assert.equal(
  context.payloadHasAccountMetrics({
    platform: "instagram",
    page_type: "account",
    metrics: { content_count: 45 }
  }),
  true,
  "Non-YouTube behavior should remain unchanged"
);

console.log("YouTube follower completion guard ok");
