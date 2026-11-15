"use strict";

/* ==========================================================
   バージョン情報
   - APP_VERSION        : アプリの版数（画面に表示。更新のたびに上げる）
   - DATA_SCHEMA_VERSION: データ形式の版数（データの形を変えたときだけ上げる）
       1 = 記録・設定のみ（旧バージョン 1.x）
       2 = 診察記録を追加（2.0.0）。既存の記録の形は変えていない
   ========================================================== */

const APP_VERSION = "2.0.1";
const DATA_SCHEMA_VERSION = 2;

const DEFAULT_GOAL_MINUTES = 120;
const DEFAULT_EYE = "right";
const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

const LAST_BACKUP_KEY = "amblyopiaLastBackupAt";
const FIRST_SEEN_KEY = "amblyopiaFirstSeenAt";
const BACKUP_REMINDER_DAYS = 30;

/** 視力プルダウンの選択肢（value が null のものは「未測定」） */
const ACUITY_OPTIONS = (() => {
  const list = [
    { value: null, label: "未測定" },
    { value: 0.05, label: "0.1未満" },
  ];
  for (let i = 1; i <= 10; i++) list.push({ value: i / 10, label: (i / 10).toFixed(1) });
  list.push({ value: 1.2, label: "1.2" });
  list.push({ value: 1.5, label: "1.5" });
  list.push({ value: 2.0, label: "2.0" });
  return list;
})();

function acuityLabel(value) {
  if (value === null || value === undefined) return "未測定";
  const found = ACUITY_OPTIONS.find((o) => o.value === value);
  return found ? found.label : String(value);
}

function lsGet(key) {
  try {
    return localStorage.getItem(key);
  } catch (e) {
    return null;
  }
}

function lsSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch (e) {
    /* 保存できなくてもアプリは動く */
  }
}

