"use strict";

function formNumber(value, label, min = 0) {
  const number = txNum(value);
  if (!Number.isFinite(number) || number < min) throw new Error("Έλεγξε: " + label + ".");
  return number;
}

function parseFormRows(value) {
  return String(value ?? "").trim().split(/\r?\n/).filter(line => line.trim())
    .map(line => line.split(",").map(cell => cell.trim()));
}

function loadingRampForm(config, initial, target, limit = Infinity) {
  const bulk = formNumber(config.bulk ?? 12000, "bulk rate", 1);
  const drain = formNumber(config.drain ?? 50, "drain");
  const stop = target - drain;
  if (bulk > limit || stop < initial) throw new Error("Έλεγξε το όριο παροχής, τον τελικό στόχο και το drain.");
  const hold = formNumber(config.hold ?? 5, "hold", 0.01);
  const rates = [];
  if (config.style === "pumps") {
    let before = bulk;
    const ids = new Set();
    for (const [id, rate, minutes, ...extra] of parseFormRows(config.shorePumps)) {
      const after = formNumber(rate, "νέα παροχή");
      if (!id || ids.has(id) || extra.length || after >= before || after === 0) throw new Error("Δήλωσε διαφορετικό pump ID και διαδοχικά χαμηλότερη θετική παροχή.");
      rates.push({ label: "Stop " + id, rate: after, minutes: formNumber(minutes, "hold", 0.01) });
      ids.add(id);
      before = after;
    }
    if (!rates.length) throw new Error("Πρόσθεσε τα βήματα διακοπής των αντλιών στεριάς.");
  } else {
    const step = formNumber(config.step ?? 1000, "βήμα μείωσης", 1);
    if (bulk / step > 500) throw new Error("Το βήμα μείωσης δημιουργεί πάνω από 500 στάδια.");
    for (let rate = bulk - step; rate > 0; rate -= step) rates.push({ label: "Μείωση παροχής", rate, minutes: hold });
  }
  const tailVolume = rates.reduce((sum, row) => sum + row.rate * row.minutes / 60, 0);
  const first = stop - tailVolume;
  if (first < initial) throw new Error("Ο διαθέσιμος όγκος δεν επαρκεί για το ramp-down.");
  const bulkMinutes = (first - initial) * 60 / bulk;
  const noticeOffsets = String(config.notices ?? "60,30,10").split(",").map(value => value.trim()).filter(Boolean)
    .map(value => formNumber(value, "notice", 0.01));
  const noticeTimes = [...new Set(noticeOffsets)].sort((a, b) => b - a);
  if (noticeTimes.some(value => value > bulkMinutes)) throw new Error("Το πρώτο notice προηγείται της έναρξης του bulk. Έλεγξε το ROB αναφοράς ή τα notices.");
  const rows = noticeTimes.map(value => ({ label: "Notice " + value + " min", at: bulkMinutes - value, rob: first - bulk * value / 60, rate: bulk }));
  let at = bulkMinutes;
  let rob = first;
  for (const row of rates) {
    rows.push({ ...row, at, rob });
    at += row.minutes;
    rob += row.rate * row.minutes / 60;
  }
  rows.push({ label: "Stop loading", at, rob: stop, rate: 0 });
  if (drain > 0) rows.push({ label: "Τέλος drain · " + fmt(drain, 2) + " m³", at: at + formNumber(config.drainMinutes ?? 0, "διάρκεια drain"), rob: target, rate: 0 });
  const minutes = rows.at(-1).at;
  return { rows, minutes, moved: target - initial, target };
}

