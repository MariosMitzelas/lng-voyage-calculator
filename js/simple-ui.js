"use strict";

// Keep the existing calculation and import entry points while exposing one planning flow.
function buildSimpleUI() {
  const tabs = document.querySelector(".tabs");
  tabs.innerHTML = [
    ["panel-voyage", "Ταξίδι", "tab-voyage", ""],
    ["panel-cons", "Ταχύτητα & Κατανάλωση", "tab-cons", ""],
    ["panel-discharge", "Ramp-down φόρτωσης", "tab-loading", "loading"],
    ["panel-discharge", "Ramp-down εκφόρτωσης", "tab-unloading", "unloading"],
  ].map(([panel, label, test, mode], i) =>
    '<button class="tab-btn" type="button" role="tab" aria-selected="' + (i === 0) + '" data-panel="' + panel
    + '" data-testid="' + test + '"' + (mode ? ' data-transfer-mode="' + mode + '"' : "") + ">" + label + "</button>").join("");
  for (const id of ["panel-lng", "panel-results", "panel-ops"]) $(id).hidden = true;
  document.querySelector(".summary-bar").hidden = true;
  const consumption = $("panel-cons");
  for (const child of consumption.children) child.hidden = true;
  const card = document.createElement("div");
  card.className = "card";
  card.innerHTML = '<h2>Ταχύτητα & Κατανάλωση</h2><div class="grid-form">'
    + '<label class="field">Κατάσταση<select id="simplePhase"><option value="laden">Laden · Φορτωμένο</option><option value="ballast">Ballast · Άφορτο</option></select></label>'
    + '<label class="field">Πίνακας<select id="simpleCurveSource"><option value="charter">Charter Party</option><option value="manual">Χειροκίνητος</option></select></label>'
    + '<label class="field" id="simplePilotField">Pilot fuel<select id="simplePilot"><option value="">Χωριστή αναφορά</option><option value="included">Μέσα στο LSGO-equivalent</option><option value="additional">Επιπλέον του LSGO-equivalent</option></select></label>'
    + '</div><div class="ops-actions" id="simpleCPImport"></div>'
    + '<p class="hint" id="simpleCurveStatus" role="status"></p><div class="table-wrap"><table class="data-table" id="simpleCurve"></table></div>'
    + '<button class="btn small" type="button" id="simpleAddSpeed">Προσθήκη ταχύτητας</button>';
  consumption.prepend(card);
  const cpInput = $("cpImport");
  $("simpleCPImport").append(document.querySelector('label[for="cpImport"]'), cpInput);
  const density = $("density").closest(".field");
  const params = document.createElement("details");
  params.className = "voyage-options";
  params.innerHTML = "<summary>Στοιχεία φορτίου</summary><div class='grid-form'></div>";
  params.querySelector(".grid-form").append(density, $("capacity").closest(".field"), $("fillPct").closest(".field"));
  $("ladenDeparture").append(params);
  for (const id of ["linkedLadenTable", "linkedHeelTable", "linkedTimeline"]) $(id).closest("details").hidden = true;
  $("plannedHeelField").closest("details").hidden = true;
  $("tankStep").hidden = true;
  document.querySelector('[data-linked="source"]').closest("details").hidden = true;
  $("transferMode").closest(".field").hidden = true;
  $("transferPlanner").querySelector("h2").id = "simpleTransferTitle";
  $("simplePhase").addEventListener("change", renderSimpleCurve);
  $("simpleCurveSource").addEventListener("change", event => {
    const phase = $("simplePhase").value;
    if (event.target.value === "charter") {
      if (!validCharterParty(S.charterParty)) return renderSimpleCurve();
      S.charterParty.options[phase] = true;
    } else {
      (S.phaseCurves ??= {})[phase] ??= simpleCurveRows(phase).map(row => ({ ...row }));
      if (validCharterParty(S.charterParty)) S.charterParty.options[phase] = false;
    }
    render();
  });
  $("simplePilot").addEventListener("change", event => {
    if (S.charterParty) (S.charterParty.inputs ??= {}).pilotTreatment = event.target.value;
    render();
  });
  $("simpleAddSpeed").addEventListener("click", () => {
    const phase = $("simplePhase").value;
    const curve = S.phaseCurves[phase];
    const last = curve.at(-1) ?? { speed: 9, lng: 0, mdo: 0, fo: 0 };
    curve.push({ ...last, speed: last.speed + 1 });
    render();
  });
  $("simpleCurve").addEventListener("change", event => {
    const input = event.target;
    if (input.dataset.curveRow == null || !input.checkValidity()) return;
    const curve = S.phaseCurves[$("simplePhase").value];
    const row = curve[Number(input.dataset.curveRow)];
    const key = input.dataset.curveKey;
    const value = Number(input.value);
    if (input.value === "" || key === "speed" && curve.some(other => other !== row && other.speed === value)) {
      $("simpleCurveStatus").textContent = "Βάλε έγκυρη τιμή και διαφορετική ταχύτητα ανά σειρά.";
      return;
    }
    row[key] = value;
    render();
  });
  $("simpleCurve").addEventListener("click", event => {
    const button = event.target.closest("[data-curve-delete]");
    if (!button) return;
    S.phaseCurves[$("simplePhase").value].splice(Number(button.dataset.curveDelete), 1);
    render();
  });
}

