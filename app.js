"use strict";

const DEFAULT_GOAL_MINUTES = 120;
const DEFAULT_EYE = "right";

/* ==========================================================
   共有コード（世帯コード）の管理
   ========================================================== */

const HOUSEHOLD_CODE_STORAGE_KEY = "amblyopiaHouseholdCode";
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // 0,O,1,I,L など紛らわしい文字を除外

function generateHouseholdCode() {
  const groups = [];
  for (let g = 0; g < 5; g++) {
    const randomValues = new Uint8Array(4);
    crypto.getRandomValues(randomValues);
    let group = "";
    for (let i = 0; i < 4; i++) {
      group += CODE_ALPHABET[randomValues[i] % CODE_ALPHABET.length];
    }
    groups.push(group);
  }
  return groups.join("-");
}

function normalizeHouseholdCode(code) {
  return (code || "").trim().toUpperCase();
}

function loadHouseholdCode() {
  let code = localStorage.getItem(HOUSEHOLD_CODE_STORAGE_KEY);
  if (!code) {
    code = generateHouseholdCode();
    localStorage.setItem(HOUSEHOLD_CODE_STORAGE_KEY, code);
  }
  return code;
}

function saveHouseholdCode(code) {
  const normalized = normalizeHouseholdCode(code);
  localStorage.setItem(HOUSEHOLD_CODE_STORAGE_KEY, normalized);
  return normalized;
}

let householdCode = loadHouseholdCode();

/* ==========================================================
   Firebase / Firestore まわり
   ========================================================== */

const FIREBASE_NOT_CONFIGURED =
  typeof window.firebaseConfig === "undefined" || window.firebaseConfig.apiKey === "YOUR_API_KEY";

let db = null;

function householdDoc() {
  return db.collection("households").doc(householdCode);
}

function recordsCol() {
  return householdDoc().collection("records");
}

function settingsDocRef() {
  return householdDoc().collection("settings").doc("app");
}

const recordsCache = new Map();
const settingsCache = { dailyGoalMinutes: DEFAULT_GOAL_MINUTES, currentEye: DEFAULT_EYE };

let unsubscribeRecords = null;
let unsubscribeSettings = null;

function emptyRecord(date) {
  return {
    date,
    slot1Start: null,
    slot1End: null,
    slot2Start: null,
    slot2End: null,
    minutes: 0,
    notDone: false,
    eye: null,
    memo: "",
    updatedAt: null,
  };
}

function eyeLabel(eye) {
  return eye === "left" ? "左目" : "右目";
}

/** レコード／設定のリアルタイム購読を開始し、最初の1回分のデータが届くまで待つ */
function attachListeners() {
  if (unsubscribeRecords) unsubscribeRecords();
  if (unsubscribeSettings) unsubscribeSettings();
  recordsCache.clear();

  return new Promise((resolve) => {
    let recordsReady = false;
    let settingsReady = false;
    const maybeResolve = () => {
      if (recordsReady && settingsReady) resolve();
    };

    unsubscribeRecords = recordsCol().onSnapshot(
      (snapshot) => {
        snapshot.docChanges().forEach((change) => {
          if (change.type === "removed") {
            recordsCache.delete(change.doc.id);
          } else {
            recordsCache.set(change.doc.id, change.doc.data());
          }
        });
        setSyncStatus(!snapshot.metadata.fromCache);
        if (!recordsReady) {
          recordsReady = true;
          maybeResolve();
        }
        onRemoteDataChanged();
      },
      () => {
        setSyncStatus(false);
        if (!recordsReady) {
          recordsReady = true;
          maybeResolve();
        }
      }
    );

    unsubscribeSettings = settingsDocRef().onSnapshot(
      (snap) => {
        const data = snap.data() || {};
        if (typeof data.dailyGoalMinutes === "number") settingsCache.dailyGoalMinutes = data.dailyGoalMinutes;
        if (data.currentEye === "left" || data.currentEye === "right") settingsCache.currentEye = data.currentEye;
        state.dailyGoalMinutes = settingsCache.dailyGoalMinutes;
        state.currentEye = settingsCache.currentEye;
        goalInput.value = state.dailyGoalMinutes;
        updateEyeToggleUI();
        if (!settingsReady) {
          settingsReady = true;
          maybeResolve();
        }
        onRemoteDataChanged();
      },
      () => {
        if (!settingsReady) {
          settingsReady = true;
          maybeResolve();
        }
      }
    );
  });
}