function dischargeRampForm(config, tanks, pumps) {
  if (!tanks.length || !pumps.length || pumps.length > 64) throw new Error("Δήλωσε 1–64 αντλίες και τις δεξαμενές τους.");
  const targets = new Map(tanks.map(tank => [tank.id, tank.target]));
  if (targets.size !== tanks.length || new Set(pumps.map(pump => pump.id)).size !== pumps.length ||
      pumps.some(pump => !targets.has(pump.tank))) throw new Error("Έλεγξε τα μοναδικά IDs δεξαμενών και αντλιών.");
  const gap = config.timing === "window"
    ? formNumber(config.window ?? 60, "παράθυρο", 0.01) / (config.anchor === "first" ? Math.max(1, pumps.length - 1) : pumps.length)
    : formNumber(config.gap ?? 8, "διάστημα stops", 0.01);
  const lead = config.timing === "window" && config.anchor !== "first" ? gap : 0;
  const limit = formNumber(config.limit ?? 12000, "όριο εκφόρτωσης", 1);
  const fullRate = rampSum(pumps.map(pump => pump.rate));
  if (fullRate > limit) throw new Error("Το άθροισμα των παροχών αντλιών υπερβαίνει το όριο εκφόρτωσης.");
  const tail = new Map(targets);
  const stops = [];
  let activeRate = 0;
  for (let i = pumps.length - 1; i >= 0; i--) {
    const pump = pumps[i];
    stops.push({ label: "Stop " + pump.id, tank: pump.tank, tankRob: tail.get(pump.tank),
      rate: activeRate, running: pumps.length - i - 1, rob: rampSum(tail.values()), at: lead + i * gap });
    activeRate += pump.rate;
    if (i > 0 || lead) for (const online of pumps.slice(i)) {
      tail.set(online.tank, tail.get(online.tank) + online.rate * gap / 60);
    }
  }
  const bulkRates = new Map();
  for (const pump of pumps) bulkRates.set(pump.tank, (bulkRates.get(pump.tank) ?? 0) + pump.rate);
  let bulkMinutes = 0;
  const residual = new Map();
  for (const tank of tanks) {
    const remaining = tank.start - tail.get(tank.id);
    const rate = bulkRates.get(tank.id) ?? 0;
    if (remaining < -1e-7 || (remaining > 1e-7 && !rate)) throw new Error(tank.id + " · Το ROB δεν συμφωνεί με το heel και τη σειρά των stops.");
    residual.set(tank.id, Math.max(0, remaining));
    if (rate) bulkMinutes = Math.max(bulkMinutes, Math.max(0, remaining) * 60 / rate);
  }
  const available = rampSum(residual.values());
  const bulkRate = bulkMinutes ? available * 60 / bulkMinutes : 0;
  const notice = formNumber(config.dischargeNotice ?? 60, "notice εκφόρτωσης");
  const startRob = rampSum(tail.values());
  const rows = [];
  if (notice > 0 && notice <= bulkMinutes) rows.push({ label: "Notice " + notice + " min", at: bulkMinutes - notice, rob: startRob + bulkRate * notice / 60, rate: bulkRate });
  rows.push({ label: "Έναρξη ramp-down", at: bulkMinutes, rob: startRob, rate: fullRate, running: pumps.length });
  rows.push(...stops.reverse().map(row => ({ ...row, at: row.at + bulkMinutes })));
  return { rows, minutes: rows.at(-1).at, volumes: targets,
    moved: rampSum(tanks.map(tank => tank.start - tank.target)),
    note: notice > bulkMinutes ? "Το notice προηγείται της ώρας αναφοράς." : "" };
}

