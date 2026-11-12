"use strict";

const opsNumber = (value) => {
  const n = optionalNumber(value);
  return n >= 0 ? n : NaN;
};
const opsDate = (value) => stopEpoch(value, 0);
const opsIso = (epoch, offset = 0) => Number.isFinite(epoch)
  ? new Date(epoch + offset * HOUR).toISOString().slice(0, 16) : "";
const opsClone = (value) => JSON.parse(JSON.stringify(value));
const opsEscape = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
const phaseNames = { laden: "Laden", ballast: "Ballast", canal: "Διώρυγα", wait: "Αναμονή" };
const phaseFields = {
  lng: "LNG m³/d", fo: "LSHFO t/d", mdo: "LSMGO t/d", bor: "BOR %/d", frs: "FRS m³/d", forced: "Όριο forcing m³/d",
};
const scenarioIds = ["opsDelayA", "opsDelayB", "opsDelayC", "opsMax", "opsOpen", "opsClose", "opsHeel"];
const dischargeIds = ["discStart", "discLoaded", "discVolume", "discHeel", "discRate", "discUp", "discDown",
  "discStripVolume", "discStripTime", "discLoss"];
const profileKeys = ["density", "capacity", "fillPct", "coolTanks", "coolLine", "cvLNG", "cvFOE",
  "consTable", "serviceSpeed", "marginMode", "marginPct", "marginAmount", "idleLng", "idleFo", "idleMdo"];

function opsState() {
  if (!S.ops || typeof S.ops !== "object") S.ops = {};
  return S.ops;
}

function withVoyage(state, callback = compute) {
  const active = S;
  try {
    S = state;
    return callback();
  } finally {
    S = active;
  }
}

function voyageSnapshot() {
  const { ops, discharge, ...voyage } = S;
  return opsClone(voyage);
}

function tableHtml(headers, rows) {
  return "<thead><tr>" + headers.map((header) => `<th scope="col">${opsEscape(header)}</th>`).join("")
    + "</tr></thead><tbody>" + rows.map((row) => "<tr>"
      + row.map((cell) => `<td>${opsEscape(cell)}</td>`).join("") + "</tr>").join("") + "</tbody>";
}

function optionsHtml(options, selected) {
  return options.map(([value, label]) => `<option value="${opsEscape(value)}"${String(value) === String(selected) ? " selected" : ""}>${opsEscape(label)}</option>`).join("");
}

function forecastPhases(legs, rates, state, hours) {
  const model = state.phaseModel || {};
  const rows = [];
  let rob = state.robLng;
  let foT = 0;
  let mdoT = 0;
  let lngM3 = 0;
  let cargoUsed = 0;
  if (!Number.isFinite(hours)) return { rows, lngM3: NaN, cargoUsed: NaN, foT: NaN, mdoT: NaN };

  legs.forEach((leg, i) => {
    const phase = leg.canal ? "canal" : state.legs[i].phase === "ballast" ? "ballast" : "laden";
    const sailing = rates[i] || {};
    const waits = { lng: state.idleLng, fo: state.idleFo, mdo: state.idleMdo };
    for (const [kind, time] of [[phase, leg.hours], ["wait", leg.waitHours]]) {
      if (time <= 0) continue;
      const days = time / 24;
      const setup = model[kind] || {};
      const rate = (fuel) => {
        const override = opsNumber(setup[fuel]);
        const idle = kind === "wait" ? opsNumber(waits[fuel]) : NaN;
        return Number.isFinite(override) ? override : Number.isFinite(idle) ? idle : sailing[fuel] ?? NaN;
      };
      const demand = rate("lng") * days;
      const bor = opsNumber(setup.bor);
      const natural = Number.isFinite(bor) && bor <= 100
        ? Math.max(0, rob) * (1 - (1 - bor / 100) ** days) : 0;
      const forced = Math.max(0, demand - natural);
      const recovered = Math.min(Math.max(0, natural - demand), (opsNumber(setup.frs) || 0) * days);
      const loss = Math.max(demand, natural - recovered);
      const forcingLimit = opsNumber(setup.forced);
      rob -= loss;
      lngM3 += demand;
      cargoUsed += loss;
      foT += rate("fo") * days;
      mdoT += rate("mdo") * days;
      rows.push({ leg: i + 1, kind, time, demand, natural, forced, recovered, loss, rob,
        bogEnabled: Number.isFinite(bor),
        exceedsForcing: Number.isFinite(forcingLimit) && forced > forcingLimit * days + 1e-7 });
    }
  });
  return { rows, lngM3, cargoUsed, foT, mdoT };
}

