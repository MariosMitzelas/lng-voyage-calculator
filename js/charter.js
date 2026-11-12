"use strict";

const charterModes = { load: "Loading", discharge: "Discharge", idle: "Idle", frs: "Idle με FRS", inert: "Inert gas generation" };
const charterFlags = {
  laden: "Χρήση καμπύλης Laden", ballast: "Χρήση καμπύλης Ballast", fixedFoe: "Συμβατικός FOE ανά m³ (f)",
  winter: "Ice & Winterization", port: "Υπολογισμοί λιμένα", bogLaden: "Όριο Boil-Off Laden (g–h)",
  bogBallast: "Όριο Boil-Off Ballast (i–j)", reload: "Reload / conditioning (k)",
  weather: "Έλεγχος καιρού ανά noon-to-noon (l)", review: "Υπενθύμιση αναθεώρησης πίνακα",
};
const charterPositive = value => Number.isFinite(value) && value > 0;
const charterNonnegative = value => Number.isFinite(value) && value >= 0;

function validCharterParty(cp) {
  if (!cp || cp.version !== 1 || !Array.isArray(cp.sea) || cp.sea.length < 2 || cp.sea.length > 150
      || !cp.sea.every(row => Array.isArray(row) && row.length === 5 && row.every(charterNonnegative) && row[0] > 0)
      || new Set(cp.sea.map(row => row[0])).size !== cp.sea.length
      || !["lng", "lsgo", "hfo"].every(key => charterPositive(cp.lhv?.[key]))
      || !Object.keys(charterModes).every(key => charterNonnegative(cp.port?.[key]))
      || !["ladenActive", "ladenPassive", "ballastActive", "ballastPassive"].every(key => charterNonnegative(cp.bog?.[key]))) return false;
  return charterPositive(cp.fixedFoe) && charterNonnegative(cp.winter?.lsgo) && Number.isFinite(cp.winter?.threshold)
    && Number.isFinite(cp.reloadThreshold) && charterNonnegative(cp.weather?.force) && charterNonnegative(cp.weather?.hours)
    && Number.isInteger(cp.reviewMonths) && cp.reviewMonths > 0 && cp.reviewMonths <= 120;
}

function charterEnabled(cp, key) {
  return cp?.options?.[key] === true;
}

function charterDensity(state) {
  return positiveNumber(optionalNumber(state.charterParty?.inputs?.density), positiveNumber(state.density, DEFAULTS.density));
}

function charterSeaValues(cp, row, phase, density) {
  const column = phase === "ballast" ? 3 : 1;
  const eq = row[column];
  const pilot = row[column + 1];
  const treatment = cp.inputs?.pilotTreatment;
  const tonnes = Math.max(0, eq - (treatment === "included" ? pilot : 0)) * cp.lhv.lsgo / cp.lhv.lng;
  return { speed: row[0], lng: tonnes / density, tonnes, density, fo: 0,
    mdo: ["included", "additional"].includes(treatment) ? pilot : 0, eq, pilot };
}

function charterSeaRate(state, phase, speed) {
  const cp = state.charterParty;
  if (!validCharterParty(cp) || !charterEnabled(cp, phase)) return null;
  const density = charterDensity(state);
  const curve = cp.sea.map(row => {
    const { speed, lng, fo, mdo } = charterSeaValues(cp, row, phase, density);
    return { speed, lng, fo, mdo, density };
  });
  return { ...interpolate(curve, speed, state), charter: true };
}

function charterPortRate(state, legIndex) {
  const cp = state.charterParty;
  if (!validCharterParty(cp) || !charterEnabled(cp, "port")) return null;
  const selected = state.legs[legIndex]?.charterPort;
  const eq = cp.port[selected?.mode];
  if (!Object.hasOwn(charterModes, selected?.mode) || !["lng", "lsgo"].includes(selected?.fuel)) return null;
  const density = charterDensity(state);
  return selected.fuel === "lng" ? { lng: eq * cp.lhv.lsgo / cp.lhv.lng / density, fo: 0, mdo: 0, density }
    : { lng: 0, fo: 0, mdo: eq, density };
}

