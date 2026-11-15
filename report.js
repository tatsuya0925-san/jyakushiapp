"use strict";

/* ==========================================================
   医師に見せる用紙（A4横・白地・インク控えめ）
   1ページ目は、今お使いの紙の「アイパッチ日記」と同じ形
   （日〜土の週ごとの表＋右側に目・時間・合計の枠）。
   画面で確認してから「印刷／PDFに保存」を押す。
   ========================================================== */

const reportSheetEl = document.getElementById("report-sheet");
const reportBackBtn = document.getElementById("report-back-btn");
const reportPrintBtn = document.getElementById("report-print-btn");

const REPORT_PAGE_WIDTH_PX = 1009; // 用紙の内側の幅 267mm（A4横 297mm − 左右の余白15mm×2）を画面上のピクセルに換算した値
const DIARY_WEEKS_PER_PAGE = 12;
const REPORT_ROWS_PER_BLOCK = 30;
const REPORT_BLOCKS_PER_PAGE = 3;

const REPORT_OPTIONS_KEY = "amblyopiaReportOptions";
const reportOptionEls = {
  charts: document.getElementById("rp-opt-charts"),
  exams: document.getElementById("rp-opt-exams"),
  details: document.getElementById("rp-opt-details"),
};

function loadReportOptions() {
  let saved = {};
  try {
    saved = JSON.parse(lsGet(REPORT_OPTIONS_KEY) || "{}") || {};
  } catch (e) {
    saved = {};
  }
  reportOptionEls.charts.checked = saved.charts !== false;
  reportOptionEls.exams.checked = saved.exams !== false;
  reportOptionEls.details.checked = saved.details === true;
}

function readReportOptions() {
  return {
    charts: reportOptionEls.charts.checked,
    exams: reportOptionEls.exams.checked,
    details: reportOptionEls.details.checked,
  };
}

/* ---------- 1ページ目：アイパッチ日記（紙と同じ形） ---------- */

/** 期間を、日曜はじまりの週ごとの行に分ける（期間の外の日は null） */
function diaryWeeks(a) {
  const startDow = keyToDate(a.p.start).getDay();
  const endDow = keyToDate(a.p.effEnd).getDay();
  const gridStart = addDays(a.p.start, -startDow);
  const gridEnd = addDays(a.p.effEnd, 6 - endDow);
  const byKey = new Map(a.days.map((d) => [d.key, d]));
  const weeks = [];
  const total = diffDays(gridStart, gridEnd) + 1;
  for (let i = 0; i < total; i += 7) {
    const row = [];
    for (let k = 0; k < 7; k++) {
      const key = addDays(gridStart, i + k);
      row.push(byKey.get(key) || null);
    }
    weeks.push(row);
  }
  return weeks;
}

function diaryCellHtml(d) {
  if (!d) return '<td class="dp-out"></td>';
  const dt = keyToDate(d.key);
  let value = "";
  if (d.status === "notDone") value = "未";
  else if (d.minutes > 0) value = formatHoursLabel(d.minutes);
  return (
    `<td><div class="dp-d">${dt.getMonth() + 1}/${dt.getDate()}</div>` +
    `<div class="dp-h${d.status === "notDone" ? " dp-h-not" : ""}">${value}</div></td>`
  );
}

function diaryGridHtml(weeks) {
  return (
    '<table class="dp-grid"><thead><tr>' +
    WEEKDAYS.map((w) => `<th>${w}</th>`).join("") +
    "</tr></thead><tbody>" +
    weeks.map((row) => `<tr>${row.map(diaryCellHtml).join("")}</tr>`).join("") +
    "</tbody></table>"
  );
}

function hoursText(minutes) {
  // 例：1.5時間（15分きざみ）
  return `${formatHoursLabel(minutes)}時間`;
}

function diarySidebarHtml(a) {
  const name = settingsCache.childName ? escapeHtml(settingsCache.childName) : "";
  const eyes = new Set();
  a.days.forEach((d) => {
    if (d.record && d.record.eye && d.status !== "none") eyes.add(d.record.eye);
  });
  if (!eyes.size) eyes.add(state.currentEye);
  const eyeMark = (eye, label) => `<span class="dp-eye${eyes.has(eye) ? " dp-eye-on" : ""}">${label}</span>`;
  const periodText = `${formatDateJa(a.p.start)}<br>〜 ${formatDateJa(a.p.effEnd)}（${a.days.length}日間）`;
  return (
    '<div class="dp-side">' +
    `<div class="dp-line"><span class="dp-label">お名前</span><span class="dp-fill">${name}</span></div>` +
    `<div class="dp-line dp-period"><span class="dp-label">集計期間</span><span class="dp-text">${periodText}</span></div>` +
    `<div class="dp-line"><span class="dp-label">アイパッチをする目</span>${eyeMark("right", "右")}<span>・</span>${eyeMark("left", "左")}</div>` +
    `<div class="dp-line"><span class="dp-label">アイパッチをする時間</span><span>1日 <b>${escapeHtml(hoursText(a.goal))}</b></span></div>` +
    '<p class="dp-note">マスの上の日付の下の数字は、その日にアイパッチをした時間です（1時間＝1、0.25きざみ）。「未」はアイパッチ未実施、空らんは記録なしです。</p>' +
    '<table class="dp-total"><tbody>' +
    `<tr><th>合計時間</th><td>${escapeHtml(formatDuration(a.total))}</td></tr>` +
    `<tr><th>合計日数<small>（装着した日）</small></th><td>${a.wearDays}日</td></tr>` +
    `<tr><th>平均時間<small>（装着した日あたり）</small></th><td>${a.wearDays ? escapeHtml(formatDuration(a.avgWear)) : "－"}</td></tr>` +
    `<tr><th>平均時間<small>（期間全体で1日あたり）</small></th><td>${escapeHtml(formatDuration(a.avgAll))}</td></tr>` +
    `<tr><th>目標を達成した日<small>（${a.goal}分以上）</small></th><td>${a.achievedDays}日</td></tr>` +
    "</tbody></table>" +
    "</div>"
  );
}