function parseCurve(text) {
  const rows = text.trim() ? text.trim().split(/\r?\n/).filter((line) => line.trim()) : [];
  const speeds = new Set();
  return rows.map((line, index) => {
    const cells = line.split(",").map((cell) => cell.trim());
    const [speed, lng, fo, mdo] = cells.map((cell) => cell === "" ? NaN : Number(cell));
    if (cells.length !== 4 || ![speed, lng, fo, mdo].every((n) => Number.isFinite(n) && n >= 0)
        || speed <= 0 || speeds.has(speed)) throw new Error(`Γραμμή ${index + 1}: χρειάζονται 4 αριθμοί και μοναδική θετική ταχύτητα.`);
    speeds.add(speed);
    return { speed, lng, fo, mdo };
  });
}

function renderPhaseInputs() {
  for (const [phase, id] of [["laden", "opsLaden"], ["ballast", "opsBallast"]]) {
    $(id).value = (S.phaseCurves?.[phase] || []).map((row) => [row.speed, row.lng, row.fo, row.mdo].join(", ")).join("\n");
  }
  $("opsPhaseInputs").innerHTML = "<thead><tr><th>Φάση</th>"
    + Object.values(phaseFields).map((label) => `<th>${label}</th>`).join("") + "</tr></thead><tbody>"
    + Object.entries(phaseNames).map(([phase, label]) => `<tr><th scope="row">${label}</th>`
      + Object.entries(phaseFields).map(([key, unit]) => {
        if (["laden", "ballast"].includes(phase) && ["lng", "fo", "mdo"].includes(key)) return "<td>Καμπύλη</td>";
        return `<td><input aria-label="${label} ${unit}" type="number" min="0" ${key === "bor" ? 'max="100"' : ""}
          step="any" data-phase="${phase}" data-phase-key="${key}" value="${opsEscape(S.phaseModel?.[phase]?.[key])}"></td>`;
      }).join("") + "</tr>").join("") + "</tbody>";
}

function savePhaseModel() {
  try {
    const phaseCurves = { laden: parseCurve($("opsLaden").value), ballast: parseCurve($("opsBallast").value) };
    const phaseModel = {};
    for (const input of $("opsPhaseInputs").querySelectorAll("input")) {
      if (!input.value) continue;
      if (!input.checkValidity()) throw new Error("Έλεγξε τα όρια στις τιμές ανά φάση.");
      const { phase, phaseKey } = input.dataset;
      (phaseModel[phase] ??= {})[phaseKey] = Number(input.value);
    }
    S.phaseCurves = phaseCurves;
    S.phaseModel = phaseModel;
    $("opsModelStatus").textContent = "Οι ρυθμίσεις εφαρμόστηκαν.";
    render();
  } catch (error) {
    $("opsModelStatus").textContent = error.message;
  }
}

function renderPhaseForecast(result) {
  if (!$("opsPhaseResults")) return;
  $("opsPhaseResults").innerHTML = tableHtml(
    ["Σκέλος", "Φάση", "Ώρες", "LNG καυσίμου (m³)", "NBOG (m³)", "Forcing (m³)",
      "Ανάκτηση FRS (m³)", "Μείωση LNG (m³)", "LNG ROB (m³)", "Όριο forcing"],
    result.phaseForecast.rows.map((row) => [
      row.leg, phaseNames[row.kind], fmt(row.time, 1), fmt(row.demand, 1),
      row.bogEnabled ? fmt(row.natural, 1) : "—", row.bogEnabled ? fmt(row.forced, 1) : "—",
      fmt(row.recovered, 1), fmt(row.loss, 1), fmt(row.rob, 1), row.exceedsForcing ? "Υπέρβαση" : "—",
    ])
  );
}

function resetBaseline() {
  const ops = opsState();
  if (ops.reports?.length && !window.confirm("Νέο αρχικό πλάνο; Οι τρέχουσες ενημερώσεις Noon θα αφαιρεθούν από αυτό το ταξίδι.")) return;
  ops.baseline = voyageSnapshot();
  ops.reports = [];
  ops.activeReport = "";
  delete ops.slot;
  syncOperations();
  runScenarios();
  $("opsNoonStatus").textContent = "Ξεκίνησε νέο ιστορικό Noon Updates.";
}

