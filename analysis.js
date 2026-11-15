"use strict";

/* ==========================================================
   分析（集計・グラフ）
   グラフは外部ライブラリを使わず、SVG を自前で描く。
   （オフラインでも動き、印刷しても色に頼らず読めるようにするため）
   ========================================================== */

/* ---------- 表示用の文字列 ---------- */

function formatDuration(minutes) {
  const total = Math.round(minutes);
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m}分`;
  return `${h}時間${m}分`;
}

function roundTo1(n) {
  return Math.round(n * 10) / 10;
}

/* ---------- 集計 ---------- */

/** 今の集計期間（今日まで）の記録を、グラフや表で使いやすい形にまとめる */
function buildAnalysis() {
  const p = effectivePeriod();
  const goal = state.dailyGoalMinutes;
  const days = [];
  for (let i = 0; i < p.dayCount; i++) {
    const key = addDays(p.start, i);
    const r = recordsCache.get(key);
    let status = "none";
    let minutes = 0;
    if (r) {
      if (r.notDone) {
        status = "notDone";
      } else {
        minutes = r.minutes || 0;
        status = minutes >= goal ? "achieved" : minutes > 0 ? "partial" : "zero";
      }
    }
    days.push({ key, weekday: keyToDate(key).getDay(), status, minutes, record: r || null });
  }

  const n = days.length;
  const total = days.reduce((s, d) => s + d.minutes, 0);
  const wearDays = days.filter((d) => d.minutes > 0).length;
  const a = {
    p,
    goal,
    days,
    total,
    avgAll: n ? total / n : 0,
    wearDays,
    avgWear: wearDays ? total / wearDays : 0,
    achievedDays: days.filter((d) => d.status === "achieved").length,
    notDoneDays: days.filter((d) => d.status === "notDone").length,
    noRecordDays: days.filter((d) => d.status === "none").length,
  };
  a.achieveRate = n ? a.achievedDays / n : 0;

  // 連続で目標を達成した日数
  let run = 0;
  let longest = 0;
  days.forEach((d) => {
    run = d.status === "achieved" ? run + 1 : 0;
    if (run > longest) longest = run;
  });
  a.longestStreak = longest;

  // 曜日ごと
  a.weekdays = Array.from({ length: 7 }, () => ({ sum: 0, count: 0, achieved: 0, wear: 0 }));
  days.forEach((d) => {
    const w = a.weekdays[d.weekday];
    w.sum += d.minutes;
    w.count += 1;
    if (d.status === "achieved") w.achieved += 1;
    if (d.minutes > 0) w.wear += 1;
  });
  a.weekdays.forEach((w) => {
    w.avg = w.count ? w.sum / w.count : 0;
  });

  // 装着時間の分布（30分ごと）
  const maxMin = days.reduce((m, d) => Math.max(m, d.minutes), 0);
  const binCount = Math.min(12, Math.max(Math.ceil((maxMin + 1) / 30), Math.ceil(goal / 30) + 1, 3));
  const bins = [{ lo: 0, hi: 0, label: "0", count: 0 }, { lo: 1, hi: 29, label: "1-29", count: 0 }];
  for (let j = 1; j < binCount; j++) {
    const lo = 30 * j;
    const last = j === binCount - 1;
    bins.push({ lo, hi: last ? Infinity : lo + 29, label: last && maxMin > lo + 29 ? `${lo}〜` : String(lo), count: 0 });
  }
  days.forEach((d) => {
    const bin = bins.find((b) => d.minutes >= b.lo && d.minutes <= b.hi);
    if (bin) bin.count += 1;
  });
  a.bins = bins;

  // 月ごと
  const months = [];
  days.forEach((d) => {
    const ym = d.key.slice(0, 7);
    let m = months[months.length - 1];
    if (!m || m.ym !== ym) {
      m = { ym, year: Number(ym.slice(0, 4)), month: Number(ym.slice(5, 7)), total: 0, dayCount: 0 };
      months.push(m);
    }
    m.total += d.minutes;
    m.dayCount += 1;
  });
  months.forEach((m) => {
    m.avg = m.dayCount ? m.total / m.dayCount : 0;
  });
  a.months = months;

  // 直近7日と、その前の7日
  if (n >= 14) {
    const sum = (arr) => arr.reduce((s, d) => s + d.minutes, 0);
    a.recent7 = sum(days.slice(n - 7)) / 7;
    a.prev7 = sum(days.slice(n - 14, n - 7)) / 7;
  }

  // 期間内の診察日
  a.exams = getAllExams().filter((e) => e.date >= p.start && e.date <= p.effEnd);
  return a;
}

/** 事実だけを並べた、かんたんなコメント（医療的な判断はしない） */
function buildComments(a) {
  const list = [];
  list.push(
    `目標（${a.goal}分）を達成した日は${a.achievedDays}日で、期間の${Math.round(a.achieveRate * 100)}%です。`
  );

  const usable = a.weekdays.map((w, i) => ({ i, avg: w.avg, count: w.count })).filter((w) => w.count >= 2);
  if (usable.length >= 2) {
    const sorted = [...usable].sort((x, y) => x.avg - y.avg);
    const low = sorted[0];
    const high = sorted[sorted.length - 1];
    if (high.avg - low.avg >= 20) {
      list.push(
        `曜日では、${WEEKDAYS[low.i]}曜日が平均${Math.round(low.avg)}分で最も短く、${WEEKDAYS[high.i]}曜日が平均${Math.round(high.avg)}分で最も長めです。`
      );
    } else {
      list.push("曜日による差は、あまり大きくありません。");
    }
  }

  if (a.recent7 !== undefined) {
    const diff = a.recent7 - a.prev7;
    const now = Math.round(a.recent7);
    const before = Math.round(a.prev7);
    if (Math.abs(diff) < 10) {
      list.push(`直近7日の平均は${now}分で、その前の7日（${before}分）とほぼ同じです。`);
    } else {
      list.push(
        `直近7日の平均は${now}分で、その前の7日（${before}分）より${diff > 0 ? "増えて" : "減って"}います。`
      );
    }
  }

  if (a.longestStreak >= 2) {
    list.push(`目標を連続で達成した最長は${a.longestStreak}日です。`);
  }

  if (a.noRecordDays >= 3 && a.noRecordDays / a.days.length >= 0.1) {
    list.push(
      `記録のない日が${a.noRecordDays}日あります。アイパッチをしなかった日は「アイパッチ未実施」を押しておくと、記録忘れと区別できます。`
    );
  }
  return list;
}

/* ---------- グラフ（SVG） ---------- */

const CHART_W = 360;

function svgOpen(w, h, title) {
  return `<svg class="chart" viewBox="0 0 ${w} ${h}" role="img" aria-label="${escapeHtml(title)}">`;
}

/** 分（時間）のグラフ用に、きりのよい目盛りを決める */
function minuteScale(maxValue) {
  const steps = [15, 30, 60, 120, 240, 480];
  const step = steps.find((s) => maxValue / s <= 5) || 480;
  return { max: Math.max(step, Math.ceil(maxValue / step) * step), step };
}

/** 件数（整数）のグラフ用の目盛り */
function countScale(maxValue) {
  const steps = [1, 2, 5, 10, 20, 50, 100];
  const step = steps.find((s) => maxValue / s <= 5) || 100;
  return { max: Math.max(step, Math.ceil(maxValue / step) * step), step };
}

function svgGridAndAxis(o) {
  let s = "";
  const rows = Math.round(o.yMax / o.yStep);
  for (let i = 0; i <= rows; i++) {
    const v = i * o.yStep;
    const yy = o.yAt(v);
    s += `<line class="ch-grid" x1="${o.L}" x2="${CHART_W - o.R}" y1="${yy}" y2="${yy}"/>`;
    const label = o.tickFormat ? o.tickFormat(v) : String(v);
    s += `<text class="ch-axis" x="${o.L - 4}" y="${yy + 3.5}" text-anchor="end">${label}</text>`;
  }
  if (o.unit) s += `<text class="ch-axis" x="${o.L - 4}" y="${o.T - 7}" text-anchor="end">${escapeHtml(o.unit)}</text>`;
  return s;
}

function svgBarChart(o) {
  const H = o.height || 190;
  const L = 40;
  const R = 10;
  const T = 20;
  const B = 26;
  const iw = CHART_W - L - R;
  const ih = H - T - B;
  const n = o.values.length;
  const yAt = (v) => T + ih - (Math.min(v, o.yMax) / o.yMax) * ih;
  const slot = iw / n;
  const bw = Math.min(slot * 0.66, 36);

  let s = svgOpen(CHART_W, H, o.title);
  s += svgGridAndAxis({ L, R, T, yMax: o.yMax, yStep: o.yStep, yAt, tickFormat: o.tickFormat, unit: o.unit });

  o.values.forEach((v, i) => {
    const cx = L + slot * (i + 0.5);
    const top = yAt(v);
    const hi = o.highlight && o.highlight(i);
    if (v > 0) {
      s += `<rect class="ch-bar${hi ? " ch-bar-hi" : ""}" x="${(cx - bw / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${bw.toFixed(1)}" height="${(T + ih - top).toFixed(1)}"/>`;
    }
    if (o.valueLabels && n <= 14) {
      s += `<text class="ch-val" x="${cx.toFixed(1)}" y="${(top - 3).toFixed(1)}" text-anchor="middle">${escapeHtml(o.valueLabels[i])}</text>`;
    }
    if (n <= 8 || i % 2 === 0) {
      s += `<text class="ch-axis" x="${cx.toFixed(1)}" y="${T + ih + 14}" text-anchor="middle">${escapeHtml(o.labels[i])}</text>`;
    }
  });

  s += `<line class="ch-base" x1="${L}" x2="${CHART_W - R}" y1="${T + ih}" y2="${T + ih}"/>`;
  if (o.goal !== undefined && o.goal !== null && o.goal <= o.yMax) {
    const gy = yAt(o.goal);
    s += `<line class="ch-goal" x1="${L}" x2="${CHART_W - R}" y1="${gy}" y2="${gy}"/>`;
    s += `<text class="ch-goal-text" x="${CHART_W - R}" y="${gy - 3}" text-anchor="end">目標${o.goal}分</text>`;
  }
  return s + "</svg>";
}

/** 日ごとの推移（棒＋7日平均の線＋診察日の印） */
function svgDailyChart(a) {
  const days = a.days;
  const n = days.length;
  const H = 210;
  const L = 40;
  const R = 10;
  const T = 22;
  const B = 28;
  const iw = CHART_W - L - R;
  const ih = H - T - B;
  const maxMin = Math.max(a.goal * 1.2, ...days.map((d) => d.minutes), 30);
  const sc = minuteScale(maxMin);
  const yAt = (v) => T + ih - (Math.min(v, sc.max) / sc.max) * ih;
  const xAt = (i) => L + ((i + 0.5) * iw) / n;

  let s = svgOpen(CHART_W, H, "日ごとの装着時間の推移");
  s += svgGridAndAxis({ L, R, T, yMax: sc.max, yStep: sc.step, yAt, unit: "分" });

  if (n <= 62) {
    const bw = Math.max(1.5, (iw / n) * 0.7);
    days.forEach((d, i) => {
      if (d.minutes > 0) {
        const top = yAt(d.minutes);
        s += `<rect class="ch-bar${d.status === "achieved" ? " ch-bar-hi" : ""}" x="${(xAt(i) - bw / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${bw.toFixed(1)}" height="${(T + ih - top).toFixed(1)}"/>`;
      } else if (d.status === "notDone") {
        s += `<rect class="ch-notdone" x="${(xAt(i) - bw / 2).toFixed(1)}" y="${T + ih - 3}" width="${bw.toFixed(1)}" height="3"/>`;
      }
    });
  } else {
    const pts = days.map((d, i) => `${xAt(i).toFixed(1)},${yAt(d.minutes).toFixed(1)}`).join(" ");
    s += `<polyline class="ch-line" points="${pts}"/>`;
  }

  s += `<line class="ch-base" x1="${L}" x2="${CHART_W - R}" y1="${T + ih}" y2="${T + ih}"/>`;

  if (a.goal <= sc.max) {
    const gy = yAt(a.goal);
    s += `<line class="ch-goal" x1="${L}" x2="${CHART_W - R}" y1="${gy}" y2="${gy}"/>`;
  }

  if (n >= 7) {
    const pts = [];
    for (let i = 6; i < n; i++) {
      let sum = 0;
      for (let k = i - 6; k <= i; k++) sum += days[k].minutes;
      pts.push(`${xAt(i).toFixed(1)},${yAt(sum / 7).toFixed(1)}`);
    }
    s += `<polyline class="ch-avg" points="${pts.join(" ")}"/>`;
  }

  a.exams.forEach((e) => {
    const idx = diffDays(a.p.start, e.date);
    if (idx < 0 || idx >= n) return;
    const x = xAt(idx).toFixed(1);
    s += `<line class="ch-exam" x1="${x}" x2="${x}" y1="${T}" y2="${T + ih}"/>`;
    s += `<text class="ch-exam-text" x="${x}" y="${T - 5}" text-anchor="middle">診</text>`;
  });

  const wanted = n <= 5 ? n : 5;
  const used = new Set();
  for (let k = 0; k < wanted; k++) {
    const idx = wanted === 1 ? 0 : Math.round((k * (n - 1)) / (wanted - 1));
    if (used.has(idx)) continue;
    used.add(idx);
    const d = keyToDate(days[idx].key);
    const anchor = idx === 0 && n > 1 ? "start" : idx === n - 1 && n > 1 ? "end" : "middle";
    const x = anchor === "start" ? L : anchor === "end" ? CHART_W - R : xAt(idx);
    s += `<text class="ch-axis" x="${x.toFixed(1)}" y="${T + ih + 15}" text-anchor="${anchor}">${d.getMonth() + 1}/${d.getDate()}</text>`;
  }
  return s + "</svg>";
}

function weekdayChartSvg(a) {
  const values = a.weekdays.map((w) => w.avg);
  const sc = minuteScale(Math.max(a.goal * 1.2, ...values, 30));
  return svgBarChart({
    title: "曜日ごとの平均装着時間",
    labels: WEEKDAYS,
    values,
    valueLabels: values.map((v) => String(Math.round(v))),
    yMax: sc.max,
    yStep: sc.step,
    unit: "分",
    goal: a.goal,
    highlight: (i) => values[i] >= a.goal,
  });
}

function histogramChartSvg(a) {
  const values = a.bins.map((b) => b.count);
  const sc = countScale(Math.max(...values, 1));
  return svgBarChart({
    title: "装着時間ごとの日数（ヒストグラム）",
    labels: a.bins.map((b) => b.label),
    values,
    valueLabels: values.map(String),
    yMax: sc.max,
    yStep: sc.step,
    unit: "日",
    highlight: (i) => a.bins[i].lo >= a.goal,
  });
}

function monthLabel(m, spansYears) {
  return spansYears ? `${String(m.year).slice(2)}/${m.month}` : `${m.month}月`;
}

function monthTotalChartSvg(a) {
  const spans = a.months.length > 1 && a.months[0].year !== a.months[a.months.length - 1].year;
  const hours = a.months.map((m) => m.total / 60);
  const sc = countScale(Math.max(...hours, 1));
  return svgBarChart({
    title: "月ごとの合計装着時間",
    labels: a.months.map((m) => monthLabel(m, spans)),
    values: hours,
    valueLabels: hours.map((h) => String(roundTo1(h))),
    yMax: sc.max,
    yStep: sc.step,
    unit: "時間",
  });
}

function monthAvgChartSvg(a) {
  const spans = a.months.length > 1 && a.months[0].year !== a.months[a.months.length - 1].year;
  const values = a.months.map((m) => m.avg);
  const sc = minuteScale(Math.max(a.goal * 1.2, ...values, 30));
  return svgBarChart({
    title: "月ごとの平均装着時間（1日あたり）",
    labels: a.months.map((m) => monthLabel(m, spans)),
    values,
    valueLabels: values.map((v) => String(Math.round(v))),
    yMax: sc.max,
    yStep: sc.step,
    unit: "分",
    goal: a.goal,
    highlight: (i) => values[i] >= a.goal,
  });
}

/* ---------- 視力グラフ（診察記録） ---------- */

// 4つとも「色・印の形・線の種類」がすべて違う（白黒印刷でも見分けられる）
const ACUITY_SERIES = [
  { key: "rightNaked", label: "右目 裸眼", shape: "circle", cls: "ch-s-rn" }, // 丸・実線
  { key: "rightGlasses", label: "右目 眼鏡あり", shape: "triangle", cls: "ch-s-rg" }, // 三角・破線
  { key: "leftNaked", label: "左目 裸眼", shape: "square", cls: "ch-s-ln" }, // 四角・点線
  { key: "leftGlasses", label: "左目 眼鏡あり", shape: "diamond", cls: "ch-s-lg" }, // ひし形・一点鎖線
];

function svgMarker(shape, x, y, cls, hollow) {
  const c = `${cls} ch-marker${hollow ? " ch-hollow" : ""}`;
  const fx = x.toFixed(1);
  if (shape === "square") {
    return `<rect class="${c}" x="${(x - 3.4).toFixed(1)}" y="${(y - 3.4).toFixed(1)}" width="6.8" height="6.8"/>`;
  }
  if (shape === "triangle") {
    return `<polygon class="${c}" points="${fx},${(y - 4.4).toFixed(1)} ${(x + 4.2).toFixed(1)},${(y + 3.2).toFixed(1)} ${(x - 4.2).toFixed(1)},${(y + 3.2).toFixed(1)}"/>`;
  }
  if (shape === "diamond") {
    return `<polygon class="${c}" points="${fx},${(y - 4.6).toFixed(1)} ${(x + 4.2).toFixed(1)},${y.toFixed(1)} ${fx},${(y + 4.6).toFixed(1)} ${(x - 4.2).toFixed(1)},${y.toFixed(1)}"/>`;
  }
  return `<circle class="${c}" cx="${fx}" cy="${y.toFixed(1)}" r="3.6"/>`;
}

/**
 * 視力の推移。測定しなかった回（未測定）は、前回測定した値を引き継いで
 * 白抜きの印で表示する。
 */
function svgAcuityChart(exams) {
  const n = exams.length;
  const H = 262;
  const L = 36;
  const R = 14;
  const T = 26;
  const plotBottom = 192;
  const ih = plotBottom - T;
  const iw = CHART_W - L - R;

  const allValues = [];
  exams.forEach((e) => ACUITY_SERIES.forEach((s) => e[s.key] != null && allValues.push(e[s.key])));
  const maxV = Math.max(1, ...allValues);
  const yMax = maxV > 1.2 ? 2 : maxV > 1 ? 1.5 : 1;
  const yStep = yMax > 1 ? 0.5 : 0.2;
  const yAt = (v) => T + ih - (v / yMax) * ih;
  const xAt = (i) => (n === 1 ? L + iw / 2 : L + 12 + (i * (iw - 24)) / (n - 1));

  let s = svgOpen(CHART_W, H, "視力の推移");
  s += svgGridAndAxis({ L, R, T, yMax, yStep, yAt, tickFormat: (v) => v.toFixed(1), unit: "視力" });
  s += `<line class="ch-base" x1="${L}" x2="${CHART_W - R}" y1="${plotBottom}" y2="${plotBottom}"/>`;

  ACUITY_SERIES.forEach((series) => {
    const points = [];
    let last = null;
    exams.forEach((e, i) => {
      const measured = e[series.key] != null;
      if (measured) last = e[series.key];
      if (last !== null) points.push({ x: xAt(i), y: yAt(last), measured });
    });
    if (points.length >= 2) {
      const pts = points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
      s += `<polyline class="ch-line ${series.cls}" points="${pts}"/>`;
    }
    points.forEach((p) => {
      s += svgMarker(series.shape, p.x, p.y, series.cls, !p.measured);
    });
  });

  const wanted = Math.min(n, 5);
  const used = new Set();
  for (let k = 0; k < wanted; k++) {
    const idx = wanted === 1 ? 0 : Math.round((k * (n - 1)) / (wanted - 1));
    if (used.has(idx)) continue;
    used.add(idx);
    const d = keyToDate(exams[idx].date);
    s += `<text class="ch-axis" x="${xAt(idx).toFixed(1)}" y="${plotBottom + 14}" text-anchor="middle">${String(d.getFullYear()).slice(2)}/${d.getMonth() + 1}/${d.getDate()}</text>`;
  }

  // 凡例（印の形：丸＝右目、四角＝左目／実線＝裸眼、点線＝眼鏡あり）
  ACUITY_SERIES.forEach((series, i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const x0 = col === 0 ? L : CHART_W / 2 + 4;
    const y0 = 226 + row * 20;
    s += `<line class="ch-line ${series.cls}" x1="${x0}" x2="${x0 + 22}" y1="${y0}" y2="${y0}"/>`;
    s += svgMarker(series.shape, x0 + 11, y0, series.cls, false);
    s += `<text class="ch-axis ch-legend-text" x="${x0 + 28}" y="${y0 + 3.5}">${series.label}</text>`;
  });
  return s + "</svg>";
}

/* ---------- 分析画面 ---------- */

const analysisBodyEl = document.getElementById("analysis-body");
const analysisPeriodNoteEl = document.getElementById("analysis-period-note");

function statTile(label, value, sub) {
  return (
    `<div class="stat-tile"><div class="stat-label">${escapeHtml(label)}</div>` +
    `<div class="stat-value">${escapeHtml(value)}</div>` +
    (sub ? `<div class="stat-sub">${escapeHtml(sub)}</div>` : "") +
    "</div>"
  );
}

function statTilesHtml(a) {
  const n = a.days.length;
  return (
    '<div class="stat-grid">' +
    statTile("合計の装着時間", formatDuration(a.total)) +
    statTile("1日あたりの平均", `${Math.round(a.avgAll)}分`, "期間のすべての日で計算") +
    statTile("装着した日の平均", a.wearDays ? `${Math.round(a.avgWear)}分` : "－", "装着した日だけで計算") +
    statTile("目標を達成した日", `${a.achievedDays}日`, `${Math.round(a.achieveRate * 100)}%（目標${a.goal}分）`) +
    statTile("装着した日数", `${a.wearDays}日`, `${n}日間のうち`) +
    statTile("未実施の日", `${a.notDoneDays}日`, "「未実施」を押した日") +
    statTile("記録のない日", `${a.noRecordDays}日`, "何も入力がない日") +
    statTile("連続達成の最長", `${a.longestStreak}日`, "目標を連続で達成") +
    "</div>"
  );
}

function chartCard(title, svg, note) {
  return (
    `<div class="analysis-card"><h3 class="analysis-title">${escapeHtml(title)}</h3>${svg}` +
    (note ? `<p class="chart-note">${note}</p>` : "") +
    "</div>"
  );
}

const DAILY_NOTE = "濃い棒＝目標達成、薄い棒＝目標に届かず、細い線＝直近7日の平均、点線＝目標、「診」＝診察日";
const HIST_NOTE = "横軸は装着時間（分）。各柱は「その数字以上〜次の数字未満」の日数です（0＝未装着・未実施・記録なし）。濃い柱は目標以上。";

function analysisSectionsHtml(a) {
  const comments = buildComments(a);
  let html = statTilesHtml(a);
  html +=
    '<div class="analysis-card"><h3 class="analysis-title">かんたんコメント</h3><ul class="comment-list">' +
    comments.map((c) => `<li>${escapeHtml(c)}</li>`).join("") +
    "</ul></div>";
  html += chartCard("日ごとの装着時間", svgDailyChart(a), DAILY_NOTE);
  html += chartCard("曜日ごとの平均装着時間", weekdayChartSvg(a), "濃い棒は平均が目標以上の曜日です。");
  html += chartCard("装着時間の分布", histogramChartSvg(a), HIST_NOTE);
  html += chartCard("月ごとの合計装着時間", monthTotalChartSvg(a), "");
  html += chartCard("月ごとの平均装着時間（1日あたり）", monthAvgChartSvg(a), "濃い棒は平均が目標以上の月です。");
  return html;
}

function renderAnalysis() {
  syncPeriodInputs();
  renderPeriodPresets();
  const a = buildAnalysis();
  analysisPeriodNoteEl.textContent = a.p.capped
    ? `終了日が今日より先なので、今日までの${a.p.dayCount}日間で集計しています。`
    : "";
  if (!a.days.length) {
    analysisBodyEl.innerHTML =
      '<p class="settings-note">この期間には、今日までの日がありません。期間を変更してください。</p>';
    return;
  }
  analysisBodyEl.innerHTML = analysisSectionsHtml(a);
}

viewRenderers.analysis = renderAnalysis;

const reportOpenBtn = document.getElementById("report-open-btn");
if (reportOpenBtn) {
  reportOpenBtn.addEventListener("click", () => showView("report"));
}
