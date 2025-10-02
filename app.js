// ========= Local profile (device-only) + SQLite (sql.js) persistence =========



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

  } else if (saved && saved.buffer) {

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

  const binary = db.export(); // Uint8Array

  await idbKeyval.set(DB_KEY, binary);

}



// ---- tiny helpers ----

function nowIso() {

  return new Date().toISOString().replace('T',' ').replace('Z','');

}

function uuid() {

  return ([1e7]+-1e3+-4e3+-8e3+-1e11)

    .replace(/[018]/g, c => (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16));

}



// ---- Local profile store ----

async function getUser() { return (await idbKeyval.get(USER_KEY)) || null; }

async function setUser(name) { await idbKeyval.set(USER_KEY, name); }

async function clearUser() { await idbKeyval.del(USER_KEY); }



// ---- DOM refs ----

const $ = id => document.getElementById(id);



// Auth screen

const authScr   = $("auth");

const nameInput = $("display-name");

const enterBtn  = $("enter-app");



// Main + camera

const mainScr = $("main");

const preview = $("preview");

const shutter = $("shutter");



// Modals & controls

const confirmBackdrop = $("confirm-backdrop");

const plateInput      = $("plate-input");

const votePlus        = $("vote-plus");

const voteMinus       = $("vote-minus");

const cancelConfirm   = $("cancel-confirm");

const confirmMsg      = $("confirm-msg");



const scoresBackdrop = $("scores-backdrop");

const openScores     = $("open-scores");

const closeScores    = $("close-scores");

const scoresMsg      = $("scores-msg");



const settingsBackdrop = $("settings-backdrop");

const openSettings     = $("open-settings");

const closeSettings    = $("close-settings");

const resetDbBtn       = $("reset-db");

const signOutLocalBtn  = $("sign-out-local");

const whoami           = $("whoami");



// ---- Camera ----

let stream;

async function startCamera() {

  try {

    stream = await navigator.mediaDevices.getUserMedia({

      video: { facingMode: { ideal: "environment" } },

      audio: false

    });

    preview.srcObject = stream;

  } catch (e) {

    alert("Camera error: " + (e.message || e));

  }

}

function stopCamera() {

  if (stream) stream.getTracks().forEach(t => t.stop());

  preview.srcObject = null;

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

    ins.step(); ins.free();

  }

}



function addVote(plate, value) {

  const txPlate = plate.trim().toUpperCase();

  if (!txPlate) throw new Error("Plate required");



  ensurePlateRow(txPlate);



  const upd = db.prepare("update plates set score = score + $v, updated_at = $t where plate_text = $p");

  upd.bind({ $v: value, $t: nowIso(), $p: txPlate });

  upd.step(); upd.free();



  const ins = db.prepare("insert into votes (id, plate_text, value, created_at) values ($id, $p, $v, $t)");

  ins.bind({ $id: uuid(), $p: txPlate, $v: value, $t: nowIso() });

  ins.step(); ins.free();

}



function queryLeaderboard() {

  const best = [];

  const worst = [];

  let stmt = db.prepare("select plate_text, score from plates where score > 0 order by score desc limit 50");

  while (stmt.step()) best.push(stmt.getAsObject());

  stmt.free();

  stmt = db.prepare("select plate_text, score from plates where score < 0 order by score asc limit 50");

  while (stmt.step()) worst.push(stmt.getAsObject());

  stmt.free();

  return { best, worst };

}



// ---- UI interactions ----

shutter.onclick = () => {

  plateInput.value = "";

  confirmMsg.textContent = "";

  confirmBackdrop.classList.remove("hidden");

};



votePlus.onclick = async () => {

  const p = (plateInput.value || "").trim().toUpperCase();

  if (!p) { confirmMsg.textContent = "Plate required"; return; }

  try {

    addVote(p, +1);

    await persistDb();

    alert(`Recorded +1 for ${p}`);

    confirmBackdrop.classList.add("hidden");

  } catch (e) {

    confirmMsg.textContent = e.message || String(e);

  }

};



voteMinus.onclick = async () => {

  const p = (plateInput.value || "").trim().toUpperCase();

  if (!p) { confirmMsg.textContent = "Plate required"; return; }

  try {

    addVote(p, -1);

    await persistDb();

    alert(`Recorded -1 for ${p}`);

    confirmBackdrop.classList.add("hidden");

  } catch (e) {

    confirmMsg.textContent = e.message || String(e);

  }

};



cancelConfirm.onclick = () => confirmBackdrop.classList.add("hidden");



// Scores

openScores.onclick = () => {

  scoresBackdrop.classList.remove("hidden");

  loadScores();

};

closeScores.onclick = () => scoresBackdrop.classList.add("hidden");



function loadScores() {

  scoresMsg.textContent = "";

  const bestList  = document.getElementById("best-list");

  const worstList = document.getElementById("worst-list");

  bestList.innerHTML = ""; worstList.innerHTML = "";

  try {

    const { best, worst } = queryLeaderboard();

    if (best.length === 0) {

      const li = document.createElement("li"); li.textContent = "No positive scores yet."; bestList.appendChild(li);

    } else {

      best.forEach((r, i) => {

        const li = document.createElement("li");

        li.textContent = `${i+1}. ${r.plate_text} — +${r.score}`;

        bestList.appendChild(li);

      });

    }

    if (worst.length === 0) {

      const li = document.createElement("li"); li.textContent = "No negative scores yet."; worstList.appendChild(li);

    } else {

      worst.forEach((r, i) => {

        const li = document.createElement("li");

        li.textContent = `${i+1}. ${r.plate_text} — ${r.score}`;

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

    create table plates(plate_text text primary key, score integer not null default 0, updated_at text not null default (datetime('now')));

    create table votes(id text primary key, plate_text text not null, value integer not null check (value in (-1,1)), created_at text not null default (datetime('now')));

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

window.addEventListener("beforeunload", () => { persistDb(); stopCamera(); });