function renderOperationsControls() {
  const ops = opsState();
  const base = ops.baseline || S;
  const legs = base.legs;
  const routeOptions = legs.map((leg, i) => [i, `${i + 1}. ${PORTS[leg.fromIdx]?.name} → ${PORTS[leg.toIdx]?.name}`]);
  const active = (ops.reports || []).find((report) => report.id === ops.activeReport);
  const prevLeg = $("opsLeg").value || String(active?.leg ?? 0);
  $("opsLeg").innerHTML = optionsHtml(routeOptions, prevLeg);
  $("opsHistory").innerHTML = optionsHtml([["", "Χωρίς Noon Update"], ...(ops.reports || []).slice().reverse()
    .map((report) => [report.id, `${utcText(opsDate(report.stamp))} · Leg ${report.leg + 1}`])], ops.activeReport || "");
  const slotOptions = routeOptions.slice(0, -1).filter(([i]) => i >= (active?.leg ?? 0));
  const canalSlot = slotOptions.find(([i]) => legCanal(legs[i + 1].fromIdx, legs[i + 1].toIdx));
  $("opsSlot").innerHTML = optionsHtml([["", "Χωρίς ενδιάμεση καθυστέρηση"], ...slotOptions],
    ops.slot ?? canalSlot?.[0] ?? "");
  $("opsBaseStatus").textContent = ops.baseline
    ? `Αρχικό πλάνο: ${routeOptions[0]?.[1].split(". ").slice(1).join(". ") || "—"} · ${legs.length} σκέλη.`
    : "Τα σενάρια χρησιμοποιούν το τρέχον ταξίδι. Η πρώτη καταχώριση Noon Update κρατά αντίγραφο του πλάνου.";
  updateNoonFields();
}

function updateNoonFields() {
  const base = opsState().baseline || S;
  const leg = base.legs[Number($("opsLeg").value)];
  const canal = leg && legCanal(leg.fromIdx, leg.toIdx);
  $("opsCanal").closest("label").hidden = !canal;
  $("opsNm").closest("label").hidden = Boolean(canal);
}

function registerNoon() {
  const ops = opsState();
  const base = ops.baseline || voyageSnapshot();
  const leg = Number($("opsLeg").value);
  const stamp = $("opsStamp").value;
  const epoch = opsDate(stamp);
  const plan = withVoyage(base);
  const selected = plan.legs[leg];
  const remaining = opsNumber($(selected?.canal ? "opsCanal" : "opsNm").value);
  const lng = opsNumber($("opsLng").value);
  const mdo = opsNumber($("opsMdo").value);
  const fo = opsNumber($("opsFo").value);
  if (!selected || ![epoch, remaining, lng, mdo, fo].every(Number.isFinite)) {
    $("opsNoonStatus").textContent = "Συμπλήρωσε χρόνο UTC, μίλια ή ώρες διέλευσης που απομένουν και τα τρία ROB.";
    return;
  }
  if (Number.isFinite(plan.depEpoch) && epoch < plan.depEpoch) {
    $("opsNoonStatus").textContent = "Η ώρα ενημέρωσης προηγείται της αρχικής αναχώρησης.";
    return;
  }
  const id = `${stamp}/${leg}`;
  ops.baseline = base;
  ops.reports = [...(ops.reports || []).filter((report) => report.id !== id),
    { id, leg, stamp, remaining, lng, mdo, fo }].sort((a, b) => a.stamp.localeCompare(b.stamp));
  ops.activeReport = id;
  renderOperationsControls();
  runScenarios();
  $("opsNoonStatus").textContent = `Καταχωρίστηκε ενημέρωση ${utcText(epoch)} για το σκέλος ${leg + 1}.`;
}

function stateFromNoon(base, report, baseline) {
  const state = opsClone(base);
  if (!report) return state;
  const [date, time] = report.stamp.split("T");
  state.depDate = date;
  state.depTime = time;
  state.depTz = 0;
  state.robLng = report.lng;
  state.robFo = report.fo;
  state.robMdo = report.mdo;
  state.legs = state.legs.slice(report.leg);
  const first = state.legs[0];
  const firstPlan = baseline.legs[report.leg];
  if (firstPlan.canal) {
    first.transitOverride = report.remaining;
    if (state.legs.length > 1) first.stopArrival = "";
  } else {
    first.distMode = "manual";
    first.manualDist = report.remaining;
    if (report.remaining === 0 && state.legs.length > 1) {
      first.stopArrival = opsIso(opsDate(report.stamp), first.stopTz ?? firstPlan.to.tz);
    }
  }
  return state;
}

function moveSlot(state, baseline, originalSlot, offset, delay) {
  if (originalSlot < offset || !delay) return true;
  const index = originalSlot - offset;
  const point = state.legs[index];
  const original = baseline.legs[originalSlot];
  if (!point || !Number.isFinite(original?.arrival)) return false;
  const zone = point.stopTz ?? original.to.tz;
  const departure = stopEpoch(point.stopDeparture, zone);
  const fallback = Number.isFinite(original.nextDeparture) ? original.nextDeparture : original.arrival;
  const currentArrival = stopEpoch(point.stopArrival, zone);
  const baseDeparture = Number.isFinite(departure) ? departure : Math.max(fallback, Number.isFinite(currentArrival) ? currentArrival : -Infinity);
  if (!point.stopArrival) point.stopArrival = opsIso(original.arrival, zone);
  point.stopDeparture = opsIso(baseDeparture + delay * HOUR, zone);
  const next = state.legs[index + 1];
  const originalCanal = baseline.legs[originalSlot + 1]?.canal;
  if (next && originalCanal) {
    next.transitOverride = originalCanal.hours;
    if (index + 1 < state.legs.length - 1) {
      next.stopArrival = opsIso(baseDeparture + (delay + originalCanal.hours) * HOUR,
        next.stopTz ?? baseline.legs[originalSlot + 1].to.tz);
    }
  }
  return true;
}

