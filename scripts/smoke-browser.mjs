#!/usr/bin/env node
/**
 * Loads index.html in headless Chrome against this repo's JSON files.
 * Firebase is intercepted so the test never writes the live database.
 *
 * Fails on console errors, uncaught exceptions, and on two roster bugs:
 * a failed load must not show the starter roster, and a seed-shaped
 * Firebase document must be replaced by the baseline (not displayed).
 */
import { spawn } from "child_process";
import { createServer } from "http";
import { existsSync, mkdtempSync, openSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { extname, join, normalize } from "path";
import { fileURLToPath } from "url";

const root = fileURLToPath(new URL("..", import.meta.url));
const chrome = [process.env.CHROME_PATH, "/usr/local/bin/google-chrome", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable"]
  .filter(Boolean)
  .find(p => existsSync(p));
if (!chrome) {
  console.error("Chrome not found. Set CHROME_PATH.");
  process.exit(1);
}

const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".json": "application/json",
  ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml",
  ".ttf": "font/ttf", ".ico": "image/x-icon", ".jpg": "image/jpeg", ".webp": "image/webp"
};

function startStatic() {
  return new Promise(resolve => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      let path = decodeURIComponent(url.pathname);
      if (path === "/") path = "/index.html";
      const file = normalize(join(root, path));
      if (!file.startsWith(root) || !existsSync(file)) {
        res.writeHead(404); res.end("not found"); return;
      }
      res.writeHead(200, { "Content-Type": MIME[extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
      res.end(readFileSync(file));
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function todayCT() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
}

function fixtureBoard() {
  return {
    _v: 6,
    _savedAt: new Date().toISOString(),
    _lastResetDate: todayCT(),
    _clientBuild: 2026111202,
    _minBuild: 2026111202,
    staff: [{ id: "smoke", name: "Smoke Tester", initials: "SM", color: "#7BA8C4", dept: "RCM", pin: "0000", resp: [] }],
    staffArchive: [],
    offices: [
      { code: "SQ", lbl: "SQ", name: "On the Square" },
      { code: "GT", lbl: "GT", name: "Georgetown" },
      { code: "ATX", lbl: "ATX", name: "Austin" },
      { code: "MP", lbl: "MP", name: "Med Pkwy" },
      { code: "NBDA", lbl: "NBDA", name: "New Braunfels" },
      { code: "IC", lbl: "IC", name: "Implant Ctr" },
      { code: "AR", lbl: "AR", name: "Arboretum" },
      { code: "PF", lbl: "PF", name: "Pflugerville" },
      { code: "SATX", lbl: "S.ATX", name: "South Austin" },
      { code: "AM", lbl: "AM", name: "Anderson Mill" }
    ],
    columns: [
      { id: "ins_verif", lbl: "Ins Verification", cat: "", oryx: false },
      { id: "claims_old", lbl: "Old PMS", cat: "Claims (Sending)", oryx: false },
      { id: "claims_oryx", lbl: "Oryx", cat: "Claims (Sending)", oryx: true }
    ],
    assign: { SQ: { ins_verif: ["smoke"] } },
    live: {},
    lunch: [],
    off: [],
    ivDates: { SQ: "2026-11-01" },
    departments: ["RCM"],
    helpInstances: {},
    helpLog: [],
    checkinLog: [],
    vacationActive: [],
    kpi: {}
  };
}

function seedBoard() {
  const ids = ["adela","vanessa","valerie","becky","brittani","lovely","princess","rob","kirk","myk","gianna","alexis","lynn","own_team"];
  return {
    _v: 6,
    _savedAt: "2026-11-11T00:00:00.000Z",
    _lastResetDate: todayCT(),
    staff: ids.map(id => ({ id, name: id === "princess" ? "Princess (REACH)" : id, initials: id.slice(0, 2).toUpperCase(), dept: "", pin: "1111" })),
    offices: [{ code: "ATX", lbl: "ATX", name: "Austin" }],
    columns: [{ id: "ins_verif", lbl: "Ins Verification", cat: "", oryx: false }],
    assign: { ATX: { ins_verif: ["princess"] } },
    ivDates: {}
  };
}

function startChrome(port) {
  const profile = mkdtempSync(join(tmpdir(), "rcm-chrome-"));
  const errPath = join(profile, "chrome-err.txt");
  const proc = spawn(chrome, [
    "--headless=new", "--disable-gpu", "--no-sandbox", "--disable-dev-shm-usage",
    "--remote-allow-origins=*",
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    "about:blank"
  ], { stdio: ["ignore", "ignore", openSync(errPath, "w")] });
  return { proc, profile, errPath };
}

async function launchChrome(port) {
  let detail = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    const launched = startChrome(port);
    try {
      await waitForDebug(port);
      return launched;
    } catch (error) {
      try { detail = readFileSync(launched.errPath, "utf8").trim().slice(-500); } catch { detail = ""; }
      try { launched.proc.kill("SIGKILL"); } catch { /* already gone */ }
      await new Promise(r => setTimeout(r, 300));
      try { rmSync(launched.profile, { recursive: true, force: true }); } catch { /* temp profile */ }
      if (attempt === 3) throw new Error(error.message + (detail ? "\n" + detail : ""));
    }
  }
}

async function waitForDebug(port) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) return r.json();
    } catch { /* chrome still booting */ }
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error("Chrome debug port did not open");
}

async function runPage({ staticPort, debugPort, path, firebase }) {
  const version = await waitForDebug(debugPort);
  const browser = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    browser.addEventListener("open", resolve);
    browser.addEventListener("error", () => reject(new Error("browser websocket failed")));
  });
  let next = 0;
  const pending = new Map();
  const events = [];
  browser.addEventListener("message", ev => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || "cdp error"));
      else p.resolve(msg.result);
    } else if (msg.method) {
      events.push(msg);
    }
  });
  function send(method, params) {
    const id = ++next;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      browser.send(JSON.stringify({ id, method, params }));
    });
  }

  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  function session(method, params) {
    const id = ++next;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      browser.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }

  const consoleErrors = [];
  const pageErrors = [];
  const writes = [];
  const origin = `http://127.0.0.1:${staticPort}`;

  function fulfill(requestId, status, body, extraHeaders) {
    const headers = [
      { name: "Content-Type", value: "application/json" },
      { name: "Access-Control-Allow-Origin", value: origin },
      { name: "Access-Control-Allow-Methods", value: "GET,PUT,PATCH,POST,DELETE,OPTIONS" },
      { name: "Access-Control-Allow-Headers", value: "content-type,x-firebase-etag,if-match" },
      { name: "Access-Control-Expose-Headers", value: "ETag" },
      { name: "ETag", value: "test-etag" },
      ...(extraHeaders || [])
    ];
    session("Fetch.fulfillRequest", {
      requestId,
      responseCode: status,
      responseHeaders: headers,
      body: Buffer.from(body, "utf8").toString("base64")
    }).catch(() => {});
  }

  const pump = setInterval(() => {
    for (let i = 0; i < events.length; i++) {
      const msg = events[i];
      if (!msg || msg.sessionId !== sessionId) continue;
      events[i] = null;
      if (msg.method === "Fetch.requestPaused") {
        const { requestId, request } = msg.params;
        const url = request.url || "";
        const method = (request.method || "GET").toUpperCase();
        if (method === "OPTIONS") {
          fulfill(requestId, 204, "");
          continue;
        }
        if (method !== "GET") {
          writes.push({ method, url, body: request.postData || "" });
          fulfill(requestId, 200, request.postData || "null");
          continue;
        }
        const fake = firebase(url);
        if (fake.status === 0) fulfill(requestId, 500, "{\"error\":\"down\"}");
        else fulfill(requestId, fake.status, fake.body, fake.etag ? [{ name: "ETag", value: fake.etag }] : []);
      } else if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
        const text = (msg.params.args || []).map(a => a.value || a.description || "").join(" ");
        consoleErrors.push(text || "console.error");
      } else if (msg.method === "Runtime.exceptionThrown") {
        pageErrors.push(msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text || "exception");
      } else if (msg.method === "Log.entryAdded" && msg.params.entry?.level === "error") {
        const text = msg.params.entry.text || "";
        if (!/favicon|Failed to load resource/.test(text)) consoleErrors.push(text);
      }
    }
  }, 30);

  await session("Runtime.enable");
  await session("Console.enable");
  await session("Log.enable");
  await session("Page.enable");
  await session("Fetch.enable", { patterns: [{ urlPattern: "*firebaseio.com*", requestStage: "Request" }] });
  await session("Page.navigate", { url: `${origin}${path}` });
  await new Promise(r => setTimeout(r, 4000));
  const text = await session("Runtime.evaluate", { expression: "document.body ? document.body.innerText : ''", returnByValue: true });
  await new Promise(r => setTimeout(r, 200));
  clearInterval(pump);
  browser.close();
  return { text: text.result?.value || "", consoleErrors, pageErrors, writes };
}