function onRemoteDataChanged() {
  const activeBtn = document.querySelector(".nav-btn.active");
  const activeView = activeBtn ? activeBtn.dataset.view : "day";
  if (activeView === "day") {
    refreshDayViewFromCache();
  } else if (activeView === "calendar") {
    renderCalendar();
  }
}

async function refreshDayViewFromCache() {
  const record = await getRecord(state.currentEditDate);
  if (document.activeElement !== memoInput) {
    memoInput.value = record.memo || "";
  }
  applyRecordToUI(record);
}

/* ---- データ読み書き（recordsCache 経由。onSnapshot が裏で同期を保つ） ---- */

async function getRecord(date) {
  return recordsCache.get(date) || emptyRecord(date);
}

async function putRecord(record) {
  await recordsCol().doc(record.date).set(record);
}

async function getAllRecords() {
  return [...recordsCache.values()];
}

async function clearRecords() {
  const snap = await recordsCol().get();
  const docs = snap.docs;
  const chunkSize = 450;
  for (let i = 0; i < docs.length; i += chunkSize) {
    const batch = db.batch();
    docs.slice(i, i + chunkSize).forEach((d) => batch.delete(d.ref));
    await batch.commit();
  }
  recordsCache.clear();
}

async function getSetting(key, defaultValue) {
  return key in settingsCache ? settingsCache[key] : defaultValue;
}

async function setSetting(key, value) {
  settingsCache[key] = value;
  await settingsDocRef().set({ [key]: value }, { merge: true });
}

/**
 * 指定した日付の記録に、渡した項目だけを上書き保存する。
 * （一部の項目だけ更新しても、他の項目を消さないため）
 */
async function saveRecordPatch(date, patch) {
  const fullPatch = Object.assign({}, patch, { date, updatedAt: new Date().toISOString() });
  await recordsCol().doc(date).set(fullPatch, { merge: true });
  const current = recordsCache.get(date) || emptyRecord(date);
  const updated = Object.assign({}, current, fullPatch);
  recordsCache.set(date, updated);
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

function monthRange(year, month) {
  const start = `${year}-${pad2(month + 1)}-01`;
  const end = dateToKey(new Date(year, month + 1, 0));
  return { start, end };
}

/* ==========================================================
   アプリの状態
   ========================================================== */

const initialMonthRange = monthRange(new Date().getFullYear(), new Date().getMonth());

const state = {
  dailyGoalMinutes: DEFAULT_GOAL_MINUTES,
  currentEditDate: todayKey(),
  calendarYear: new Date().getFullYear(),
  calendarMonth: new Date().getMonth(), // 0-11
  periodStart: initialMonthRange.start,
  periodEnd: initialMonthRange.end,
  currentEye: DEFAULT_EYE,
};

const RING_CIRCUMFERENCE = 2 * Math.PI * 52;

/* ==========================================================
   同期状態バッジ
   ========================================================== */

const syncBadgeEl = document.getElementById("sync-badge");

function setSyncStatus(online) {
  if (!syncBadgeEl) return;
  syncBadgeEl.textContent = online
    ? "オンラインで同期中"
    : "オフライン（この端末に保存し、再接続時に同期します）";
  syncBadgeEl.classList.toggle("sync-offline", !online);
}

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
const notDoneBtn = document.getElementById("not-done-btn");
const eyeIndicatorEl = document.getElementById("eye-indicator");
const timeSlotsEl = document.getElementById("time-slots");
const memoInput = document.getElementById("memo-input");
const saveStatus = document.getElementById("save-status");
const ringProgress = document.getElementById("ring-progress");
const ringMinutes = document.getElementById("ring-minutes");
const ringGoalText = document.getElementById("ring-goal-text");
const ringPercent = document.getElementById("ring-percent");
const slot1DurationEl = document.getElementById("slot1-duration");
const slot2DurationEl = document.getElementById("slot2-duration");

/* ---- 時刻入力（プルダウン兼用のネイティブ時刻ピッカー） ---- */

function timeInputOf(slot, edge) {
  return document.querySelector(`.time-input[data-slot="${slot}"][data-edge="${edge}"]`);
}

function applyTimeToInput(slot, edge, timeStr) {
  timeInputOf(slot, edge).value = timeStr || "";
}

function readTimeFromInput(slot, edge) {
  const value = timeInputOf(slot, edge).value;
  return value || null;
}

function minutesFromTimeString(str) {
  if (!str) return null;
  const parts = str.split(":").map(Number);
  return parts[0] * 60 + parts[1];
}

/** 開始・終了のどちらかが未入力、または終了が開始より前の場合は 0 分として扱う */
function durationMinutes(startStr, endStr) {
  if (!startStr || !endStr) return 0;
  const s = minutesFromTimeString(startStr);
  const e = minutesFromTimeString(endStr);
  return Math.max(0, e - s);
}

function updateRing(minutes, notDone) {
  const goal = state.dailyGoalMinutes || DEFAULT_GOAL_MINUTES;
  const ratio = notDone ? 0 : goal > 0 ? Math.min(minutes / goal, 1) : 0;
  ringProgress.style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - ratio));
  ringProgress.classList.toggle("ring-progress-muted", !!notDone);
  if (notDone) {
    ringMinutes.textContent = "-";
    ringGoalText.textContent = "未実施";
    ringPercent.textContent = "";
  } else {
    ringMinutes.textContent = String(minutes);
    ringGoalText.textContent = `/ 目標${goal}分`;
    ringPercent.textContent = `${Math.round(ratio * 100)}%`;
  }
}