function earliestArrival(state, result, baseline, offset, maxSpeed) {
  if (!(maxSpeed > 0)) return NaN;
  let epoch = result.depEpoch;
  for (const [i, leg] of result.legs.entries()) {
    const input = state.legs[i];
    const fixedTransit = opsNumber(input.transitOverride);
    const originalTransit = baseline.legs[offset + i]?.canal?.hours;
    const hours = leg.canal ? Number.isFinite(fixedTransit) ? fixedTransit : originalTransit ?? leg.canal.hours
      : leg.dist / maxSpeed;
    if (!(hours >= 0)) return NaN;
    epoch += hours * HOUR;
    if (i === result.legs.length - 1) continue;
    const zone = input.stopTz ?? leg.to.tz;
    const leave = stopEpoch(input.stopDeparture, zone);
    if (Number.isFinite(leave)) epoch = Math.max(epoch, leave);
  }
  return epoch;
}

function compareVoyages(base, report, slot, delays, settings) {
  const baseline = withVoyage(base);
  const offset = report?.leg ?? 0;
  return delays.map((delay, i) => {
    const state = stateFromNoon(base, report, baseline);
    // Keep the reference forecast frozen while replanning with current vessel parameters.
    for (const key of [...profileKeys, "phaseCurves", "phaseModel"]) {
      if (S[key] !== undefined) state[key] = S[key];
    }
    const validSlot = moveSlot(state, baseline, slot, offset, delay);
    if (!validSlot) return { name: "ABC"[i], delay, issue: "Λείπει ώρα για το επιλεγμένο slot." };
    if (Number.isFinite(settings.open) || Number.isFinite(settings.close)) {
      const existing = baseline.etaArrEpoch;
      const target = Number.isFinite(existing)
        ? Math.min(Number.isFinite(settings.close) ? settings.close : Infinity,
          Math.max(Number.isFinite(settings.open) ? settings.open : -Infinity, existing))
        : Number.isFinite(settings.close) ? settings.close : settings.open;
      [state.arrDate, state.arrTime] = opsIso(target, state.arrTz).split("T");
      state.speedMode = "eta";
    }
    const result = withVoyage(state);
    const earliest = earliestArrival(state, result, baseline, offset, settings.max);
    const speeds = result.legs.map((leg) => leg.speed).filter(Number.isFinite);
    const peak = speeds.length ? Math.max(...speeds) : NaN;
    const overSpeed = settings.max > 0 && peak > settings.max + 1e-7;
    const beyondWindow = Number.isFinite(settings.close) && (earliest > settings.close || result.etaArrEpoch > settings.close);
    const issues = [...result.scheduleErrors];
    if (!Number.isFinite(result.etaArrEpoch) && !issues.length) issues.push("Λείπουν στοιχεία για ETA.");
    if (overSpeed) issues.push("Υπέρβαση μέγιστης ταχύτητας.");
    if (beyondWindow) issues.push("Εκτός παραθύρου άφιξης.");
    if (result.arrRobM3Margin < (settings.heel || 0)) issues.push("Ανεπαρκές heel μετά το cool-down και το margin.");
    if (result.arrFo < 0 || result.arrMdo < 0) issues.push("Ανεπαρκές απόθεμα υγρού καυσίμου.");
    if (result.rateOutsideTable) issues.push("Ταχύτητα εκτός καμπύλης κατανάλωσης.");
    if (result.phaseForecast.rows.some((row) => row.exceedsForcing)) issues.push("Υπέρβαση ορίου forced vaporization.");
    const nextLeg = result.legs.slice(Math.max(0, slot - offset + 1)).find((leg) => !leg.canal && leg.dist > 0);
    const afterSlotSpeed = slot >= offset ? nextLeg?.speed : NaN;
    return { name: "ABC"[i], delay, baseline, result, earliest, peak, afterSlotSpeed, issue: issues.join(" "), report };
  });
}

let operationsScenarios = [];