const failures = [];
function check(name, cond, detail) {
  if (cond) console.log(`ok  ${name}`);
  else {
    console.error(`FAIL ${name}${detail ? "\n" + detail : ""}`);
    failures.push(name);
  }
}

const server = await startStatic();
const staticPort = server.address().port;
const debugPort = 9333;
const chromeProc = await launchChrome(debugPort);

try {
  const happy = await runPage({
    staticPort, debugPort,
    path: "/index.html?readonly=1",
    firebase(url) {
      if (url.includes("/board.json")) return { status: 200, body: JSON.stringify(fixtureBoard()), etag: "fixture" };
      if (url.includes("/state.json")) return { status: 200, body: "null", etag: "null_etag" };
      return { status: 200, body: "null", etag: "null_etag" };
    }
  });
  const noise = [...happy.consoleErrors, ...happy.pageErrors].filter(Boolean);
  check("page loads current JSON without console errors", noise.length === 0, noise.join("\n"));
  check("fixture roster is visible", happy.text.includes("Smoke Tester"));
  check("readonly load does not write Firebase", happy.writes.length === 0, JSON.stringify(happy.writes.map(w => w.method + " " + w.url)));

  const down = await runPage({
    staticPort, debugPort,
    path: "/index.html?readonly=1&nocache=1",
    firebase() { return { status: 0, body: "" }; }
  });
  check("failed load explains itself", /live board didn't load/i.test(down.text), down.text.slice(0, 400));
  check("failed load does not show the starter roster", !down.text.includes("Princess (REACH)"), down.text.slice(0, 400));
  check("failed load does not write Firebase", down.writes.length === 0);

  const baseline = JSON.parse(readFileSync(join(root, "board-baseline.json"), "utf8"));
  const active = (baseline.staff || []).find(s => s.dept && s.dept !== "Inactive");
  const repaired = await runPage({
    staticPort, debugPort,
    path: "/index.html?readonly=1",
    firebase(url) {
      if (url.includes("/board.json")) return { status: 200, body: "null", etag: "null_etag" };
      if (url.includes("/state.json")) return { status: 200, body: JSON.stringify(seedBoard()), etag: "seed" };
      return { status: 200, body: "null", etag: "null_etag" };
    }
  });
  check("seed document is not what the page shows", active && repaired.text.includes(active.name), active && active.name);
  check("seed document does not put Princess back on the board", !repaired.text.includes("Princess (REACH)"));
  check("readonly seed view does not write Firebase", repaired.writes.length === 0);

  const publish = await runPage({
    staticPort, debugPort,
    path: "/index.html?nocache=1",
    firebase(url) {
      if (url.includes("/board.json")) return { status: 200, body: "null", etag: "null_etag" };
      if (url.includes("/state.json")) return { status: 200, body: JSON.stringify(seedBoard()), etag: "seed" };
      return { status: 200, body: "null", etag: "null_etag" };
    }
  });
  const putBodies = publish.writes.filter(w => w.method === "PUT");
  check("a non-editor tab shows the baseline and does not write it", publish.text.includes(active.name) && putBodies.length === 0, "puts=" + putBodies.length);
} finally {
  try { chromeProc.proc.kill("SIGKILL"); } catch { /* already gone */ }
  await new Promise(r => setTimeout(r, 300));
  try { rmSync(chromeProc.profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch { /* temp profile */ }
  server.close();
}

if (failures.length) {
  console.error(`\n${failures.length} smoke check(s) failed`);
  process.exit(1);
}
console.log("\nsmoke passed");
