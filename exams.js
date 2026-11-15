"use strict";

/* ==========================================================
   診察記録（眼科の受診内容を残す画面）
   保存先：households/{共有コード}/exams/{自動ID}
   ========================================================== */

const examNextVisitEl = document.getElementById("exam-next-visit");
const examAddBtn = document.getElementById("exam-add-btn");
const examFormWrap = document.getElementById("exam-form-wrap");
const examFormTitle = document.getElementById("exam-form-title");
const examDateInput = document.getElementById("exam-date");
const examNextDateInput = document.getElementById("exam-next-date");
const examCommentInput = document.getElementById("exam-comment");
const examSaveBtn = document.getElementById("exam-save-btn");
const examCancelBtn = document.getElementById("exam-cancel-btn");
const examDeleteBtn = document.getElementById("exam-delete-btn");
const examFormStatus = document.getElementById("exam-form-status");
const examListEl = document.getElementById("exam-list");
const examChartEl = document.getElementById("exam-chart");

const ACUITY_FIELDS = [
  { key: "rightNaked", selectId: "exam-right-naked" },
  { key: "rightGlasses", selectId: "exam-right-glasses" },
  { key: "leftNaked", selectId: "exam-left-naked" },
  { key: "leftGlasses", selectId: "exam-left-glasses" },
];

let editingExamId = null;

/** 視力のプルダウンの中身を作る（未測定／0.1未満／0.1〜1.0／1.2／1.5／2.0） */
function setupAcuitySelects() {
  ACUITY_FIELDS.forEach((f) => {
    const select = document.getElementById(f.selectId);
    select.innerHTML = "";
    ACUITY_OPTIONS.forEach((opt) => {
      const o = document.createElement("option");
      o.value = opt.value === null ? "" : String(opt.value);
      o.textContent = opt.label;
      select.appendChild(o);
    });
  });
}

function setExamFormStatus(message) {
  examFormStatus.textContent = message || " ";
}

function openExamForm(exam) {
  editingExamId = exam ? exam.id : null;
  examFormTitle.textContent = exam ? "診察記録を編集" : "診察記録を追加";
  examDateInput.value = exam ? exam.date : todayKey();
  examNextDateInput.value = exam && exam.nextVisitDate ? exam.nextVisitDate : "";
  examCommentInput.value = exam ? exam.comment || "" : "";
  ACUITY_FIELDS.forEach((f) => {
    const v = exam ? exam[f.key] : null;
    document.getElementById(f.selectId).value = v === null || v === undefined ? "" : String(v);
  });
  examDeleteBtn.classList.toggle("hidden", !exam);
  setExamFormStatus("");
  examFormWrap.classList.remove("hidden");
  examAddBtn.classList.add("hidden");
  examFormWrap.scrollIntoView({ behavior: "smooth", block: "start" });
}

function closeExamForm() {
  editingExamId = null;
  examFormWrap.classList.add("hidden");
  examAddBtn.classList.remove("hidden");
}

function examAcuityTableHtml(exam) {
  const cell = (v) =>
    v === null || v === undefined
      ? '<td class="exam-unmeasured">未測定</td>'
      : `<td>${escapeHtml(acuityLabel(v))}</td>`;
  return (
    '<table class="exam-table"><thead><tr><th></th><th>裸眼</th><th>眼鏡あり</th></tr></thead><tbody>' +
    `<tr><th>右目</th>${cell(exam.rightNaked)}${cell(exam.rightGlasses)}</tr>` +
    `<tr><th>左目</th>${cell(exam.leftNaked)}${cell(exam.leftGlasses)}</tr>` +
    "</tbody></table>"
  );
}

function renderNextVisit(exams) {
  const withNext = exams.filter((e) => e.nextVisitDate);
  if (!withNext.length) {
    examNextVisitEl.textContent = "";
    return;
  }
  const latest = withNext[withNext.length - 1];
  const diff = diffDays(todayKey(), latest.nextVisitDate);
  let note = "";
  if (diff > 0) note = `（あと${diff}日）`;
  else if (diff === 0) note = "（今日です）";
  else note = `（${-diff}日前に過ぎています）`;
  examNextVisitEl.textContent = `次回の診察予定日：${formatDateJa(latest.nextVisitDate)}${note}`;
}

function renderExams() {
  const exams = getAllExams();
  renderNextVisit(exams);

  examListEl.innerHTML = "";
  if (!exams.length) {
    const p = document.createElement("p");
    p.className = "settings-note";
    p.textContent = "まだ診察記録がありません。「診察記録を追加」から入力してください。";
    examListEl.appendChild(p);
  } else {
    [...exams].reverse().forEach((exam) => {
      const card = document.createElement("div");
      card.className = "exam-card";
      const comment = exam.comment
        ? `<p class="exam-comment">${escapeHtml(exam.comment).replace(/\n/g, "<br>")}</p>`
        : "";
      const next = exam.nextVisitDate
        ? `<p class="exam-next">次回の診察予定日：${escapeHtml(formatDateJa(exam.nextVisitDate))}</p>`
        : "";
      card.innerHTML =
        `<div class="exam-card-head"><strong>${escapeHtml(formatDateJa(exam.date))}</strong>` +
        `<button type="button" class="btn-link exam-edit-btn">編集</button></div>` +
        examAcuityTableHtml(exam) +
        comment +
        next;
      card.querySelector(".exam-edit-btn").addEventListener("click", () => openExamForm(exam));
      examListEl.appendChild(card);
    });
  }

  examChartEl.innerHTML = exams.length
    ? svgAcuityChart(exams) +
      '<p class="settings-note">白抜きの印は「未測定」の回で、前回測定した値を引き継いで表示しています。</p>'
    : '<p class="settings-note">診察記録を入力すると、視力の推移グラフが表示されます。</p>';

  renderPeriodPresets();
}

examAddBtn.addEventListener("click", () => openExamForm(null));
examCancelBtn.addEventListener("click", closeExamForm);

examSaveBtn.addEventListener("click", async () => {
  if (!guardWrite()) return;
  const date = examDateInput.value;
  if (!date) {
    setExamFormStatus("診察日を入力してください");
    return;
  }
  const nextDate = examNextDateInput.value || null;
  if (nextDate && nextDate < date) {
    setExamFormStatus("次回の診察予定日が、診察日より前になっています");
    return;
  }
  const raw = { date, nextVisitDate: nextDate, comment: examCommentInput.value.trim(), updatedAt: new Date().toISOString() };
  ACUITY_FIELDS.forEach((f) => {
    raw[f.key] = document.getElementById(f.selectId).value;
  });
  const data = sanitizeExam(raw);
  const id = editingExamId || examsCol().doc().id;
  try {
    await examsCol().doc(id).set(data);
    closeExamForm();
    renderExams();
  } catch (err) {
    setExamFormStatus("保存できませんでした。通信状況を確認してください");
  }
});

examDeleteBtn.addEventListener("click", async () => {
  if (!editingExamId || !guardWrite()) return;
  const ok = window.confirm("この診察記録を削除します。元に戻せません。よろしいですか？");
  if (!ok) return;
  try {
    await examsCol().doc(editingExamId).delete();
    closeExamForm();
    renderExams();
  } catch (err) {
    setExamFormStatus("削除できませんでした。通信状況を確認してください");
  }
});

setupAcuitySelects();
viewRenderers.exams = renderExams;