function runScenarios() {
  const ops = opsState();
  const base = ops.baseline || S;
  const report = (ops.reports || []).find((entry) => entry.id === ops.activeReport);
  const slot = $("opsSlot").value === "" ? -1 : Number($("opsSlot").value);
  const open = opsDate($("opsOpen").value);
  const close = opsDate($("opsClose").value);
  const max = opsNumber($("opsMax").value);
  const heel = opsNumber($("opsHeel").value);
  const delays = ["opsDelayA", "opsDelayB", "opsDelayC"].map((id) => opsNumber($(id).value));
  ops.settings = Object.fromEntries(scenarioIds.map((id) => [id, $(id).value]));
  const invalidDelay = ["opsDelayA", "opsDelayB", "opsDelayC"].some((id) => !$(id).checkValidity());
  const error = invalidDelay || !$("opsHeel").checkValidity() ? "Οι καθυστερήσεις και το heel πρέπει να είναι μη αρνητικά."
    : close < open ? "Το παράθυρο άφιξης κλείνει πριν ανοίξει."
    : $("opsMax").value && !(max > 0) ? "Η μέγιστη ταχύτητα πρέπει να είναι θετική."
    : "";
  $("opsScenarioStatus").textContent = error || (slot < 0 && delays.some((delay) => delay > 0)
    ? "Επίλεξε ενδιάμεσο σημείο για να δεις τα σενάρια καθυστέρησης." : "");
  operationsScenarios = error ? [] : compareVoyages(base, report, slot,
    delays.map((delay) => Number.isFinite(delay) ? delay : 0), { open, close, max, heel })
    .filter((scenario, i) => slot >= 0 || scenario.delay === 0 && i === 0);
  const pick = $("opsPick").value || "A";
  $("opsPick").innerHTML = optionsHtml(operationsScenarios.map((item) => [item.name, `Σενάριο ${item.name}`]), pick);
  $("opsTable").innerHTML = operationsScenarios.length ? tableHtml(
    ["Σενάριο / καθυστέρηση", "ETA πλάνου (UTC)", "Νωρίτερη τελική άφιξη στο όριο",
      "Μέγ. απαιτ. kn", "Μετά το slot (kn)", "Αναμονή (h)", "LNG καύσιμο (m³)", "LNG ROB (m³)", "Heel μετά margin / CD (m³)",
      "LSMGO διαθέσιμο (t)", "LSHFO διαθέσιμο (t)", "Έλεγχος"],
    operationsScenarios.map(({ name, delay, result: r, earliest, peak, afterSlotSpeed, issue }) => [
      `${name} / +${fmt(delay, 1)} h`, utcText(r?.etaArrEpoch), utcText(earliest), fmt(peak, 2), fmt(afterSlotSpeed, 2), fmt(r?.waitHours, 1),
      fmt(r?.lngM3, 1), fmt(r?.arrRobM3, 1), fmt(r?.arrRobM3Margin, 1), fmt(r?.arrMdo, 1),
      fmt(r?.arrFo, 1), issue || "Εντός των ορίων που δηλώθηκαν",
    ])
  ) : "";
  renderOpsBrief();
}

function renderOpsBrief() {
  const selected = operationsScenarios.find((item) => item.name === $("opsPick").value);
  const r = selected?.result;
  if (!r) {
    $("opsBrief").value = selected?.issue || "";
    return;
  }
  const delta = (r.etaArrEpoch - selected.baseline.etaArrEpoch) / HOUR;
  const heelDelta = r.arrRobM3 - selected.baseline.arrRobM3;
  $("opsBrief").value = [
    `VOYAGE UPDATE · Scenario ${selected.name} (+${fmt(selected.delay, 1)} h)`,
    `Destination: ${r.to.name}`,
    selected.report ? `Actuals: ${utcText(opsDate(selected.report.stamp))}, leg ${selected.report.leg + 1}; LNG ${fmt(selected.report.lng, 1)} m³ / LSMGO ${fmt(selected.report.mdo, 1)} t / LSHFO ${fmt(selected.report.fo, 1)} t` : "Basis: voyage plan",
    ...r.legs.map((leg, i) => `Leg ${i + (selected.report?.leg ?? 0) + 1} ${leg.to.name}: ${utcText(leg.arrival)}${leg.canal ? ` · transit ${fmt(leg.hours, 1)} h` : ` · ${fmt(leg.speed, 2)} kn`}${leg.waitHours > 0 ? ` · wait ${fmt(leg.waitHours, 1)} h` : ""}`),
    `Arrival ETA: ${utcText(r.etaArrEpoch)} | vs baseline: ${fmt(delta, 1)} h`,
    `Earliest final arrival at speed limit: ${utcText(selected.earliest)}`,
    `Arrival LNG ROB: ${fmt(r.arrRobM3, 1)} m³ | vs baseline: ${fmt(heelDelta, 1)} m³`,
    `LNG after margin / cool-down: ${fmt(r.arrRobM3Margin, 1)} m³ | LSMGO / LSHFO available: ${fmt(r.arrMdo, 1)} / ${fmt(r.arrFo, 1)} t`,
    selected.issue ? `Checks: ${selected.issue}` : "Within entered limits",
  ].join("\n");
}

