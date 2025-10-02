// ========= Local profile (device-only) + SQLite (sql.js) + OCRAD.js =========

// IndexedDB keys
const DB_KEY   = "honk_sqlite_v1";
const USER_KEY = "honk_user_v1";

let SQL, db;

// ---- DB boot / persistence ----
async function initDb() {
  SQL = await initSqlJs({
    locateFile: file => `https://cdn.jsdelivr.net/npm/sql.js@1.10.2/dist/${file}`
  });

  const saved = await idbKeyval.get(DB_KEY);

  if (saved && saved instanceof Uint8Array) {
    db = new SQL.Database(saved);
  } else if (saved && saved?.buffer) {
    db = new SQL.Database(new Uint8Array(saved));
  } else {
    db = new SQL.Database();
    db.run(`
      create table if not exists plates (
        plate_text text primary key,
        score integer not null default 0,
        updated_at text not null default (datetime('now'))
      );

      create table if not exists votes (
        id text primary key,
        plate_text text not null,
        value integer not null check (value in (-1,1)),
        created_at text not null default (datetime('now'))
      );

      create index if not exists idx_votes_plate on votes(plate_text);
    `);
    await persistDb();
  }
}

async function persistDb() {
  const binary = db.export();
  await idbKeyval.set(DB_KEY, binary);
}

// ---- tiny helpers ----
const $ = id => document.getElementById(id);
const nowIso = () => new Date().toISOString().replace("T", " ").replace("Z", "");
const uuid = () =>
  ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, c =>
    (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16)
  );

// ---- Local profile store ----
async function getUser() {
  return (await idbKeyval.get(USER_KEY)) || null;
}
async function setUser(name) {
  await idbKeyval.set(USER_KEY, name);
}
async function clearUser() {
  await idbKeyval.del(USER_KEY);
}

// ---- DOM refs ----
const authScr       = $("auth");
const nameInput     = $("display-name");
const enterBtn      = $("enter-app");

const mainScr       = $("main");
const preview       = $("preview");
const shutter       = $("shutter");

const confirmBackdrop = $("confirm-backdrop");
const plateInput      = $("plate-input");
const votePlus        = $("vote-plus");
const voteMinus       = $("vote-minus");
const cancelConfirm   = $("cancel-confirm");
const confirmMsg      = $("confirm-msg");

const scoresBackdrop  = $("scores-backdrop");
const openScores      = $("open-scores");
const closeScores     = $("close-scores");
const scoresMsg       = $("scores-msg");

const settingsBackdrop = $("settings-backdrop");
const openSettings     = $("open-settings");
const closeSettings    = $("close-settings");
const resetDbBtn       = $("reset-db");
const signOutLocalBtn  = $("sign-out-local");
const whoami           = $("whoami");

// ---- Camera ----
let stream;

function isCameraActive() {
  const s = preview?.srcObject;
  return !!(s && s.getTracks && s.getTracks().some(t => t.readyState === "live"));
}

async function startCamera() {
  if (isCameraActive()) {
    try {
      await preview.play();
    } catch {}
    return;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" } },
      audio: false
    });
    preview.srcObject = stream;
    await preview.play();
  } catch (e) {
    alert("Camera error: " + (e.message || e));
  }
}

function stopCamera() {
  const s = preview?.srcObject;
  if (s && s.getTracks) s.getTracks().forEach(t => t.stop());
  preview.srcObject = null;
}

async function resumeCameraPlayback() {
  try {
    await preview.play();
  } catch {
    // if stream died for any reason, restart
    await startCamera();
  }
}

// ---- OCR helpers (OCRAD.js) ----
function snapFrame(videoEl) {
  const w = videoEl.videoWidth || 1280;
  const h = videoEl.videoHeight || 720;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(videoEl, 0, 0, w, h);
  return canvas;
}

function cropCenter(canvas, fracW = 0.6, fracH = 0.25) {
  const w = canvas.width, h = canvas.height;
  const cw = Math.round(w * fracW);
  const ch = Math.round(h * fracH);
  const cx = Math.round((w - cw) / 2);
  const cy = Math.round((h - ch) / 2);
  const out = document.createElement("canvas");
  out.width = cw;
  out.height = ch;
  const ctx = out.getContext("2d");
  ctx.drawImage(canvas, cx, cy, cw, ch, 0, 0, cw, ch);
  return out;
}