function diaryPagesHtml(a) {
  const weeks = diaryWeeks(a);
  const pages = [];
  for (let i = 0; i < weeks.length; i += DIARY_WEEKS_PER_PAGE) {
    const first = i === 0;
    const grid = diaryGridHtml(weeks.slice(i, i + DIARY_WEEKS_PER_PAGE));
    pages.push(
      '<div class="report-page dp-page">' +
        `<div class="dp-main"><h1 class="dp-title">${first ? "アイパッチ日記" : "アイパッチ日記（つづき）"}</h1>${grid}</div>` +
        (first ? diarySidebarHtml(a) : "") +
        "</div>"
    );
  }
  return pages;
}

/* ---------- 診察記録・グラフ・詳細のページ ---------- */

function reportSlotText(start, end) {
  return start && end ? `${start}-${end}` : "";
}

function reportDayRowHtml(d) {
  const dt = keyToDate(d.key);
  const dateText = `${dt.getMonth() + 1}/${dt.getDate()}(${WEEKDAYS[dt.getDay()]})`;
  let times = "";
  let minutes = "";
  let mark = "";
  if (d.record) {
    if (d.status === "notDone") {
      times = "アイパッチ未実施";
      mark = "未";
    } else {
      times = [reportSlotText(d.record.slot1Start, d.record.slot1End), reportSlotText(d.record.slot2Start, d.record.slot2End)]
        .filter(Boolean)
        .join(" / ");
      minutes = String(d.minutes);
      mark = d.status === "achieved" ? "◎" : d.status === "partial" ? "△" : "";
    }
  }
  const memo = d.record && d.record.memo ? escapeHtml(d.record.memo.replace(/\s+/g, " ").slice(0, 24)) : "";
  return `<tr><td class="rp-date">${dateText}</td><td class="rp-times">${escapeHtml(times)}</td><td class="rp-min">${minutes}</td><td class="rp-mark">${mark}</td><td class="rp-memo">${memo}</td></tr>`;
}

function reportDayTableHtml(days) {
  return (
    '<table class="rp-table rp-days"><thead><tr><th>日付</th><th>装着時間帯</th><th>合計(分)</th><th>判定</th><th>メモ</th></tr></thead><tbody>' +
    days.map(reportDayRowHtml).join("") +
    "</tbody></table>"
  );
}

function reportChartHtml(title, svg, note) {
  return (
    `<div class="rp-chart"><div class="rp-chart-title">${escapeHtml(title)}</div>${svg}` +
    (note ? `<div class="rp-chart-note">${escapeHtml(note)}</div>` : "") +
    "</div>"
  );
}

function reportExamTableHtml(exams) {
  if (!exams.length) return '<p class="rp-empty">診察記録はまだありません。</p>';
  const cell = (v) => (v === null || v === undefined ? "未測定" : acuityLabel(v));
  return (
    '<table class="rp-table rp-exams"><thead><tr><th>診察日</th><th>右目 裸眼</th><th>右目 眼鏡あり</th><th>左目 裸眼</th><th>左目 眼鏡あり</th><th>コメント</th><th>次回予定</th></tr></thead><tbody>' +
    exams
      .map(
        (e) =>
          `<tr><td>${escapeHtml(formatDateJa(e.date))}</td><td>${cell(e.rightNaked)}</td><td>${cell(e.rightGlasses)}</td>` +
          `<td>${cell(e.leftNaked)}</td><td>${cell(e.leftGlasses)}</td>` +
          `<td class="rp-comment">${escapeHtml(e.comment || "").replace(/\n/g, "<br>")}</td>` +
          `<td>${e.nextVisitDate ? escapeHtml(formatDateJa(e.nextVisitDate)) : ""}</td></tr>`
      )
      .join("") +
    "</tbody></table>"
  );
}