function updateSlotDurationTexts(slot1Start, slot1End, slot2Start, slot2End) {
  const d1 = durationMinutes(slot1Start, slot1End);
  const d2 = durationMinutes(slot2Start, slot2End);
  slot1DurationEl.textContent = slot1Start && slot1End ? `${d1}分` : "-";
  slot2DurationEl.textContent = slot2Start && slot2End ? `${d2}分` : "-";
  return d1 + d2;
}

function setSlotsEnabled(enabled) {
  timeSlotsEl.querySelectorAll(".time-input").forEach((el) => {
    el.disabled = !enabled;
  });
  timeSlotsEl.classList.toggle("disabled-look", !enabled);
}

function applyRecordToUI(record) {
  eyeIndicatorEl.textContent = `パッチする目：${eyeLabel(record.eye || state.currentEye)}`;
  applyTimeToInput(1, "start", record.slot1Start);
  applyTimeToInput(1, "end", record.slot1End);
  applyTimeToInput(2, "start", record.slot2Start);
  applyTimeToInput(2, "end", record.slot2End);
  updateSlotDurationTexts(record.slot1Start, record.slot1End, record.slot2Start, record.slot2End);

  notDoneBtn.setAttribute("aria-pressed", record.notDone ? "true" : "false");
  setSlotsEnabled(!record.notDone);

  updateRing(record.minutes || 0, !!record.notDone);
}

let statusTimer = null;
function flashStatus(message) {
  saveStatus.textContent = message;
  if (statusTimer) clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    saveStatus.textContent = " ";
  }, 1800);
}

async function loadDayView(dateKey) {
  state.currentEditDate = dateKey;
  const d = keyToDate(dateKey);
  const isToday = dateKey === todayKey();
  dayDateLabel.textContent = formatDateLabel(d);
  backToTodayBtn.classList.toggle("hidden", isToday);

  const record = await getRecord(dateKey);
  memoInput.value = record.memo || "";
  applyRecordToUI(record);
  saveStatus.textContent = " ";
}

async function onTimeInputChange() {
  const slot1Start = readTimeFromInput(1, "start");
  const slot1End = readTimeFromInput(1, "end");
  const slot2Start = readTimeFromInput(2, "start");
  const slot2End = readTimeFromInput(2, "end");
  const total = updateSlotDurationTexts(slot1Start, slot1End, slot2Start, slot2End);

  const updated = await saveRecordPatch(state.currentEditDate, {
    slot1Start,
    slot1End,
    slot2Start,
    slot2End,
    minutes: total,
    notDone: false,
    eye: state.currentEye,
  });
  notDoneBtn.setAttribute("aria-pressed", "false");
  setSlotsEnabled(true);
  updateRing(updated.minutes, false);
  flashStatus("保存しました");
}

timeSlotsEl.querySelectorAll(".time-input").forEach((el) => {
  el.addEventListener("change", onTimeInputChange);
});