function charterWinter(state, kind) {
  const cp = state.charterParty;
  const temperature = optionalNumber(cp?.inputs?.ambient);
  return validCharterParty(cp) && charterEnabled(cp, "winter") && kind !== "canal" && Number.isFinite(temperature)
    && temperature <= cp.winter.threshold ? cp.winter.lsgo : 0;
}

function charterFoe(cp, phaseForecast) {
  const rows = phaseForecast.rows;
  if (!validCharterParty(cp) || !rows.length || !(charterEnabled(cp, "fixedFoe") || rows.some(row => row.charter))) return null;
  const thermal = cp.lhv.lng / cp.lhv.lsgo;
  const fixed = charterEnabled(cp, "fixedFoe");
  const lng = rows.reduce((sum, row) => sum + (fixed ? row.demand * cp.fixedFoe : row.lngT * thermal), 0);
  const total = lng + phaseForecast.foT * cp.lhv.hfo / cp.lhv.lsgo + phaseForecast.mdoT;
  return { lng, total, factor: fixed ? cp.fixedFoe : thermal, fixed };
}

function charterRules(state, legs) {
  const cp = state.charterParty;
  const input = cp.inputs || {};
  const rows = [];
  const add = (label, value) => rows.push([label, value]);
  const capacity = positiveNumber(state.capacity, NaN);
  for (const phase of ["laden", "ballast"]) {
    if (!charterEnabled(cp, phase === "laden" ? "bogLaden" : "bogBallast")) continue;
    const mode = input[phase + "BogMode"] === "active" ? "Active" : input[phase + "BogMode"] === "passive" ? "Passive" : "";
    let basis = capacity;
    if (phase === "laden" && input.ladenPartial) {
      const cargo = optionalNumber(input.cargoLoaded);
      basis = cargo > 0 && cargo <= capacity ? cargo : NaN;
    }
    if (phase === "ballast" && input.ballastPartial) {
      const used = optionalNumber(input.tanksUsed);
      const total = optionalNumber(input.tanksTotal);
      basis = Number.isInteger(used) && Number.isInteger(total) && used >= 1 && total >= used ? capacity * used / total : NaN;
    }
    const days = legs.reduce((sum, leg, i) => sum + (!leg.canal &&
      (state.legs[i].phase === "ballast" ? "ballast" : "laden") === phase ? leg.hours / 24 : 0), 0);
    const daily = mode ? basis * cp.bog[phase + mode] / 100 : NaN;
    const label = "Συμβατικό μέγιστο BOG " + phase;
    if (!mode || !Number.isFinite(daily)) add(label, "Απαιτούνται Active/Passive, cargo capacity και στοιχεία αναλογίας όπου ισχύει.");
    else add(label, mode + " · " + fmt(daily, 2) + " m³/ημ" +
      (days > 0 ? " · " + fmt(daily * days, 2) + " m³ για " + fmt(days, 2) + " ημέρες πλεύσης" : ""));
  }
  if (charterEnabled(cp, "reload")) {
    const temperature = optionalNumber(input.cargoTemp);
    add("Εγγυήσεις BOG μετά από reload", !Number.isFinite(temperature) ? "Καταχώρισε την τρέχουσα μέση θερμοκρασία LNG."
      : temperature > cp.reloadThreshold ? "Εξαίρεση BOG κατά (k) · φορτίο θερμότερο από το όριο." : "Το θερμοκρασιακό κριτήριο εξαίρεσης (k) δεν ενεργοποιείται.");
    if (input.conditioning) add("Forced BOG για conditioning", "Κατανομή κόστους κατά (k): " + (cp.conditioningCost || "βλ. όρο προφίλ"));
  }
  if (charterEnabled(cp, "weather")) {
    const hours = optionalNumber(input.weatherHours);
    add("Έλεγχος εγγυήσεων καιρού για την περίοδο", !Number.isFinite(hours) || hours < 0 || hours > 24 ?
      "Καταχώρισε ώρες πάνω από το όριο Beaufort, από 0 έως 24."
      : hours > cp.weather.hours ? "Ενεργοποιείται η εξαίρεση ταχύτητας, κατανάλωσης και BOG κατά (l)."
      : "Το κριτήριο εξαίρεσης (l) δεν ενεργοποιείται.");
  }
  if (charterEnabled(cp, "review")) {
    const delivery = /^\d{4}-\d{2}-\d{2}$/.test(input.delivery || "") ? new Date(input.delivery + "T00:00:00Z") : null;
    if (delivery && Number.isFinite(delivery.getTime())) {
      const day = delivery.getUTCDate();
      delivery.setUTCDate(1);
      delivery.setUTCMonth(delivery.getUTCMonth() + cp.reviewMonths);
      const end = new Date(Date.UTC(delivery.getUTCFullYear(), delivery.getUTCMonth() + 1, 0)).getUTCDate();
      delivery.setUTCDate(Math.min(day, end));
      add("Αναθεώρηση πίνακα", delivery.toISOString().slice(0, 10));
    } else add("Αναθεώρηση πίνακα", "Καταχώρισε ημερομηνία παράδοσης.");
  }
  return rows;
}