function chartPageHtml(a) {
  const comments = buildComments(a);
  const charts =
    reportChartHtml("日ごとの装着時間", svgDailyChart(a), "棒＝1日の装着時間（濃い＝目標達成）／細線＝直近7日の平均／点線＝目標／診＝診察日") +
    reportChartHtml("曜日ごとの平均装着時間", weekdayChartSvg(a), "") +
    reportChartHtml("装着時間の分布", histogramChartSvg(a), "横軸＝装着時間（分）。各柱は『その数字以上〜次の数字未満』の日数");
  return (
    '<div class="report-page">' +
    '<div class="rp-subhead">装着時間の分析</div>' +
    `<div class="rp-charts rp-charts-2">${charts}` +
    '<div class="rp-chart"><div class="rp-chart-title">かんたんコメント</div><ul class="rp-comments">' +
    comments.map((c) => `<li>${escapeHtml(c)}</li>`).join("") +
    "</ul></div></div></div>"
  );
}

function examPageHtml(a, showMonths) {
  const exams = getAllExams();
  const shownExams = exams.slice(-8);
  let monthCharts = "";
  if (showMonths && a.months.length >= 2) {
    monthCharts =
      reportChartHtml("月ごとの合計装着時間", monthTotalChartSvg(a), "") +
      reportChartHtml("月ごとの平均装着時間（1日あたり）", monthAvgChartSvg(a), "");
  }
  const acuity = shownExams.length
    ? reportChartHtml("視力の推移", svgAcuityChart(shownExams), "白抜きの印＝未測定（前回の値を引き継ぎ）")
    : "";
  return (
    '<div class="report-page">' +
    '<div class="rp-subhead">診察記録</div>' +
    reportExamTableHtml(shownExams) +
    `<div class="rp-charts rp-charts-3">${monthCharts}${acuity}</div>` +
    "</div>"
  );
}

function monthPageHtml(a) {
  if (a.months.length < 2) return "";
  return (
    '<div class="report-page">' +
    '<div class="rp-subhead">月ごとの装着時間</div>' +
    '<div class="rp-charts rp-charts-2">' +
    reportChartHtml("月ごとの合計装着時間", monthTotalChartSvg(a), "") +
    reportChartHtml("月ごとの平均装着時間（1日あたり）", monthAvgChartSvg(a), "") +
    "</div></div>"
  );
}

function detailPagesHtml(a) {
  const pages = [];
  const perPage = REPORT_ROWS_PER_BLOCK * REPORT_BLOCKS_PER_PAGE;
  for (let offset = 0; offset < a.days.length; offset += perPage) {
    const pageDays = a.days.slice(offset, offset + perPage);
    const blocks = [];
    for (let b = 0; b < pageDays.length; b += REPORT_ROWS_PER_BLOCK) {
      blocks.push(reportDayTableHtml(pageDays.slice(b, b + REPORT_ROWS_PER_BLOCK)));
    }
    pages.push(
      '<div class="report-page">' +
        `<div class="rp-subhead">日ごとの詳細${offset === 0 ? "" : "（つづき）"}</div>` +
        `<div class="rp-blocks">${blocks.join("")}</div>` +
        '<div class="rp-legend">◎＝目標達成　△＝目標に届かず　未＝アイパッチ未実施　空欄＝記録なし　（合計は1日の装着時間の合計・分）</div>' +
        "</div>"
    );
  }
  return pages;
}

function buildReportHtml(a, opts) {
  const pages = diaryPagesHtml(a);
  if (opts.charts) {
    pages.push(chartPageHtml(a));
    pages.push(monthPageHtml(a));
  }
  if (opts.exams) pages.push(examPageHtml(a, false));
  if (opts.details) pages.push(...detailPagesHtml(a));
  return pages.filter(Boolean).join("");
}

/** 画面で見るとき、用紙の幅を画面の幅に合わせて縮小表示する（印刷には影響しない） */
function fitReportPreview() {
  const available = reportSheetEl.parentElement.clientWidth;
  if (!available) return;
  const scale = Math.min(1, available / REPORT_PAGE_WIDTH_PX);
  reportSheetEl.style.zoom = String(scale);
}

function renderReport() {
  const a = buildAnalysis();
  if (!a.days.length) {
    reportSheetEl.innerHTML = '<p class="settings-note">この期間には、今日までの日がありません。期間を変更してください。</p>';
    return;
  }
  reportSheetEl.innerHTML = buildReportHtml(a, readReportOptions());
  fitReportPreview();
}

viewRenderers.report = renderReport;

loadReportOptions();
Object.values(reportOptionEls).forEach((el) => {
  el.addEventListener("change", () => {
    lsSet(REPORT_OPTIONS_KEY, JSON.stringify(readReportOptions()));
    renderReport();
  });
});

reportBackBtn.addEventListener("click", () => showView("analysis"));
reportPrintBtn.addEventListener("click", () => window.print());
window.addEventListener("resize", () => {
  if (document.body.classList.contains("report-open")) fitReportPreview();
});