function preprocess(canvas) {
  // simple grayscale + contrast boost
  const ctx = canvas.getContext("2d");
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;

  const factor = 1.4; // contrast factor
  for (let i = 0; i < d.length; i += 4) {
    const gray = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    let val = (gray - 128) * factor + 128;
    val = val < 0 ? 0 : val > 255 ? 255 : val;
    d[i] = d[i + 1] = d[i + 2] = val;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

function cleanPlateText(t) {
  return (t || "")
    .replace(/\s+/g, "")       // remove spaces
    .replace(/[^A-Za-z0-9]/g, "") // keep A-Z0-9
    .toUpperCase();
}

function ocrPlateFromVideo(videoEl) {
  try {
    const full = snapFrame(videoEl);
    const crop = cropCenter(full, 0.55, 0.22); // tighter band in middle
    const proc = preprocess(crop);
    const raw = window.OCRAD ? window.OCRAD(proc) : "";
    return cleanPlateText(raw);
  } catch {
    return "";
  }
}

// ---- Data layer (local SQL) ----
function ensurePlateRow(txPlate) {
  const stmtSel = db.prepare("select score from plates where plate_text = $p");
  stmtSel.bind({ $p: txPlate });
  const exists = stmtSel.step();
  stmtSel.free();

  if (!exists) {
    const ins = db.prepare("insert into plates (plate_text, score, updated_at) values ($p, 0, $t)");
    ins.bind({ $p: txPlate, $t: nowIso() });
    ins.step();
    ins.free();
  }
}

function addVote(plate, value) {
  const txPlate = plate.trim().toUpperCase();
  if (!txPlate) throw new Error("Plate required");

  ensurePlateRow(txPlate);

  const upd = db.prepare("update plates set score = score + $v, updated_at = $t where plate_text = $p");
  upd.bind({ $v: value, $t: nowIso(), $p: txPlate });
  upd.step();
  upd.free();

  const ins = db.prepare("insert into votes (id, plate_text, value, created_at) values ($id, $p, $v, $t)");
  ins.bind({ $id: uuid(), $p: txPlate, $v: value, $t: nowIso() });
  ins.step();
  ins.free();
}

function queryLeaderboard() {
  const best = [], worst = [];

  let stmt = db.prepare("select plate_text, score from plates where score > 0 order by score desc limit 50");
  while (stmt.step()) best.push(stmt.getAsObject());
  stmt.free();

  stmt = db.prepare("select plate_text, score from plates where score < 0 order by score asc limit 50");
  while (stmt.step()) worst.push(stmt.getAsObject());
  stmt.free();

  return { best, worst };
}

// ---- UI interactions ----

// Shutter: capture frame, run OCR, open confirm with prefilled text
shutter.onclick = async () => {
  const guess = ocrPlateFromVideo(preview);
  plateInput.value = guess || "";
  confirmMsg.textContent = guess ? "Auto-detected. Edit if needed." : "Type the plate.";
  confirmBackdrop.classList.remove("hidden");
};

// Vote handlers
async function afterVoteCleanup(plate, deltaLabel) {
  await persistDb();
  alert(`Recorded ${deltaLabel} for ${plate}`);
  confirmBackdrop.classList.add("hidden");
  await resumeCameraPlayback();
}

votePlus.onclick = async () => {
  const p = (plateInput.value || "").trim().toUpperCase();
  if (!p) { confirmMsg.textContent = "Plate required"; return; }

  try {
    addVote(p, +1);
    await afterVoteCleanup(p, "+1");
  } catch (e) {
    confirmMsg.textContent = e.message || String(e);
    await resumeCameraPlayback();
  }
};

voteMinus.onclick = async () => {
  const p = (plateInput.value || "").trim().toUpperCase();
  if (!p) { confirmMsg.textContent = "Plate required"; return; }

  try {
    addVote(p, -1);
    await afterVoteCleanup(p, "-1");
  } catch (e) {
    confirmMsg.textContent = e.message || String(e);
    await resumeCameraPlayback();
  }
};

cancelConfirm.onclick = async () => {
  confirmBackdrop.classList.add("hidden");
  await resumeCameraPlayback();
};

// Scores
openScores.onclick = () => {
  scoresBackdrop.classList.remove("hidden");
  loadScores();
};
closeScores.onclick = () => {
  scoresBackdrop.classList.add("hidden");
};

function loadScores() {
  scoresMsg.textContent = "";
  const bestList  = document.getElementById("best-list");
  const worstList = document.getElementById("worst-list");
  bestList.innerHTML = "";
  worstList.innerHTML = "";

  try {
    const { best, worst } = queryLeaderboard();

    if (best.length === 0) {
      const li = document.createElement("li");
      li.textContent = "No positive scores yet.";
      bestList.appendChild(li);
    } else {
      best.forEach((r, i) => {
        const li = document.createElement("li");
        li.textContent = `${i + 1}. ${r.plate_text} — +${r.score}`;
        bestList.appendChild(li);
      });
    }

    if (worst.length === 0) {
      const li = document.createElement("li");
      li.textContent = "No negative scores yet.";
      worstList.appendChild(li);
    } else {
      worst.forEach((r, i) => {
        const li = document.createElement("li");
        li.textContent = `${i + 1}. ${r.plate_text} — ${r.score}`;
        worstList.appendChild(li);
      });
    }
  } catch (e) {
    scoresMsg.textContent = e.message || String(e);
  }
}

// Settings
openSettings.onclick = async () => {
  const user = await getUser();
  whoami.textContent = user ? `Signed in as: ${user}` : "Not signed in";
  settingsBackdrop.classList.remove("hidden");
};
closeSettings.onclick = () => settingsBackdrop.classList.add("hidden");

resetDbBtn.onclick = async () => {
  if (!confirm("Reset local database? This cannot be undone.")) return;
  db.run(`drop table if exists votes; drop table if exists plates;`);
  db.run(`
    create table plates (
      plate_text text primary key,
      score integer not null default 0,
      updated_at text not null default (datetime('now'))
    );

    create table votes (
      id text primary key,
      plate_text text not null,
      value integer not null check (value in (-1,1)),
      created_at text not null default (datetime('now'))
    );

    create index if not exists idx_votes_plate on votes(plate_text);
  `);
  await persistDb();
  alert("Local DB reset.");
};

signOutLocalBtn.onclick = async () => {
  await clearUser();
  stopCamera();
  mainScr.classList.add("hidden");
  authScr.classList.remove("hidden");
};

// Local “login”
enterBtn.onclick = async () => {
  const name = (nameInput.value || "").trim();
  if (!name) { alert("Please enter a name"); return; }

  await setUser(name);
  authScr.classList.add("hidden");
  mainScr.classList.remove("hidden");
  await startCamera();
};

// ---- Boot sequence ----
await initDb();
const existingUser = await getUser();

if (existingUser) {
  authScr.classList.add("hidden");
  mainScr.classList.remove("hidden");
  await startCamera();
} else {
  mainScr.classList.add("hidden");
  authScr.classList.remove("hidden");
}

// Best-effort persistence / teardown
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") persistDb();
});
window.addEventListener("beforeunload", () => {
  persistDb();
  stopCamera();
});