function profileData() {
  const data = Object.fromEntries(profileKeys.filter((key) => S[key] !== undefined).map((key) => [key, S[key]]));
  return opsClone({
    ...data, phaseCurves: S.phaseCurves || {}, phaseModel: S.phaseModel || {},
    maxSpeed: $("opsMax").value, heel: $("opsHeel").value,
  });
}

function availableProfiles() {
  return store.get("vesselProfiles") || [];
}

function renderProfiles(selected) {
  const profiles = availableProfiles();
  $("opsProfiles").innerHTML = optionsHtml(
    [["", "Επίλεξε προφίλ"], ...profiles.map(({ name }, i) => [i, name])], selected ?? $("opsProfiles").value
  );
}

function persistProfile(name, data) {
  const profiles = availableProfiles();
  let index = profiles.findIndex((item) => item.name === name);
  if (index < 0) index = profiles.length;
  profiles[index] = { name, data };
  store.set("vesselProfiles", profiles);
  renderProfiles(index);
  $("opsProfileStatus").textContent = `Αποθηκεύτηκε το προφίλ «${name}».`;
}

function selectedProfile() {
  return $("opsProfiles").value === "" ? null : availableProfiles()[Number($("opsProfiles").value)];
}

function loadProfile() {
  const profile = selectedProfile();
  if (!profile) return;
  const { data } = profile;
  for (const key of profileKeys) {
    if (Object.hasOwn(data, key)) S[key] = opsClone(data[key]);
  }
  S.phaseCurves = opsClone(data.phaseCurves || {});
  S.phaseModel = opsClone(data.phaseModel || {});
  const ops = opsState();
  ops.settings = { ...ops.settings, opsMax: data.maxSpeed ?? "", opsHeel: data.heel ?? "" };
  $("opsProfileName").value = profile.name;
  syncInputs();
  render();
  $("opsProfileStatus").textContent = `Εφαρμόστηκε το προφίλ «${profile.name}».`;
}

function importProfile(file) {
  if (!file) return;
  file.text().then((text) => {
    const { kind, name, data } = JSON.parse(text);
    const validTable = (table) => Array.isArray(table) && table.every((row) => row
      && Number.isFinite(row.speed) && row.speed > 0
      && ["lng", "fo", "mdo"].every((key) => Number.isFinite(row[key]) && row[key] >= 0));
    if (kind !== "voyagecalc-vessel-profile" || typeof name !== "string" || !name.trim() || !data
        || !validTable(data.consTable)
        || ["laden", "ballast"].some((phase) => data.phaseCurves?.[phase] && !validTable(data.phaseCurves[phase]))) {
      throw new Error("Invalid profile");
    }
    persistProfile(name.trim().slice(0, 80), data);
  }).catch(() => { $("opsProfileStatus").textContent = "Μη έγκυρο αρχείο προφίλ."; });
}

function dischargeState() {
  if (!S.discharge || typeof S.discharge !== "object") S.discharge = {};
  return S.discharge;
}

