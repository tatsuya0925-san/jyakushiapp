"use strict";

/* ==========================================================
   データベース（IndexedDB）まわり
   ========================================================== */

const DB_NAME = "amblyopiaTrainingDB";
const DB_VERSION = 1;
const STORE_RECORDS = "records";
const STORE_SETTINGS = "settings";
const DEFAULT_GOAL_MINUTES = 120;

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_RECORDS)) {
        db.createObjectStore(STORE_RECORDS, { keyPath: "date" });
      }
      if (!db.objectStoreNames.contains(STORE_SETTINGS)) {
        db.createObjectStore(STORE_SETTINGS, { keyPath: "key" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(storeName, mode) {
  return openDB().then((db) => db.transaction(storeName, mode).objectStore(storeName));
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getRecord(date) {
  const store = await tx(STORE_RECORDS, "readonly");
  const result = await reqToPromise(store.get(date));
  return result || { date, minutes: 0, memo: "", updatedAt: null };
}

async function putRecord(record) {
  const store = await tx(STORE_RECORDS, "readwrite");
  await reqToPromise(store.put(record));
}

async function getAllRecords() {
  const store = await tx(STORE_RECORDS, "readonly");
  return reqToPromise(store.getAll());
}

async function clearRecords() {
  const store = await tx(STORE_RECORDS, "readwrite");
  await reqToPromise(store.clear());
}

async function getSetting(key, defaultValue) {
  const store = await tx(STORE_SETTINGS, "readonly");
  const result = await reqToPromise(store.get(key));
  return result ? result.value : defaultValue;
}

async function setSetting(key, value) {
  const store = await tx(STORE_SETTINGS, "readwrite");
  await reqToPromise(store.put({ key, value }));
}

/**
 * 指定した日付の記録に、渡した項目だけを上書き保存する。
 * （分だけ更新／メモだけ更新、のどちらでも他方を消さないため）
 */
async function saveRecordPatch(date, patch) {
  const current = await getRecord(date);
  const updated = Object.assign({}, current, patch, {
    date,
    updatedAt: new Date().toISOString(),
  });
  await putRecord(updated);
  return updated;
}

/* ==========================================================
   日付まわりのユーティリティ（ローカル時刻基準）
   ========================================================== */

function pad2(n) {
  return String(n).padStart(2, "0");
}

function dateToKey(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function keyToDate(key) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function formatDateLabel(d) {
  const weekdays = ["日", "月", "火", "水", "木", "金", "土"];
  return `${d.getMonth() + 1}月${d.getDate()}日（${weekdays[d.getDay()]}）`;
}

function todayKey() {
  return dateToKey(new Date());
}

/* ==========================================================
   アプリの状態
   ========================================================== */

const state = {
  dailyGoalMinutes: DEFAULT_GOAL_MINUTES,
  currentEditDate: todayKey(),
  calendarYear: new Date().getFullYear(),
  calendarMonth: new Date().getMonth(), // 0-11
};

const RING_CIRCUMFERENCE = 2 * Math.PI * 52;

/* ==========================================================
   画面切り替え（タブ）
   ========================================================== */

const views = {
  day: document.getElementById("view-day"),
  calendar: document.getElementById("view-calendar"),
  settings: document.getElementById("view-settings"),
};

function showView(name) {
  Object.entries(views).forEach(([key, el]) => {
    el.classList.toggle("active", key === name);
  });
  document.querySelectorAll(".nav-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.view === name);
  });
  if (name === "calendar") {
    renderCalendar();
  }
}

document.querySelectorAll(".nav-btn").forEach((btn) => {
  btn.addEventListener("click", () => showView(btn.dataset.view));
});

/* ==========================================================
   記録画面（今日 / 選んだ日）
   ========================================================== */

const dayDateLabel = document.getElementById("day-date-label");
const backToTodayBtn = document.getElementById("back-to-today-btn");
const minutesInput = document.getElementById("minutes-input");
const memoInput = document.getElementById("memo-input");
const saveStatus = document.getElementById("save-status");
const ringProgress = document.getElementById("ring-progress");
const ringMinutes = document.getElementById("ring-minutes");
const ringGoalText = document.getElementById("ring-goal-text");
const ringPercent = document.getElementById("ring-percent");

function updateRing(minutes) {
  const goal = state.dailyGoalMinutes || DEFAULT_GOAL_MINUTES;
  const ratio = goal > 0 ? Math.min(minutes / goal, 1) : 0;
  const offset = RING_CIRCUMFERENCE * (1 - ratio);
  ringProgress.style.strokeDashoffset = String(offset);
  ringMinutes.textContent = String(minutes);
  ringGoalText.textContent = `/ 目標${goal}分`;
  ringPercent.textContent = `${Math.round(ratio * 100)}%`;
}

let statusTimer = null;
function flashStatus(message) {
  saveStatus.textContent = message;
  if (statusTimer) clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    saveStatus.textContent = " ";
  }, 1800);
}

async function loadDayView(dateKey) {
  state.currentEditDate = dateKey;
  const d = keyToDate(dateKey);
  const isToday = dateKey === todayKey();
  dayDateLabel.textContent = formatDateLabel(d);
  backToTodayBtn.classList.toggle("hidden", isToday);

  const record = await getRecord(dateKey);
  minutesInput.value = record.minutes || 0;
  memoInput.value = record.memo || "";
  updateRing(record.minutes || 0);
  saveStatus.textContent = " ";
}

async function addMinutes(delta) {
  const current = await getRecord(state.currentEditDate);
  const next = Math.max(0, (current.minutes || 0) + delta);
  minutesInput.value = next;
  await saveRecordPatch(state.currentEditDate, { minutes: next });
  updateRing(next);
  flashStatus("保存しました");
}

document.querySelectorAll(".btn-quick").forEach((btn) => {
  btn.addEventListener("click", () => addMinutes(Number(btn.dataset.add)));
});

minutesInput.addEventListener("change", async () => {
  let value = parseInt(minutesInput.value, 10);
  if (isNaN(value) || value < 0) value = 0;
  minutesInput.value = value;
  await saveRecordPatch(state.currentEditDate, { minutes: value });
  updateRing(value);
  flashStatus("保存しました");
});

memoInput.addEventListener("blur", async () => {
  await saveRecordPatch(state.currentEditDate, { memo: memoInput.value });
  flashStatus("保存しました");
});

backToTodayBtn.addEventListener("click", () => {
  loadDayView(todayKey());
});

/* ==========================================================
   カレンダー画面
   ========================================================== */

const calTitle = document.getElementById("cal-title");
const calGrid = document.getElementById("calendar-grid");

document.getElementById("cal-prev").addEventListener("click", () => {
  state.calendarMonth -= 1;
  if (state.calendarMonth < 0) {
    state.calendarMonth = 11;
    state.calendarYear -= 1;
  }
  renderCalendar();
});

document.getElementById("cal-next").addEventListener("click", () => {
  state.calendarMonth += 1;
  if (state.calendarMonth > 11) {
    state.calendarMonth = 0;
    state.calendarYear += 1;
  }
  renderCalendar();
});

async function renderCalendar() {
  const { calendarYear, calendarMonth, dailyGoalMinutes } = state;
  calTitle.textContent = `${calendarYear}年${calendarMonth + 1}月`;

  const allRecords = await getAllRecords();
  const recordMap = new Map(allRecords.map((r) => [r.date, r]));

  const firstDay = new Date(calendarYear, calendarMonth, 1);
  const daysInMonth = new Date(calendarYear, calendarMonth + 1, 0).getDate();
  const startOffset = firstDay.getDay(); // 0=日
  const totalCells = Math.ceil((startOffset + daysInMonth) / 7) * 7;
  const todK = todayKey();

  calGrid.innerHTML = "";
  for (let i = 0; i < totalCells; i++) {
    const dayNum = i - startOffset + 1;
    const cell = document.createElement("button");
    cell.type = "button";
    cell.className = "cal-cell";

    if (dayNum < 1 || dayNum > daysInMonth) {
      cell.classList.add("other-month");
      cell.disabled = true;
    } else {
      const d = new Date(calendarYear, calendarMonth, dayNum);
      const key = dateToKey(d);
      const record = recordMap.get(key);
      cell.textContent = String(dayNum);

      if (record) {
        if ((record.minutes || 0) >= dailyGoalMinutes) {
          cell.classList.add("status-achieved");
        } else {
          cell.classList.add("status-partial");
        }
      }
      if (key === todK) {
        cell.classList.add("is-today");
      }
      cell.addEventListener("click", () => {
        loadDayView(key);
        showView("day");
      });
    }
    calGrid.appendChild(cell);
  }
}

/* ==========================================================
   設定画面
   ========================================================== */

const goalInput = document.getElementById("goal-input");
const goalSaveBtn = document.getElementById("goal-save-btn");
const exportBtn = document.getElementById("export-btn");
const importBtn = document.getElementById("import-btn");
const importFile = document.getElementById("import-file");
const backupStatus = document.getElementById("backup-status");

goalSaveBtn.addEventListener("click", async () => {
  let value = parseInt(goalInput.value, 10);
  if (isNaN(value) || value < 1) value = DEFAULT_GOAL_MINUTES;
  goalInput.value = value;
  state.dailyGoalMinutes = value;
  await setSetting("dailyGoalMinutes", value);
  updateRing(Number(minutesInput.value) || 0);
  flashBackupStatus("目標を保存しました");
});

let backupStatusTimer = null;
function flashBackupStatus(message) {
  backupStatus.textContent = message;
  if (backupStatusTimer) clearTimeout(backupStatusTimer);
  backupStatusTimer = setTimeout(() => {
    backupStatus.textContent = " ";
  }, 2200);
}

exportBtn.addEventListener("click", async () => {
  const records = await getAllRecords();
  const data = {
    exportedAt: new Date().toISOString(),
    version: 1,
    settings: { dailyGoalMinutes: state.dailyGoalMinutes },
    records: records.sort((a, b) => (a.date < b.date ? -1 : 1)),
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const stamp = dateToKey(new Date());
  a.href = url;
  a.download = `弱視トレーニング記録_${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  flashBackupStatus("書き出しました");
});

importBtn.addEventListener("click", () => {
  importFile.click();
});

importFile.addEventListener("change", async () => {
  const file = importFile.files && importFile.files[0];
  importFile.value = "";
  if (!file) return;

  try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (!data || !Array.isArray(data.records)) {
      throw new Error("invalid format");
    }
    const ok = window.confirm(
      "今の端末のデータを、このファイルの内容ですべて置き換えます。よろしいですか？"
    );
    if (!ok) return;

    await clearRecords();
    for (const r of data.records) {
      if (!r || typeof r.date !== "string") continue;
      await putRecord({
        date: r.date,
        minutes: Number(r.minutes) || 0,
        memo: typeof r.memo === "string" ? r.memo : "",
        updatedAt: r.updatedAt || new Date().toISOString(),
      });
    }

    if (data.settings && Number(data.settings.dailyGoalMinutes) > 0) {
      state.dailyGoalMinutes = Number(data.settings.dailyGoalMinutes);
      await setSetting("dailyGoalMinutes", state.dailyGoalMinutes);
      goalInput.value = state.dailyGoalMinutes;
    }

    await loadDayView(state.currentEditDate);
    flashBackupStatus("読み込みました");
  } catch (err) {
    flashBackupStatus("読み込みに失敗しました（ファイルを確認してください）");
  }
});

/* ==========================================================
   初期化
   ========================================================== */

async function init() {
  state.dailyGoalMinutes = await getSetting("dailyGoalMinutes", DEFAULT_GOAL_MINUTES);
  goalInput.value = state.dailyGoalMinutes;
  await loadDayView(todayKey());

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => {
      /* オフライン対応ができなくても、アプリ自体は動作する */
    });
  }
}

init();