function charterPortPlan(cp) {
  const winter = charterWinter({ charterParty: cp }, "wait");
  return Object.keys(charterModes).flatMap(mode => {
    const entry = cp.inputs?.portPlan?.[mode];
    const hours = optionalNumber(entry?.hours);
    return entry?.enabled && hours >= 0 && Number.isFinite(hours)
      ? [[charterModes[mode], hours, (cp.port[mode] + winter) * hours / 24]] : [];
  });
}

function renderCharterParty(result) {
  if (!$("cpPanel")) return;
  const cp = S.charterParty;
  const valid = validCharterParty(cp);
  $("cpContent").hidden = !valid;
  $("cpProfileState").textContent = valid ? "Ενεργό προφίλ Charter Party στο ταξίδι." : "Εισήγαγε το ιδιωτικό προφίλ JSON για να εμφανιστούν οι συμβατικές τιμές.";
  if (!valid) return;
  const density = charterDensity(S);
  $("cpOptions").innerHTML = Object.entries(charterFlags).map(([key, label]) =>
    `<label><input type="checkbox" data-cp-flag="${key}" ${charterEnabled(cp, key) ? "checked" : ""}> ${label}</label>`).join("");
  $("cpCurve").innerHTML = tableHtml(["kn", "Laden LSGO-eq t/ημ", "Laden pilot t/ημ", "Laden LNG t/ημ", "Laden LNG m³/ημ",
    "Ballast LSGO-eq t/ημ", "Ballast pilot t/ημ", "Ballast LNG t/ημ", "Ballast LNG m³/ημ", "Density t/m³"],
    cp.sea.map(row => {
      const l = charterSeaValues(cp, row, "laden", density);
      const b = charterSeaValues(cp, row, "ballast", density);
      return [fmt(row[0], 1), fmt(l.eq, 1), fmt(l.pilot, 1), fmt(l.tonnes, 2), fmt(l.lng, 2),
        fmt(b.eq, 1), fmt(b.pilot, 1), fmt(b.tonnes, 2), fmt(b.lng, 2), fmt(density, 3)];
    }));
  const input = cp.inputs || {};
  const value = key => opsEscape(input[key] ?? "");
  const field = (key, label, attrs = 'type="number" step="any"') =>
    `<label class="field">${opsEscape(label)}<input data-cp-input="${key}" ${attrs} value="${value(key)}"></label>`;
  const select = (key, label, choices) =>
    `<label class="field">${opsEscape(label)}<select data-cp-input="${key}">${optionsHtml(choices, input[key] ?? "")}</select></label>`;
  const flag = (key, label) =>
    `<label><input type="checkbox" data-cp-input="${key}" ${input[key] ? "checked" : ""}> ${opsEscape(label)}</label>`;
  const options = [["", "Επίλεξε"], ["active", "Active"], ["passive", "Passive"]];
  $("cpInputs").innerHTML = [
    field("density", "Πυκνότητα LNG t/m³ · κενό για LNG & Bunkers", 'type="number" min="0.001" step="any"'),
    select("pilotTreatment", "Χειρισμός pilot", [["", "Εμφάνιση χωριστά · χωρίς προσθήκη"], ["additional", "Pilot επιπλέον του LSGO-equivalent"], ["included", "Pilot ήδη μέσα στο LSGO-equivalent"]]),
    charterEnabled(cp, "winter") ? field("ambient", "Θερμοκρασία περιβάλλοντος °C για το πλάνο") : "",
    charterEnabled(cp, "bogLaden") ? select("ladenBogMode", "BOG Laden", options) + flag("ladenPartial", "Δεν χρησιμοποιήθηκαν όλα τα tanks") +
      (input.ladenPartial ? field("cargoLoaded", "Όγκος φορτίου που φορτώθηκε m³") : "") : "",
    charterEnabled(cp, "bogBallast") ? select("ballastBogMode", "BOG Ballast", options) + flag("ballastPartial", "Μερική χρήση tanks στον προηγούμενο laden πλου") +
      (input.ballastPartial ? field("tanksUsed", "Tanks που χρησιμοποιήθηκαν", 'type="number" min="1" step="1"') +
        field("tanksTotal", "Συνολικά tanks", 'type="number" min="1" step="1"') : "") : "",
    charterEnabled(cp, "reload") ? field("cargoTemp", "Μέση θερμοκρασία LNG μετά από reload °C") +
      flag("conditioning", "Απαιτήθηκε conditioning λόγω reload για ασφάλεια ή κατόπιν αιτήματος Charterers") : "",
    charterEnabled(cp, "weather") ? field("weatherHours", "Ώρες πάνω από Bft " + cp.weather.force + " στο επιλεγμένο noon-to-noon",
      'type="number" min="0" max="24" step="any"') : "",
    charterEnabled(cp, "review") ? field("delivery", "Ημερομηνία παράδοσης", 'type="date"') : "",
  ].join("");
  $("cpNotes").innerHTML = tableHtml(["Όρος", "Τιμή ή κανόνας"], [
    ["Πεδίο κατανάλωσης", cp.scopeNote ?? ""],
    ["LHV (kJ/kg)", "LNG " + fmt(cp.lhv.lng) + " · LSGO " + fmt(cp.lhv.lsgo) + " · HFO " + fmt(cp.lhv.hfo)],
    ["(f) Συμβατικός συντελεστής", fmt(cp.fixedFoe, 3) + " t FO ανά m³ LNG. " + (cp.factorNote ?? "")],
    ["Ice & Winterization", "+" + fmt(cp.winter.lsgo) + " t LSGO/ημ σε λιμένα, laden ή ballast σε θερμοκρασία ≤ " + fmt(cp.winter.threshold, 1) + " °C. Μία θερμοκρασία σεναρίου για το πλάνο."],
    ["(g–h) Laden BOG", fmt(cp.bog.ladenActive, 3) + "% active · " + fmt(cp.bog.ladenPassive, 3) + "% passive ανά ημέρα επί cargo capacity. Σε χρήση μέρους των tanks, αναλογία φορτωμένου όγκου προς χωρητικότητα."],
    ["(i–j) Ballast BOG", fmt(cp.bog.ballastActive, 3) + "% active · " + fmt(cp.bog.ballastPassive, 3) + "% passive ανά ημέρα επί cargo capacity. Για προηγούμενο laden με μέρος των tanks, αναλογία αριθμού tanks."],
    ["(k) Reload", (cp.reloadNote ?? "") + " Όριο " + fmt(cp.reloadThreshold, 1) + " °C."],
    ["(l) Καιρός", "Εξαίρεση εγγυήσεων ταχύτητας, κατανάλωσης και BOG για πάνω από " + fmt(cp.weather.hours) + " h με άνεμο πάνω από Bft " + fmt(cp.weather.force) + " ανά noon-to-noon."],
    ["Αναθεώρηση", fmt(cp.reviewMonths) + " μήνες μετά την παράδοση. " + (cp.reviewNote ?? "")],
  ]);
  const ruleRows = charterRules(S, result.legs);
  $("cpRules").innerHTML = ruleRows.length ? tableHtml(["Έλεγχος", "Αποτέλεσμα"], ruleRows) : "";
  $("cpPorts").innerHTML = Object.entries(charterModes).map(([key, label]) => {
    const entry = input.portPlan?.[key] || {};
    return `<div class="field"><label><input type="checkbox" data-cp-port="${key}" data-cp-key="enabled" ${entry.enabled ? "checked" : ""}>
      ${label} · ${fmt(cp.port[key], 1)} t LSGO-eq/ημ</label>
      ${charterEnabled(cp, "port") && entry.enabled ? `<label>Ώρες <input type="number" min="0" step="any" data-cp-port="${key}" data-cp-key="hours" value="${opsEscape(entry.hours ?? "")}"></label>` : ""}</div>`;
  }).join("");
  const portPlan = charterEnabled(cp, "port") ? charterPortPlan(cp) : [];
  $("cpPortResult").textContent = portPlan.length ? "Χωριστή εκτίμηση λιμένα: " +
    fmt(portPlan.reduce((sum, row) => sum + row[2], 0), 2) + " t LSGO-eq." +
    (charterWinter(S, "wait") > 0 ? " Περιλαμβάνει το ενεργό Ice & Winterization." : "") : "";
  $("cpStops").innerHTML = charterEnabled(cp, "port") ? result.legs.map((leg, i) => {
    if (!(leg.waitHours > 0) || leg.canal) return "";
    const stop = S.legs[i]?.charterPort || {};
    return `<div class="grid-form"><strong>Σκέλος ${i + 1} · αναμονή ${fmt(leg.waitHours, 1)} h</strong>
      <label class="field">Λειτουργία<select data-cp-stop="${i}" data-cp-key="mode">${optionsHtml([["", "Χειροκίνητο μοντέλο"], ...Object.entries(charterModes)], stop.mode ?? "")}</select></label>
      <label class="field">Καύσιμο<select data-cp-stop="${i}" data-cp-key="fuel">${optionsHtml([["", "Επίλεξε βάση καυσίμου"], ["lng", "LNG"], ["lsgo", "LSGO"]], stop.fuel ?? "")}</select></label></div>`;
  }).join("") : "";
}

document.addEventListener("DOMContentLoaded", () => {
  $("cpImport").addEventListener("change", event => {
    importProfile(event.target.files[0], { activateCharter: true });
    event.target.value = "";
  });
  $("cpPanel").addEventListener("change", event => {
    const cp = S.charterParty;
    if (!validCharterParty(cp)) return;
    const el = event.target;
    const { cpFlag, cpInput, cpPort, cpStop, cpKey } = el.dataset;
    const input = cp.inputs ??= {};
    const value = el.type === "checkbox" ? el.checked : el.value;
    if (cpFlag) (cp.options ??= {})[cpFlag] = value;
    else if (cpInput) input[cpInput] = value;
    else if (cpPort) ((input.portPlan ??= {})[cpPort] ??= {})[cpKey] = value;
    else if (cpStop !== undefined && S.legs[cpStop]) (S.legs[cpStop].charterPort ??= {})[cpKey] = value;
    else return;
    render();
  });
});