notDoneBtn.addEventListener("click", async () => {
  const current = await getRecord(state.currentEditDate);
  const nextNotDone = !current.notDone;

  const patch = nextNotDone
    ? {
        notDone: true,
        slot1Start: null,
        slot1End: null,
        slot2Start: null,
        slot2End: null,
        minutes: 0,
        eye: state.currentEye,
      }
    : { notDone: false };

  const updated = await saveRecordPatch(state.currentEditDate, patch);
  applyRecordToUI(updated);
  flashStatus(nextNotDone ? "「未実施」として保存しました" : "記録の入力に戻りました");
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
const periodStartInput = document.getElementById("period-start-input");
const periodEndInput = document.getElementById("period-end-input");
const periodTotalEl = document.getElementById("period-total");
const periodAverageEl = document.getElementById("period-average");
const periodWearDaysEl = document.getElementById("period-wear-days");
const calendarEyeIndicatorEl = document.getElementById("calendar-eye-indicator");

/** 1時間=1、15分刻み(0.25)で装着時間を表す文字列にする */
function formatHoursLabel(minutes) {
  const hours = Math.round(minutes / 60 / 0.25) * 0.25;
  return String(hours);
}

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
  calendarEyeIndicatorEl.textContent = `パッチする目：${eyeLabel(state.currentEye)}`;

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

      const dayNumEl = document.createElement("span");
      dayNumEl.className = "cal-daynum";
      dayNumEl.textContent = String(dayNum);
      cell.appendChild(dayNumEl);

      if (record && !record.notDone && (record.minutes || 0) > 0) {
        const hoursEl = document.createElement("span");
        hoursEl.className = "cal-hours";
        hoursEl.textContent = formatHoursLabel(record.minutes);
        cell.appendChild(hoursEl);
      }

      if (record) {
        if (record.notDone) {
          cell.classList.add("status-not-done");
        } else if ((record.minutes || 0) >= dailyGoalMinutes) {
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

  periodStartInput.value = state.periodStart;
  periodEndInput.value = state.periodEnd;
  renderPeriodSummary(allRecords);
}

function renderPeriodSummary(recordsList) {
  const rangeStart = state.periodStart < state.periodEnd ? state.periodStart : state.periodEnd;
  const rangeEnd = state.periodStart < state.periodEnd ? state.periodEnd : state.periodStart;

  const dayCount =
    Math.round((keyToDate(rangeEnd) - keyToDate(rangeStart)) / 86400000) + 1;

  const recordsInRange = recordsList.filter((r) => r.date >= rangeStart && r.date <= rangeEnd);

  const total = recordsInRange.reduce((sum, r) => sum + (r.minutes || 0), 0);
  const average = dayCount > 0 ? total / dayCount : 0;
  const wearDays = recordsInRange.filter((r) => !r.notDone && (r.minutes || 0) > 0).length;

  periodTotalEl.textContent = `${total}分`;
  periodAverageEl.textContent = `${average.toFixed(1)}分/日`;
  periodWearDaysEl.textContent = `${wearDays}日 / ${dayCount}日`;
}

async function updatePeriodSummaryOnly() {
  const allRecords = await getAllRecords();
  renderPeriodSummary(allRecords);
}

periodStartInput.addEventListener("change", () => {
  if (periodStartInput.value) state.periodStart = periodStartInput.value;
  updatePeriodSummaryOnly();
});

periodEndInput.addEventListener("change", () => {
  if (periodEndInput.value) state.periodEnd = periodEndInput.value;
  updatePeriodSummaryOnly();
});

/* ==========================================================
   設定画面
   ========================================================== */

const householdCodeInput = document.getElementById("household-code-input");
const householdCodeCopyBtn = document.getElementById("household-code-copy-btn");
const householdCodeSaveBtn = document.getElementById("household-code-save-btn");
const eyeToggleButtons = document.querySelectorAll(".eye-toggle-btn");
const goalInput = document.getElementById("goal-input");
const goalSaveBtn = document.getElementById("goal-save-btn");
const exportBtn = document.getElementById("export-btn");
const importBtn = document.getElementById("import-btn");
const importFile = document.getElementById("import-file");
const backupStatus = document.getElementById("backup-status");

let backupStatusTimer = null;
function flashBackupStatus(message) {
  backupStatus.textContent = message;
  if (backupStatusTimer) clearTimeout(backupStatusTimer);
  backupStatusTimer = setTimeout(() => {
    backupStatus.textContent = " ";
  }, 2200);
}

householdCodeCopyBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(householdCodeInput.value.trim());
    flashBackupStatus("コピーしました");
  } catch (err) {
    flashBackupStatus("コピーできませんでした。手動で選択してコピーしてください");
  }
});