function calculateDischarge(values, tanks) {
  const get = (key) => opsNumber(values[key]);
  const optional = (key) => get(key) || 0;
  const tankRows = tanks.map((tank, i) => {
    const start = opsNumber(tank.start);
    const heel = opsNumber(tank.heel);
    const min = opsNumber(tank.min);
    const max = opsNumber(tank.max);
    const warnings = [];
    if (heel > start) warnings.push("Heel πάνω από τον αρχικό όγκο");
    if (heel < min || heel > max || min > max) warnings.push("Εκτός ορίου heel");
    return { i, start, heel, warnings };
  });
  const haveTanks = tankRows.length > 0 && tankRows.every((tank) => Number.isFinite(tank.start) && Number.isFinite(tank.heel));
  const tankStart = haveTanks ? tankRows.reduce((sum, tank) => sum + tank.start, 0) : NaN;
  const tankHeel = haveTanks ? tankRows.reduce((sum, tank) => sum + tank.heel, 0) : NaN;
  const loaded = Number.isFinite(get("discLoaded")) ? get("discLoaded") : tankStart;
  const loss = optional("discLoss");
  const target = Number.isFinite(get("discHeel")) ? get("discHeel") : tankHeel;
  const volume = Number.isFinite(get("discVolume")) ? get("discVolume") : loaded - target - loss;
  const heel = loaded - volume - loss;
  const rate = get("discRate");
  const rampUp = optional("discUp");
  const rampDown = optional("discDown");
  const stripVolume = optional("discStripVolume");
  const stripTime = optional("discStripTime");
  const bulk = volume - stripVolume;
  const rampHours = rampUp + rampDown;
  const rampVolume = rate * rampHours / 2;
  const errors = [];
  if (!(rate > 0) || ![loaded, volume].every(Number.isFinite)) {
    errors.push("Χρειάζονται αρχικός όγκος, ποσότητα ή heel και θετική παροχή τερματικού.");
  } else {
    if (volume < 0 || heel < -1e-7) errors.push("Ο όγκος εκφόρτωσης, το heel και οι απώλειες πρέπει να συμφωνούν.");
    if (bulk < 0 || (stripVolume > 0 && (!(stripTime > 0) || stripVolume / stripTime > rate))) {
      errors.push("Η ποσότητα ή η παροχή του stripping ξεπερνά τα διαθέσιμα όρια.");
    }
    if (bulk < rampVolume - 1e-7) errors.push("Οι δηλωμένες ράμπες στη μέγιστη παροχή ξεπερνούν την ποσότητα κύριας εκφόρτωσης.");
  }
  const warnings = [];
  if (Number.isFinite(get("discVolume")) && Number.isFinite(target) && Math.abs(heel - target) > 0.1) {
    warnings.push("Το προβλεπόμενο heel διαφέρει από τον στόχο.");
  }
  if (haveTanks && (Math.abs(tankStart - loaded) > 0.1 || Math.abs(tankHeel - heel) > 0.1)) {
    warnings.push("Τα σύνολα των δεξαμενών διαφέρουν από το συνολικό πλάνο.");
  }
  for (const tank of tankRows) warnings.push(...tank.warnings.map((warning) => `Δεξαμενή ${tank.i + 1}: ${warning}.`));
  const fullRateHours = (bulk - rampVolume) / rate;
  const hours = errors.length ? NaN : rampHours + Math.max(0, fullRateHours) + stripTime;
  const finish = opsDate(values.discStart) + hours * HOUR;
  return { volume, heel, hours, finish, fullRateHours, tankStart, tankHeel, errors, warnings };
}

function renderTanks() {
  const tanks = dischargeState().tanks || [];
  const headings = [["start", "Αρχικός όγκος"], ["heel", "Heel"], ["min", "Min heel"], ["max", "Max heel"]];
  $("discTanks").innerHTML = "<thead><tr><th>Δεξαμενή</th>"
    + headings.map(([, label]) => `<th>${label} (m³)</th>`).join("") + "<th></th></tr></thead><tbody>"
    + tanks.map((tank, i) => `<tr><th scope="row">No. ${i + 1}</th>`
      + headings.map(([key, label]) => `<td><input type="number" step="any" min="0" aria-label="${label} δεξαμενής ${i + 1}"
        data-tank="${i}" data-quantity="${key}" value="${opsEscape(tank[key])}"></td>`).join("")
      + `<td><button type="button" class="btn small" aria-label="Διαγραφή δεξαμενής ${i + 1}" data-remove-tank="${i}">×</button></td></tr>`).join("")
    + "</tbody>";
}

function runDischarge() {
  const discharge = dischargeState();
  discharge.values = Object.fromEntries(dischargeIds.map((id) => [id, $(id).value]));
  if (!Object.values(discharge.values).some(Boolean) && !(discharge.tanks || []).length) {
    $("discStatus").textContent = "";
    $("discResult").innerHTML = "";
    return;
  }
  const invalidInput = dischargeIds.some((id) => !$(id).checkValidity())
    || [...$("discTanks").querySelectorAll("input")].some((input) => !input.checkValidity());
  if (invalidInput) {
    $("discStatus").textContent = "Έλεγξε τις καταχωρίσεις. Οι ποσότητες και οι ώρες πρέπει να είναι μη αρνητικές.";
    $("discResult").innerHTML = "";
    return;
  }
  const r = calculateDischarge(discharge.values, discharge.tanks || []);
  $("discStatus").textContent = [...r.errors, ...r.warnings].join(" ");
  $("discResult").innerHTML = r.errors.length ? "" : tableHtml(["Υπολογισμός", "Αποτέλεσμα"], [
    ["Ποσότητα εκφόρτωσης", `${fmt(r.volume, 1)} m³`], ["Προβλεπόμενο heel", `${fmt(r.heel, 1)} m³`],
    ["Ώρες στη μέγιστη παροχή", fmt(r.fullRateHours, 2)], ["Συνολική διάρκεια (h)", fmt(r.hours, 2)],
    ["Εκτιμώμενη ολοκλήρωση", utcText(r.finish)], ["Heel από ισοζύγιο δεξαμενών", `${fmt(r.tankHeel, 1)} m³`],
  ]);
}