function simpleCurveRows(phase) {
  if (validCharterParty(S.charterParty) && charterEnabled(S.charterParty, phase)) {
    return S.charterParty.sea.map(row => {
      const value = charterSeaValues(S.charterParty, row, phase, S.density);
      return { speed: value.speed, lng: value.lng, fo: value.fo, mdo: value.mdo };
    });
  }
  const curve = S.phaseCurves?.[phase];
  return curve?.length ? curve : S.consTable.map(row => ({ speed: row.speed, lng: lngConversions(row).volume, fo: row.fo, mdo: row.mdo }));
}

function renderSimpleCurve() {
  $("departureLngLabel").textContent = "LNG ROB μετά τη φόρτωση / στην αναχώρηση (m³)";
  const phase = $("simplePhase").value;
  const cp = validCharterParty(S.charterParty) && charterEnabled(S.charterParty, phase);
  $("simpleCurveSource").value = cp ? "charter" : "manual";
  $("simplePilotField").hidden = !cp;
  $("simplePilot").value = S.charterParty?.inputs?.pilotTreatment ?? "";
  $("simpleAddSpeed").hidden = cp;
  const rows = simpleCurveRows(phase);
  if (!cp) (S.phaseCurves ??= {})[phase] = rows;
  const cell = (value, i, key, label) => cp ? fmt(value, 3)
    : '<input type="number" min="' + (key === "speed" ? "0.01" : "0") + '" step="any" data-curve-row="' + i
      + '" data-curve-key="' + key + '" value="' + value + '" aria-label="' + label + ' σειρά ' + (i + 1) + '">';
  $("simpleCurve").innerHTML = tableHtml(["kn", "LNG m³/ημέρα", "LSMGO t/ημέρα", "LSHFO t/ημέρα", ""], []);
  $("simpleCurve").querySelector("tbody").innerHTML = rows.map((row, i) => "<tr>"
    + [["speed", "Ταχύτητα"], ["lng", "LNG"], ["mdo", "LSMGO"], ["fo", "LSHFO"]]
      .map(([key, label]) => "<td>" + cell(row[key], i, key, label) + "</td>").join("")
    + "<td>" + (cp ? "" : '<button type="button" class="btn small" data-curve-delete="' + i + '" aria-label="Διαγραφή σειράς ' + (i + 1) + '">×</button>') + "</td></tr>").join("");
  $("simpleCurveStatus").textContent = (cp ? "Charter Party" : "Χειροκίνητος πίνακας") + " · "
    + (phase === "laden" ? "Laden" : "Ballast") + " · Density " + fmt(S.density, 4) + " t/m³";
  $("simpleTransferTitle").textContent = S.transfer?.mode === "unloading" ? "Ramp-down εκφόρτωσης" : "Ramp-down φόρτωσης";
  $("linkedTimeline").closest("details").hidden = true;
}

buildSimpleUI();