householdCodeSaveBtn.addEventListener("click", async () => {
  const newCode = normalizeHouseholdCode(householdCodeInput.value);
  if (!newCode) {
    flashBackupStatus("共有コードを入力してください");
    return;
  }
  if (newCode === householdCode) {
    flashBackupStatus("同じ共有コードです");
    return;
  }
  const ok = window.confirm(
    "共有コードを切り替えます。これ以降は、この合言葉を共有している人とだけデータを共有します。よろしいですか？"
  );
  if (!ok) return;

  householdCode = saveHouseholdCode(newCode);
  householdCodeInput.value = householdCode;
  await attachListeners();
  await loadDayView(state.currentEditDate);
  flashBackupStatus("共有コードを切り替えました");
});

function updateEyeToggleUI() {
  eyeToggleButtons.forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.eye === state.currentEye);
  });
}

eyeToggleButtons.forEach((btn) => {
  btn.addEventListener("click", async () => {
    state.currentEye = btn.dataset.eye;
    await setSetting("currentEye", state.currentEye);
    updateEyeToggleUI();
    const rec = await getRecord(state.currentEditDate);
    eyeIndicatorEl.textContent = `パッチする目：${eyeLabel(rec.eye || state.currentEye)}`;
    flashBackupStatus("パッチする目を保存しました");
  });
});

goalSaveBtn.addEventListener("click", async () => {
  let value = parseInt(goalInput.value, 10);
  if (isNaN(value) || value < 1) value = DEFAULT_GOAL_MINUTES;
  goalInput.value = value;
  state.dailyGoalMinutes = value;
  await setSetting("dailyGoalMinutes", value);
  const rec = await getRecord(state.currentEditDate);
  updateRing(rec.minutes || 0, !!rec.notDone);
  flashBackupStatus("目標を保存しました");
});

exportBtn.addEventListener("click", async () => {
  const records = await getAllRecords();
  const data = {
    exportedAt: new Date().toISOString(),
    version: 2,
    settings: { dailyGoalMinutes: state.dailyGoalMinutes, currentEye: state.currentEye },
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
      "今の共有コードのデータを、このファイルの内容ですべて置き換えます。よろしいですか？"
    );
    if (!ok) return;

    await clearRecords();
    for (const r of data.records) {
      if (!r || typeof r.date !== "string") continue;
      await putRecord({
        date: r.date,
        slot1Start: typeof r.slot1Start === "string" ? r.slot1Start : null,
        slot1End: typeof r.slot1End === "string" ? r.slot1End : null,
        slot2Start: typeof r.slot2Start === "string" ? r.slot2Start : null,
        slot2End: typeof r.slot2End === "string" ? r.slot2End : null,
        minutes: Number(r.minutes) || 0,
        notDone: !!r.notDone,
        eye: r.eye === "left" ? "left" : r.eye === "right" ? "right" : null,
        memo: typeof r.memo === "string" ? r.memo : "",
        updatedAt: r.updatedAt || new Date().toISOString(),
      });
    }

    if (data.settings && Number(data.settings.dailyGoalMinutes) > 0) {
      state.dailyGoalMinutes = Number(data.settings.dailyGoalMinutes);
      await setSetting("dailyGoalMinutes", state.dailyGoalMinutes);
      goalInput.value = state.dailyGoalMinutes;
    }
    if (data.settings && (data.settings.currentEye === "left" || data.settings.currentEye === "right")) {
      state.currentEye = data.settings.currentEye;
      await setSetting("currentEye", state.currentEye);
      updateEyeToggleUI();
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

function showConfigNotReadyMessage() {
  Object.values(views).forEach((el) => el.classList.remove("active"));
  const dayView = views.day;
  dayView.classList.add("active");
  dayView.innerHTML =
    '<div class="field-block">' +
    "<p>Firebaseの設定がまだ完了していません。</p>" +
    "<p>firebase-config.js に設定情報を貼り付けてから、もう一度開いてください。</p>" +
    "</div>";
}

async function init() {
  if (FIREBASE_NOT_CONFIGURED) {
    showConfigNotReadyMessage();
    return;
  }

  firebase.initializeApp(window.firebaseConfig);
  db = firebase.firestore();
  try {
    await db.enablePersistence({ synchronizeTabs: true });
  } catch (err) {
    /* オフラインキャッシュに対応できない環境でも、オンライン中心で動作は続けられる */
  }
  await firebase.auth().signInAnonymously();

  householdCodeInput.value = householdCode;

  await attachListeners();

  state.dailyGoalMinutes = settingsCache.dailyGoalMinutes;
  state.currentEye = settingsCache.currentEye;
  goalInput.value = state.dailyGoalMinutes;
  updateEyeToggleUI();

  await loadDayView(todayKey());

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => {
      /* オフライン対応ができなくても、アプリ自体は動作する */
    });
  }
}

init();