function syncOperations() {
  const ops = opsState();
  for (const id of scenarioIds) $(id).value = ops.settings?.[id] ?? "";
  if (!ops.settings) {
    $("opsDelayA").value = "0";
    $("opsDelayB").value = "12";
    $("opsDelayC").value = "24";
  }
  $("opsStamp").value = "";
  for (const id of ["opsNm", "opsCanal", "opsLng", "opsFo", "opsMdo"]) $(id).value = "";
  for (const id of dischargeIds) $(id).value = S.discharge?.values?.[id] ?? "";
  const active = (ops.reports || []).find((report) => report.id === ops.activeReport);
  renderOperationsControls();
  $("opsLeg").value = String(active?.leg ?? 0);
  updateNoonFields();
  renderPhaseInputs();
  renderTanks();
  runDischarge();
  renderProfiles();
  syncTransferPlanner();
}

function initOperations() {
  $("opsLeg").addEventListener("change", updateNoonFields);
  $("opsBaseline").addEventListener("click", resetBaseline);
  $("opsSaveNoon").addEventListener("click", registerNoon);
  $("opsHistory").addEventListener("change", () => {
    opsState().activeReport = $("opsHistory").value;
    renderOperationsControls();
    runScenarios();
  });
  $("opsSlot").addEventListener("change", () => {
    opsState().slot = $("opsSlot").value;
    runScenarios();
  });
  $("opsCompare").addEventListener("click", runScenarios);
  for (const id of scenarioIds) $(id).addEventListener("change", runScenarios);
  $("opsPick").addEventListener("change", renderOpsBrief);
  $("opsCopy").addEventListener("click", async () => {
    const brief = $("opsBrief");
    if (!brief.value) return;
    try {
      await navigator.clipboard.writeText(brief.value);
      toast("Το update αντιγράφηκε.");
    } catch {
      brief.focus();
      brief.select();
      toast("Το κείμενο επιλέχθηκε για αντιγραφή.");
    }
  });
  $("opsDownload").addEventListener("click", () => {
    if ($("opsBrief").value) downloadFile("voyage-update.txt", $("opsBrief").value, "text/plain;charset=utf-8");
  });
  $("opsApplyModel").addEventListener("click", savePhaseModel);
  $("opsProfileSave").addEventListener("click", () => {
    const name = $("opsProfileName").value.trim();
    if (name) persistProfile(name.slice(0, 80), profileData());
    else $("opsProfileStatus").textContent = "Δώσε όνομα στο προφίλ.";
  });
  $("opsProfileLoad").addEventListener("click", loadProfile);
  $("opsProfileExport").addEventListener("click", () => {
    const saved = selectedProfile();
    const name = saved?.name || $("opsProfileName").value.trim();
    if (!name) {
      $("opsProfileStatus").textContent = "Δώσε όνομα ή επίλεξε προφίλ.";
      return;
    }
    const profile = saved || { name, data: profileData() };
    downloadFile("vessel-profile.json", JSON.stringify({ kind: "voyagecalc-vessel-profile", ...profile }, null, 2),
      "application/json");
  });
  $("opsProfileImport").addEventListener("change", (event) => {
    importProfile(event.target.files[0]);
    event.target.value = "";
  });
  $("discCompute").addEventListener("click", runDischarge);
  $("discUseForecast").addEventListener("click", () => {
    const scenario = operationsScenarios.find((item) => item.name === $("opsPick").value);
    const rob = scenario?.result?.arrRobM3 ?? compute().arrRobM3;
    if (!(rob >= 0)) {
      $("discStatus").textContent = "Χρειάζεται έγκυρο LNG ROB άφιξης.";
      return;
    }
    $("discLoaded").value = rob.toFixed(2);
    runDischarge();
  });
  for (const id of dischargeIds) $(id).addEventListener("change", runDischarge);
  $("discAddTank").addEventListener("click", () => {
    (dischargeState().tanks ??= []).push({});
    renderTanks();
    runDischarge();
  });
  $("discTanks").addEventListener("change", (event) => {
    const { tank, quantity } = event.target.dataset;
    if (tank === undefined) return;
    dischargeState().tanks[Number(tank)][quantity] = event.target.value;
    runDischarge();
  });
  $("discTanks").addEventListener("click", (event) => {
    if (event.target.dataset.removeTank === undefined) return;
    dischargeState().tanks.splice(Number(event.target.dataset.removeTank), 1);
    renderTanks();
    runDischarge();
  });
  if (location.protocol !== "file:" && "serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }
}

document.addEventListener("DOMContentLoaded", initOperations);