function escapeHtml(text) {
  return String(text == null ? "" : text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

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
  let code = lsGet(HOUSEHOLD_CODE_STORAGE_KEY);
  if (!code) {
    code = generateHouseholdCode();
    lsSet(HOUSEHOLD_CODE_STORAGE_KEY, code);
  }
  return code;
}

function saveHouseholdCode(code) {
  const normalized = normalizeHouseholdCode(code);
  lsSet(HOUSEHOLD_CODE_STORAGE_KEY, normalized);
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

function examsCol() {
  return householdDoc().collection("exams");
}

function settingsDocRef() {
  return householdDoc().collection("settings").doc("app");
}

/** データ形式のバージョンを書いておく場所（旧バージョンのアプリは読まないので影響しない） */
function metaDocRef() {
  return householdDoc().collection("settings").doc("meta");
}

const recordsCache = new Map();
const examsCache = new Map();
const settingsCache = { dailyGoalMinutes: DEFAULT_GOAL_MINUTES, currentEye: DEFAULT_EYE, childName: "" };
let metaCache = {};

let unsubscribeRecords = null;
let unsubscribeSettings = null;
let unsubscribeExams = null;
let unsubscribeMeta = null;

/** データがこのアプリより新しい形式のときは true。誤って壊さないよう書き込みを止める */
let readOnlyMode = false;
let readOnlyAlerted = false;

function guardWrite() {
  if (!readOnlyMode) return true;
  if (!readOnlyAlerted) {
    readOnlyAlerted = true;
    window.alert(
      "この端末のアプリが古いため、データを守るために保存を止めています。\nアプリを閉じて開き直すか、ページを再読み込みして新しい版にしてください。"
    );
  }
  return false;
}

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

/** 記録・診察記録・設定・バージョン情報のリアルタイム購読を開始し、最初のデータが届くまで待つ */
function attachListeners() {
  if (unsubscribeRecords) unsubscribeRecords();
  if (unsubscribeSettings) unsubscribeSettings();
  if (unsubscribeExams) unsubscribeExams();
  if (unsubscribeMeta) unsubscribeMeta();
  recordsCache.clear();
  examsCache.clear();

  return new Promise((resolve) => {
    const pending = new Set(["records", "settings", "exams", "meta"]);
    const done = (name) => {
      if (pending.delete(name) && pending.size === 0) resolve();
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
        done("records");
        onRemoteDataChanged();
      },
      () => {
        setSyncStatus(false);
        done("records");
      }
    );

    unsubscribeExams = examsCol().onSnapshot(
      (snapshot) => {
        snapshot.docChanges().forEach((change) => {
          if (change.type === "removed") {
            examsCache.delete(change.doc.id);
          } else {
            examsCache.set(change.doc.id, Object.assign({}, change.doc.data(), { id: change.doc.id }));
          }
        });
        done("exams");
        onRemoteDataChanged();
      },
      () => done("exams")
    );

    unsubscribeSettings = settingsDocRef().onSnapshot(
      (snap) => {
        const data = snap.data() || {};
        if (typeof data.dailyGoalMinutes === "number") settingsCache.dailyGoalMinutes = data.dailyGoalMinutes;
        if (data.currentEye === "left" || data.currentEye === "right") settingsCache.currentEye = data.currentEye;
        if (typeof data.childName === "string") settingsCache.childName = data.childName;
        state.dailyGoalMinutes = settingsCache.dailyGoalMinutes;
        state.currentEye = settingsCache.currentEye;
        goalInput.value = state.dailyGoalMinutes;
        if (document.activeElement !== childNameInput) childNameInput.value = settingsCache.childName;
        updateEyeToggleUI();
        done("settings");
        onRemoteDataChanged();
      },
      () => done("settings")
    );

    unsubscribeMeta = metaDocRef().onSnapshot(
      (snap) => {
        metaCache = snap.data() || {};
        const dataVersion = typeof metaCache.schemaVersion === "number" ? metaCache.schemaVersion : 1;
        readOnlyMode = dataVersion > DATA_SCHEMA_VERSION;
        updateReadOnlyBanner();
        done("meta");
      },
      () => done("meta")
    );
  });
}

/** 今開いている画面を、最新のデータで描き直す */
function onRemoteDataChanged() {
  const activeBtn = document.querySelector(".nav-btn.active");
  const activeView = activeBtn ? activeBtn.dataset.view : null;
  if (activeView === "day") {
    refreshDayViewFromCache();
  } else if (activeView && viewRenderers[activeView]) {
    viewRenderers[activeView]();
  } else if (document.body.classList.contains("report-open") && viewRenderers.report) {
    viewRenderers.report();
  }
}

async function refreshDayViewFromCache() {
  const record = await getRecord(state.currentEditDate);
  if (document.activeElement !== memoInput) {
    memoInput.value = record.memo || "";
  }
  applyRecordToUI(record);
}

/** 旧バージョンのデータでも新バージョンでも、データ形式の目印を最新にしておく（下げることはしない） */
async function ensureSchemaMarker() {
  if (readOnlyMode || !db) return;
  const current = typeof metaCache.schemaVersion === "number" ? metaCache.schemaVersion : 1;
  if (current >= DATA_SCHEMA_VERSION) return;
  try {
    await metaDocRef().set(
      {
        schemaVersion: DATA_SCHEMA_VERSION,
        upgradedByAppVersion: APP_VERSION,
        upgradedAt: new Date().toISOString(),
      },
      { merge: true }
    );
  } catch (err) {
    /* オフラインなどで書けなくても、次の起動時にもう一度試す */
  }
}

/* ---- データ読み書き（キャッシュ経由。onSnapshot が裏で同期を保つ） ---- */

async function getRecord(date) {
  return recordsCache.get(date) || emptyRecord(date);
}

async function putRecord(record) {
  if (!guardWrite()) return;
  await recordsCol().doc(record.date).set(record);
}

async function getAllRecords() {
  return [...recordsCache.values()];
}

function getAllExams() {
  return [...examsCache.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

async function getSetting(key, defaultValue) {
  return key in settingsCache ? settingsCache[key] : defaultValue;
}

async function setSetting(key, value) {
  if (!guardWrite()) return;
  settingsCache[key] = value;
  await settingsDocRef().set({ [key]: value }, { merge: true });
}

/**
 * 指定した日付の記録に、渡した項目だけを上書き保存する。
 * （一部の項目だけ更新しても、他の項目を消さないため）
 */
async function saveRecordPatch(date, patch) {
  if (!guardWrite()) return recordsCache.get(date) || emptyRecord(date);
  const fullPatch = Object.assign({}, patch, { date, updatedAt: new Date().toISOString() });
  await recordsCol().doc(date).set(fullPatch, { merge: true });
  const current = recordsCache.get(date) || emptyRecord(date);
  const updated = Object.assign({}, current, fullPatch);
  recordsCache.set(date, updated);
  return updated;
}

/**
 * コレクションの中身を「渡した内容」にそろえる。
 * 先に新しい内容を書き込み、そのあとで余分なものを消す（途中で失敗しても、元のデータが空になりにくい順番）
 * items: [{ id, data }]
 */
async function replaceAllDocs(colRef, items) {
  const chunkSize = 450;
  const keep = new Set(items.map((it) => it.id));
  for (let i = 0; i < items.length; i += chunkSize) {
    const batch = db.batch();
    items.slice(i, i + chunkSize).forEach((it) => batch.set(colRef.doc(it.id), it.data));
    await batch.commit();
  }
  const snap = await colRef.get();
  const stale = snap.docs.filter((d) => !keep.has(d.id));
  for (let i = 0; i < stale.length; i += chunkSize) {
    const batch = db.batch();
    stale.slice(i, i + chunkSize).forEach((d) => batch.delete(d.ref));
    await batch.commit();
  }
}

/* ---- 読み込み時の整形（変なデータが混ざっても落ちないように） ---- */

function sanitizeRecord(r) {
  return {
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
  };
}

function sanitizeAcuity(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!isFinite(n) || n <= 0 || n > 2.5) return null;
  return Math.round(n * 100) / 100;
}

const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function sanitizeExam(e) {
  return {
    date: e.date,
    nextVisitDate: typeof e.nextVisitDate === "string" && DATE_KEY_PATTERN.test(e.nextVisitDate) ? e.nextVisitDate : null,
    rightNaked: sanitizeAcuity(e.rightNaked),
    rightGlasses: sanitizeAcuity(e.rightGlasses),
    leftNaked: sanitizeAcuity(e.leftNaked),
    leftGlasses: sanitizeAcuity(e.leftGlasses),
    comment: typeof e.comment === "string" ? e.comment : "",
    updatedAt: e.updatedAt || new Date().toISOString(),
  };
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

function addDays(key, n) {
  const d = keyToDate(key);
  d.setDate(d.getDate() + n);
  return dateToKey(d);
}

/** b - a の日数（keyどうし） */
function diffDays(a, b) {
  return Math.round((keyToDate(b) - keyToDate(a)) / 86400000);
}

function formatDateLabel(d) {
  return `${d.getMonth() + 1}月${d.getDate()}日（${WEEKDAYS[d.getDay()]}）`;
}

function formatDateJa(key) {
  const d = keyToDate(key);
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日（${WEEKDAYS[d.getDay()]}）`;
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
   お知らせバナー（同期状態・更新・バックアップ・読み取り専用）
   ========================================================== */

const syncBadgeEl = document.getElementById("sync-badge");
const updateBannerEl = document.getElementById("update-banner");
const readOnlyBannerEl = document.getElementById("readonly-banner");
const backupReminderEl = document.getElementById("backup-reminder");

function setSyncStatus(online) {
  if (!syncBadgeEl) return;
  syncBadgeEl.textContent = online
    ? "オンラインで同期中"
    : "オフライン（この端末に保存し、再接続時に同期します）";
  syncBadgeEl.classList.toggle("sync-offline", !online);
}

function updateReadOnlyBanner() {
  if (readOnlyBannerEl) readOnlyBannerEl.classList.toggle("hidden", !readOnlyMode);
}

function showUpdateBanner() {
  if (updateBannerEl) updateBannerEl.classList.remove("hidden");
}

function daysSinceLastBackup() {
  const base = lsGet(LAST_BACKUP_KEY) || lsGet(FIRST_SEEN_KEY);
  if (!base) return 0;
  const t = new Date(base).getTime();
  if (isNaN(t)) return 0;
  return Math.floor((Date.now() - t) / 86400000);
}

function updateBackupReminder() {
  if (!backupReminderEl) return;
  backupReminderEl.classList.toggle("hidden", daysSinceLastBackup() < BACKUP_REMINDER_DAYS);
}

if (updateBannerEl) {
  updateBannerEl.addEventListener("click", () => window.location.reload());
}

/* ==========================================================
   画面切り替え（タブ）
   ========================================================== */

const views = {
  day: document.getElementById("view-day"),
  calendar: document.getElementById("view-calendar"),
  analysis: document.getElementById("view-analysis"),
  exams: document.getElementById("view-exams"),
  settings: document.getElementById("view-settings"),
  report: document.getElementById("view-report"),
};

/** 画面ごとの描き直し処理。exams.js / analysis.js が登録する */
const viewRenderers = {};

function showView(name) {
  Object.entries(views).forEach(([key, el]) => {
    el.classList.toggle("active", key === name);
  });
  document.querySelectorAll(".nav-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.view === name);
  });
  document.body.classList.toggle("report-open", name === "report");
  if (viewRenderers[name]) viewRenderers[name]();
  window.scrollTo(0, 0);
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
  applyRecordToUI(updated);
  if (!readOnlyMode) flashStatus("保存しました");
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
  if (!readOnlyMode) flashStatus(nextNotDone ? "「未実施」として保存しました" : "記録の入力に戻りました");
});

memoInput.addEventListener("blur", async () => {
  await saveRecordPatch(state.currentEditDate, { memo: memoInput.value });
  if (!readOnlyMode) flashStatus("保存しました");
});

backToTodayBtn.addEventListener("click", () => {
  loadDayView(todayKey());
});

/* ==========================================================
   集計期間（カレンダー画面と分析画面で共通）
   ========================================================== */

/** 開始日・終了日を並べ替えて返す */
function periodRange() {
  const start = state.periodStart <= state.periodEnd ? state.periodStart : state.periodEnd;
  const end = state.periodStart <= state.periodEnd ? state.periodEnd : state.periodStart;
  return { start, end };
}

/**
 * 集計に使う期間。終了日が未来のときは「今日まで」で数える
 * （まだ来ていない日を「記録なし」として平均に含めないため）
 */
function effectivePeriod() {
  const { start, end } = periodRange();
  const today = todayKey();
  const effEnd = end > today ? today : end;
  const dayCount = effEnd < start ? 0 : diffDays(start, effEnd) + 1;
  return { start, end, effEnd, dayCount, capped: end > today };
}

function syncPeriodInputs() {
  document.querySelectorAll(".js-period-start").forEach((el) => {
    el.value = state.periodStart;
  });
  document.querySelectorAll(".js-period-end").forEach((el) => {
    el.value = state.periodEnd;
  });
}

function latestExamOnOrBefore(key) {
  const list = getAllExams().filter((e) => e.date <= key);
  return list.length ? list[list.length - 1] : null;
}

function renderPeriodPresets() {
  const containers = document.querySelectorAll(".period-presets");
  if (!containers.length) return;

  const today = todayKey();
  const now = new Date();
  const month = monthRange(now.getFullYear(), now.getMonth());
  const presets = [
    { label: "今月", start: month.start, end: month.end },
    { label: "直近30日", start: addDays(today, -29), end: today },
  ];
  const lastExam = latestExamOnOrBefore(today);
  if (lastExam) {
    presets.push({ label: "前回の診察日〜今日", start: lastExam.date, end: today });
    if (lastExam.nextVisitDate && lastExam.nextVisitDate >= lastExam.date) {
      presets.push({ label: "前回の診察日〜次回の診察予定日", start: lastExam.date, end: lastExam.nextVisitDate });
    }
  }
  const dates = [...recordsCache.keys()].sort();
  if (dates.length) presets.push({ label: "全期間", start: dates[0], end: today });

  containers.forEach((container) => {
    container.innerHTML = "";
    presets.forEach((p) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "preset-btn";
      btn.textContent = p.label;
      btn.addEventListener("click", () => {
        state.periodStart = p.start;
        state.periodEnd = p.end;
        syncPeriodInputs();
        rerenderPeriodViews();
      });
      container.appendChild(btn);
    });
  });
}

function rerenderPeriodViews() {
  if (views.calendar.classList.contains("active")) renderCalendar();
  if (views.analysis.classList.contains("active") && viewRenderers.analysis) viewRenderers.analysis();
}

document.querySelectorAll(".js-period-start").forEach((el) => {
  el.addEventListener("change", () => {
    if (el.value) state.periodStart = el.value;
    syncPeriodInputs();
    rerenderPeriodViews();
  });
});

document.querySelectorAll(".js-period-end").forEach((el) => {
  el.addEventListener("change", () => {
    if (el.value) state.periodEnd = el.value;
    syncPeriodInputs();
    rerenderPeriodViews();
  });
});

/* ==========================================================
   カレンダー画面
   ========================================================== */

const calTitle = document.getElementById("cal-title");
const calGrid = document.getElementById("calendar-grid");
const periodTotalEl = document.getElementById("period-total");
const periodAverageEl = document.getElementById("period-average");
const periodWearDaysEl = document.getElementById("period-wear-days");
const periodNoteEl = document.getElementById("period-note");
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
  const examDates = new Set(getAllExams().map((e) => e.date));

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

      if (examDates.has(key)) {
        const examEl = document.createElement("span");
        examEl.className = "cal-exam";
        examEl.textContent = "診";
        cell.appendChild(examEl);
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

  syncPeriodInputs();
  renderPeriodPresets();
  renderPeriodSummary(allRecords);
}

function renderPeriodSummary(recordsList) {
  const p = effectivePeriod();
  const recordsInRange = recordsList.filter((r) => r.date >= p.start && r.date <= p.effEnd);

  const total = recordsInRange.reduce((sum, r) => sum + (r.minutes || 0), 0);
  const average = p.dayCount > 0 ? total / p.dayCount : 0;
  const wearDays = recordsInRange.filter((r) => !r.notDone && (r.minutes || 0) > 0).length;

  periodTotalEl.textContent = `${total}分`;
  periodAverageEl.textContent = `${average.toFixed(1)}分/日`;
  periodWearDaysEl.textContent = `${wearDays}日 / ${p.dayCount}日`;
  periodNoteEl.textContent = p.capped
    ? `終了日が今日より先なので、今日までの${p.dayCount}日間で計算しています。`
    : "";
}

viewRenderers.calendar = renderCalendar;

/* ==========================================================
   CSV・バックアップ（ファイルの書き出し／読み込み）
   ========================================================== */

function downloadText(filename, text, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** CSVの1マスぶんの文字列にする（カンマ・改行・引用符の処理、Excelでの式の誤動作防止） */
function csvEscape(value) {
  let s = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function downloadCsv(filename, rows) {
  const text = "﻿" + rows.map((r) => r.map(csvEscape).join(",")).join("\r\n") + "\r\n";
  downloadText(filename, text, "text/csv;charset=utf-8");
}

/** 開始日〜終了日の記録を、1日1行（記録がない日も含む）の表にする */
function buildRecordsCsvRows(startKey, endKey) {
  const rows = [
    ["日付", "曜日", "状態", "目標達成", "パッチする目", "開始1", "終了1", "開始2", "終了2", "装着時間（分）", "装着時間（時間）", "メモ"],
  ];
  const goal = state.dailyGoalMinutes;
  const n = diffDays(startKey, endKey) + 1;
  for (let i = 0; i < n; i++) {
    const key = addDays(startKey, i);
    const r = recordsCache.get(key);
    let status = "記録なし";
    let achieved = "";
    let minutes = "";
    let hours = "";
    if (r) {
      if (r.notDone) {
        status = "未実施";
      } else {
        minutes = r.minutes || 0;
        hours = Math.round((minutes / 60) * 100) / 100;
        status = minutes > 0 ? "装着" : "装着なし（0分）";
        achieved = minutes >= goal ? "達成" : "未達";
      }
    }
    rows.push([
      key,
      WEEKDAYS[keyToDate(key).getDay()],
      status,
      achieved,
      r && r.eye ? eyeLabel(r.eye) : "",
      r ? r.slot1Start || "" : "",
      r ? r.slot1End || "" : "",
      r ? r.slot2Start || "" : "",
      r ? r.slot2End || "" : "",
      minutes,
      hours,
      r ? r.memo || "" : "",
    ]);
  }
  return rows;
}

function buildExamsCsvRows() {
  const rows = [
    ["診察日", "右目 裸眼", "右目 眼鏡あり", "左目 裸眼", "左目 眼鏡あり", "次回診察予定日", "コメント"],
  ];
  getAllExams().forEach((e) => {
    const cell = (v) => (v === null || v === undefined ? "" : acuityLabel(v));
    rows.push([
      e.date,
      cell(e.rightNaked),
      cell(e.rightGlasses),
      cell(e.leftNaked),
      cell(e.leftGlasses),
      e.nextVisitDate || "",
      e.comment || "",
    ]);
  });
  return rows;
}

function exportPeriodCsv() {
  const p = effectivePeriod();
  if (p.dayCount <= 0) {
    flashBackupStatus("期間に今日までの日がありません。期間を確認してください");
    return false;
  }
  downloadCsv(`アイパッチ記録_${p.start}_${p.effEnd}.csv`, buildRecordsCsvRows(p.start, p.effEnd));
  return true;
}

function exportAllRecordsCsv() {
  const dates = [...recordsCache.keys()].sort();
  if (!dates.length) {
    flashBackupStatus("まだ記録がありません");
    return;
  }
  const end = dates[dates.length - 1] > todayKey() ? dates[dates.length - 1] : todayKey();
  downloadCsv(`アイパッチ記録_全期間_${todayKey()}.csv`, buildRecordsCsvRows(dates[0], end));
  flashBackupStatus("CSVを書き出しました");
}

function buildBackupObject() {
  return {
    exportedAt: new Date().toISOString(),
    version: 3,
    appVersion: APP_VERSION,
    schemaVersion: DATA_SCHEMA_VERSION,
    settings: {
      dailyGoalMinutes: state.dailyGoalMinutes,
      currentEye: state.currentEye,
      childName: settingsCache.childName || "",
    },
    records: [...recordsCache.values()].sort((a, b) => (a.date < b.date ? -1 : 1)),
    exams: getAllExams(),
  };
}

function downloadBackupJson(label) {
  const data = buildBackupObject();
  downloadText(
    `${label}_${todayKey()}.json`,
    JSON.stringify(data, null, 2),
    "application/json"
  );
}

/* ==========================================================
   設定画面
   ========================================================== */

const householdCodeInput = document.getElementById("household-code-input");
const householdCodeCopyBtn = document.getElementById("household-code-copy-btn");
const householdCodeSaveBtn = document.getElementById("household-code-save-btn");
const eyeToggleButtons = document.querySelectorAll(".eye-toggle-btn");
const goalInput = document.getElementById("goal-input");
const goalSaveBtn = document.getElementById("goal-save-btn");
const childNameInput = document.getElementById("child-name-input");
const childNameSaveBtn = document.getElementById("child-name-save-btn");
const exportBtn = document.getElementById("export-btn");
const importBtn = document.getElementById("import-btn");
const importFile = document.getElementById("import-file");
const backupStatus = document.getElementById("backup-status");
const csvAllBtn = document.getElementById("csv-all-btn");
const csvExamsBtn = document.getElementById("csv-exams-btn");
const appVersionText = document.getElementById("app-version-text");
const dataStatusText = document.getElementById("data-status-text");
const lastBackupText = document.getElementById("last-backup-text");

let backupStatusTimer = null;
function flashBackupStatus(message) {
  backupStatus.textContent = message;
  if (backupStatusTimer) clearTimeout(backupStatusTimer);
  backupStatusTimer = setTimeout(() => {
    backupStatus.textContent = " ";
  }, 2600);
}

function renderSettingsInfo() {
  appVersionText.textContent = `アプリのバージョン：${APP_VERSION}（データ形式 ${DATA_SCHEMA_VERSION}）`;
  const dataVersion = typeof metaCache.schemaVersion === "number" ? metaCache.schemaVersion : 1;
  dataStatusText.textContent = readOnlyMode
    ? `データの状態：このアプリより新しい形式です（形式 ${dataVersion}）。壊さないよう保存を止めています`
    : "データの状態：正常";
  const last = lsGet(LAST_BACKUP_KEY);
  lastBackupText.textContent = last
    ? `この端末での前回のバックアップ：${dateToKey(new Date(last))}`
    : "この端末ではまだバックアップを書き出していません";
}

viewRenderers.settings = renderSettingsInfo;

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
  await ensureSchemaMarker();
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

childNameSaveBtn.addEventListener("click", async () => {
  const name = childNameInput.value.trim().slice(0, 30);
  childNameInput.value = name;
  await setSetting("childName", name);
  flashBackupStatus(name ? "お名前を保存しました" : "お名前を空にしました");
});

csvAllBtn.addEventListener("click", exportAllRecordsCsv);

csvExamsBtn.addEventListener("click", () => {
  if (!examsCache.size) {
    flashBackupStatus("まだ診察記録がありません");
    return;
  }
  downloadCsv(`診察記録_${todayKey()}.csv`, buildExamsCsvRows());
  flashBackupStatus("CSVを書き出しました");
});

const periodCsvBtn = document.getElementById("period-csv-btn");
if (periodCsvBtn) {
  periodCsvBtn.addEventListener("click", () => {
    if (exportPeriodCsv()) periodCsvBtn.textContent = "書き出しました（もう一度押すと再度書き出し）";
  });
}

exportBtn.addEventListener("click", () => {
  downloadBackupJson("弱視トレーニング記録");
  lsSet(LAST_BACKUP_KEY, new Date().toISOString());
  updateBackupReminder();
  renderSettingsInfo();
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
    if (typeof data.schemaVersion === "number" && data.schemaVersion > DATA_SCHEMA_VERSION) {
      flashBackupStatus("このファイルは、より新しい版のアプリで作られています。アプリを更新してください");
      return;
    }
    if (!guardWrite()) return;

    const records = data.records.filter((r) => r && typeof r.date === "string" && DATE_KEY_PATTERN.test(r.date));
    const hasExams = Array.isArray(data.exams);
    const exams = hasExams
      ? data.exams.filter((e) => e && typeof e.date === "string" && DATE_KEY_PATTERN.test(e.date))
      : [];

    const ok = window.confirm(
      `今の共有コードのデータを、このファイルの内容で置き換えます。\n` +
        `・記録 ${records.length}件（今ある記録はすべて置き換え）\n` +
        (hasExams
          ? `・診察記録 ${exams.length}件（今ある診察記録はすべて置き換え）\n`
          : `・診察記録：このファイルには含まれていないため、今のまま残します\n`) +
        `\n置き換える前に、今のデータを自動でファイルに書き出します。よろしいですか？`
    );
    if (!ok) return;

    downloadBackupJson("取り込み前の自動バックアップ");

    await replaceAllDocs(
      recordsCol(),
      records.map((r) => ({ id: r.date, data: sanitizeRecord(r) }))
    );

    if (hasExams) {
      await replaceAllDocs(
        examsCol(),
        exams.map((e) => ({
          id: typeof e.id === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(e.id) ? e.id : examsCol().doc().id,
          data: sanitizeExam(e),
        }))
      );
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
    if (data.settings && typeof data.settings.childName === "string") {
      await setSetting("childName", data.settings.childName.slice(0, 30));
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

function setupServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    // すでにアプリを開いている状態で新しい版が入ったときだけお知らせする
    if (hadController) showUpdateBanner();
  });
  navigator.serviceWorker.register("./sw.js").catch(() => {
    /* オフライン対応ができなくても、アプリ自体は動作する */
  });
}

async function init() {
  if (FIREBASE_NOT_CONFIGURED) {
    showConfigNotReadyMessage();
    return;
  }

  if (!lsGet(FIRST_SEEN_KEY)) lsSet(FIRST_SEEN_KEY, new Date().toISOString());
  updateBackupReminder();

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
  await ensureSchemaMarker();

  state.dailyGoalMinutes = settingsCache.dailyGoalMinutes;
  state.currentEye = settingsCache.currentEye;
  goalInput.value = state.dailyGoalMinutes;
  childNameInput.value = settingsCache.childName;
  updateEyeToggleUI();
  renderSettingsInfo();

  await loadDayView(todayKey());

  setupServiceWorker();
}

document.addEventListener("DOMContentLoaded", init);