function formDischargeInputs(config, plan) {
  if (!plan && config.detail !== "tanks") {
    const count = formNumber(config.count ?? 7, "αριθμός αντλιών", 1);
    if (!Number.isInteger(count) || count > 64) throw new Error("Ο αριθμός αντλιών πρέπει να είναι ακέραιος από 1 έως 64.");
    const rate = formNumber(config.totalRate ?? 12000, "συνολική παροχή", 1) / count;
    return {
      tanks: [{ id: "Σύνολο", start: formNumber(config.initial ?? "", "αρχικό ROB"), target: formNumber(config.target ?? "", "heel") }],
      pumps: Array.from({ length: count }, (_, index) => ({ id: "No. " + (index + 1), tank: "Σύνολο", rate })),
    };
  }
  const tanks = plan ? plan.tanks.map(tank => ({ id: tank.id, start: formNumber(tank.start, tank.id + " ROB"), target: formNumber(tank.target, tank.id + " heel") }))
    : parseFormRows(config.tankData).map(([id, start, target, ...extra]) => {
      if (!txIdPattern.test(id) || extra.length) throw new Error("Αναμενόταν Tank ID, ROB, heel.");
      return { id, start: formNumber(start, id + " ROB"), target: formNumber(target, id + " heel") };
    });
  const pumps = parseFormRows(config.pumpData).map(([id, tank, rate, ...extra]) => {
    if (!txIdPattern.test(id) || !txIdPattern.test(tank ?? "") || extra.length) throw new Error("Αναμενόταν Pump ID, Tank ID, παροχή.");
    return { id, tank, rate: formNumber(rate, id + " παροχή", 1) };
  });
  return { tanks, pumps };
}

function linkedRampForm(plan, mode) {
  const config = plan.form ?? {};
  const checked = calibratedTransferPlan(plan, mode);
  for (const tank of checked.tanks) {
    const start = formNumber(tank.start, tank.id + " ROB");
    const target = formNumber(tank.target, tank.id + " στόχος");
    if (Math.min(start, target) < (txNum(tank.min) || 0) ||
        Math.max(start, target) > txRateCeiling(tank.max) || (mode === "loading" ? target < start : target > start)) {
      throw new Error(tank.id + " · Έλεγξε κατεύθυνση και όρια ROB.");
    }
  }
  const limit = Math.min(...["terminal", "manifold", "vapour"].map(key => txRateCeiling(plan[key])));
  if (mode === "unloading") {
    const { tanks, pumps } = formDischargeInputs(config, plan);
    return dischargeRampForm({ ...config, limit: Math.min(limit, formNumber(config.limit ?? 12000, "όριο εκφόρτωσης", 1)) }, tanks, pumps);
  }
  const target = rampSum(checked.tanks.map(tank => txNum(tank.target)));
  const result = loadingRampForm(config, rampSum(checked.tanks.map(tank => txNum(tank.start))), target, limit);
  const drainTank = checked.tanks.find(tank => tank.id === config.drainTank);
  const drain = formNumber(config.drain ?? 50, "drain");
  if (drain > 0 && (!drainTank || txNum(drainTank.target) - txNum(drainTank.start) < drain)) {
    throw new Error("Δήλωσε έγκυρο tank υποδοχής του drain στη φόρμα φόρτωσης.");
  }
  return { ...result, volumes: new Map(checked.tanks.map(tank => [tank.id, txNum(tank.target)])) };
}

const rampFormDefaults = {
  bulk:12000, drain:50, drainMinutes:0, hold:5, step:1000, notices:"60,30,10", style:"thousands",
  detail:"total", count:7, totalRate:12000, limit:12000, timing:"gap", gap:8, window:60, anchor:"first", dischargeNotice:60,
};

function renderRampForms(sync = false) {
  const panel = $("rampForms");
  if (!panel?.open) return;
  const plan = transferPlan();
  const loading = S.transfer.mode !== "unloading";
  const config = { ...rampFormDefaults, ...plan.form };
  if (sync) for (const input of panel.querySelectorAll("[data-form]")) {
    input.value = config[input.dataset.form] ?? "";
  }
  $("formLoading").hidden = !loading;
  $("formUnloading").hidden = loading;
  $("formShorePumps").hidden = config.style !== "pumps";
  $("formAggregate").hidden = config.detail === "tanks" || config.linked === "plan";
  $("formTankData").hidden = config.detail !== "tanks" || config.linked === "plan";
  $("formPumpData").hidden = config.detail !== "tanks" && config.linked !== "plan";
  $("formManualVolumes").hidden = config.linked === "plan" || (!loading && config.detail === "tanks");
  $("formDrainTank").hidden = !loading || config.linked !== "plan";
  $("formGap").hidden = config.timing === "window";
  $("formWindow").hidden = config.timing !== "window";
  $("formAnchor").hidden = config.timing !== "window";
  $("formRows").innerHTML = "";
  $("formBars").innerHTML = "";
  $("formStatus").textContent = "";
  try {
    let result;
    if (config.linked === "plan") result = linkedRampForm(plan, loading ? "loading" : "unloading");
    else if (loading) result = loadingRampForm(config, formNumber(config.initial ?? "", "ROB αναφοράς"), formNumber(config.target ?? "", "τελικός στόχος"));
    else {
      const { tanks, pumps } = formDischargeInputs(config);
      result = dischargeRampForm(config, tanks, pumps);
    }
    const levelModel = !loading && config.linked === "plan" ? rampModel(plan, plan.guided ?? {}, false, "unloading") : null;
    const epoch = opsDate(config.reference || plan.start);
    const headers = ["Ενέργεια", "Ώρα UTC / από αναφορά", "Q.O.B. (m³)", "Νέα παροχή (m³/h)"];
    headers.push(...(loading ? ["Μέχρι τελικό στόχο (m³)", "Όγκος μέχρι επόμενο βήμα (m³)"]
      : ["Tank", "Tank ROB (m³)", "Στάθμη (m)", "Αντλίες online", "Μέχρι τελικό heel (m³)"]));
    const rows = result.rows.map((row, i) => {
      const common = [row.label, rampEventTime(epoch, row.at), fmt(row.rob, 2), fmt(row.rate, 2)];
      if (loading) return [...common, fmt(result.target - row.rob, 2), fmt((result.rows[i + 1]?.rob ?? row.rob) - row.rob, 2)];
      const combined = row.tank === "Σύνολο";
      const level = row.tank && !combined
        ? levelModel?.interpolateLevel(row.tank, row.tankRob, 1)
        : null;
      return [...common, row.tank ? cargoTankLabel(row.tank) : "—", fmt(row.tankRob, 2), fmt(level, 3),
        row.running ?? "—", fmt(row.rob - result.rows.at(-1).rob, 2)];
    });
    $("formRows").innerHTML = tableHtml(headers, rows);
    const chartStages = result.rows.slice(0, -1).flatMap((row, i) => {
      const next = result.rows[i + 1];
      if (next.at <= row.at) return [];
      const tag = loading ? "Shore" : "Ship";
      return [{ from:row.at, to:next.at, ends:[row.rate,row.rate], tankRates:new Map([[tag,[row.rate,row.rate]]]) }];
    });
    if (chartStages.length) $("formBars").innerHTML = rampChart({ stages:chartStages, events:result.rows.map(row => ({ ...row, name:row.label, tank:true })) }, "all");
    $("formStatus").textContent = result.note || "Διάρκεια από την αναφορά " + rampClock(result.minutes).slice(1) + " · " + fmt(result.moved, 2) + " m³";
  } catch (error) {
    $("formRows").innerHTML = "";
    $("formBars").innerHTML = "";
    $("formStatus").textContent = error.message;
  }
}

document.addEventListener("DOMContentLoaded", () => {
  const panel = $("rampForms");
  if (!panel) return;
  panel.addEventListener("toggle", () => renderRampForms(true));
  panel.addEventListener("input", event => {
    const key = event.target.dataset.form;
    if (!key) return;
    (transferPlan().form ??= {})[key] = event.target.value;
    renderRampForms();
    if (typeof renderLinkedVoyage === "function") renderLinkedVoyage();
  });
  $("transferPlanner").addEventListener("change", event => {
    if (!event.target.closest("#rampForms")) renderRampForms(event.target.id === "transferMode");
  });
});
