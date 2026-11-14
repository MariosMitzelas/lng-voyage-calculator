/* ============================================================
   LNG Voyage Calculator — Λογική εφαρμογής
   Υπολογισμοί: απόσταση, ώρες ζωνών, ταχύτητα, καταναλώσεις,
   FOE, ROB αναχώρησης/άφιξης, safety margin, cool-down, max intake.
   ============================================================ */

"use strict";

/* ---------- Βοηθητικά ---------- */
const $ = (id) => document.getElementById(id);
const fmt = (n, d = 0) =>
  Number.isFinite(n) ? n.toLocaleString("el-GR", { minimumFractionDigits: d, maximumFractionDigits: d }) : "—";
const num = (v) => { const n = parseFloat(String(v).replace(",", ".")); return Number.isFinite(n) ? n : NaN; };

/* Ασφαλής αποθήκευση (persistent όπου διαθέσιμη, αλλιώς σε μνήμη) */
const store = (() => {
  let mem = {};
  let ok = false;
  let ls = null;
  try {
    ls = window["local" + "Storage"];
    ls.setItem("__t", "1");
    ls.removeItem("__t");
    ok = true;
  } catch (e) { ok = false; }
  return {
    ok,
    get(k) {
      try {
        if (ok) { const v = ls.getItem(k); return v == null ? (mem[k] ?? null) : JSON.parse(v); }
        return mem[k] ?? null;
      } catch (e) { return mem[k] ?? null; }
    },
    set(k, v) { try { if (ok) ls.setItem(k, JSON.stringify(v)); else mem[k] = v; } catch (e) { mem[k] = v; } },
    del(k) { try { if (ok) ls.removeItem(k); else delete mem[k]; } catch (e) { delete mem[k]; } },
  };
})();

function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove("show"), 2600);
}

/* ---------- Great-circle απόσταση (ναυτικά μίλια) ---------- */
function gcDistanceNm(lat1, lon1, lat2, lon2) {
  const R = 3440.065; // μίλια
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/* ---------- Παράμετροι εμπειρίας (defaults, όλα επεξεργάσιμα) ---------- */
const DEFAULTS = {
  // Ταξίδι — σκέλη πλόου (πόρτες → πόρτες, με διώρυγες)
  legs: [
    { fromIdx: 0, toIdx: 44, distMode: "gc", manualDist: 5000 },
  ],
  routingFactor: 1.04, suezHours: 14, panamaHours: 12,
  depDate: "", depTime: "12:00", depTz: 3, arrDate: "", arrTime: "12:00", arrTz: 1,
  speedMode: "eta", serviceSpeed: 16.5,
  // Καταναλώσεις
  consTable: [
    { speed: 10,   lng: 130, fo: 0,   mdo: 2.0 },
    { speed: 13,   lng: 210, fo: 0,   mdo: 2.4 },
    { speed: 15,   lng: 290, fo: 0,   mdo: 2.8 },
    { speed: 17.5, lng: 390, fo: 0,   mdo: 3.4 },
    { speed: 19.5, lng: 480, fo: 0,   mdo: 4.0 },
  ],
  // Πλοίο / φορτία
  density: 0.45, capacity: 174000, fillPct: 98.5,
  marginMode: "pct", marginPct: 10, marginAmount: "", coolTanks: 150, coolLine: 30,
  cvLNG: 12430, cvFOE: 11500,
  // ROB αναχώρησης
  robLng: 4000, robFo: 800, robMdo: 400,
  analysis: {},
};

let S = JSON.parse(JSON.stringify(DEFAULTS));

/* Μετατροπή παλαιότερων αποθηκευμένων μορφών στην τρέχουσα δομή */
function migrateState(s) {
  const d = Object.assign(JSON.parse(JSON.stringify(DEFAULTS)), s);
  if (!Array.isArray(s.legs)) {
    d.legs = [{ fromIdx: s.fromIdx ?? 0, toIdx: s.toIdx ?? 35, distMode: s.distMode ?? "gc", manualDist: s.manualDist ?? 5000 }];
  }
  if (!d.analysis || typeof d.analysis !== "object") d.analysis = {};
  if (s.marginPct === null) d.marginPct = "";
  if (!Number.isFinite(s.suezHours)) d.suezHours = 14;
  if (!Number.isFinite(s.panamaHours)) d.panamaHours = 12;
  return d;
}

/* ---------- Τοπική ώρα -> UTC epoch ---------- */
function localToEpoch(dateStr, timeStr, tzHours) {
  if (!dateStr || !timeStr) return NaN;
  const [y, m, d] = dateStr.split("-").map(Number);
  const [hh, mm] = timeStr.split(":").map(Number);
  return Date.UTC(y, m - 1, d, hh, mm) - tzHours * 3600 * 1000;
}

/* ---------- Πυκνότητα, μετατροπές και καμπύλη καταναλώσεων ---------- */
const positiveNumber = (value, fallback) => Number.isFinite(value) && value > 0 ? value : fallback;

function lngConversions(row, state = S) {
  const density = positiveNumber(row.density, positiveNumber(state.density, DEFAULTS.density));
  const factor = state.cvLNG / state.cvFOE;
  const entered = row.lngInput ?? row.lng;
  const tonnes = row.lngUnit === "t" ? entered : row.lngUnit === "foe" ? entered / factor : entered * density;
  const volume = row.lngUnit === "t" || row.lngUnit === "foe" ? tonnes / density : entered;
  return { density, volume, tonnes, foe: tonnes * factor };
}

function interpolate(table, speed, state = S) {
  const t = table.filter(row => row.speed > 0).map(row => {
    const { density, volume, tonnes } = lngConversions(row, state);
    return { speed: row.speed, lng: volume, tonnes, density, fo: row.fo, mdo: row.mdo };
  }).sort((a, b) => a.speed - b.speed);
  if (!t.length) return null;
  if (speed <= t[0].speed) return { ...t[0], extrapolated: speed < t[0].speed };
  if (speed >= t.at(-1).speed) return { ...t.at(-1), extrapolated: speed > t.at(-1).speed };
  const i = t.findIndex(row => row.speed >= speed);
  const [a, b] = [t[i - 1], t[i]];
  const fraction = (speed - a.speed) / (b.speed - a.speed);
  const mix = (key) => a[key] + fraction * (b[key] - a[key]);
  const lng = mix("lng");
  const tonnes = mix("tonnes");
  return { speed, lng, tonnes, density: lng > 0 ? tonnes / lng : mix("density"), fo: mix("fo"), mdo: mix("mdo"),
    extrapolated: false };
}

const HOUR = 3600000;
const optionalNumber = (value) => value === "" || value == null ? NaN : num(value);
const utcText = (epoch) => Number.isFinite(epoch)
  ? new Date(epoch).toLocaleString("el-GR", { timeZone: "UTC", dateStyle: "medium", timeStyle: "short" }) + " UTC"
  : "—";

function stopEpoch(value, offset) {
  const [date, time] = (typeof value === "string" ? value : "").split("T");
  return localToEpoch(date, time, offset);
}

function planLegs(legs, start, finalTarget) {
  const errors = [];
  let blockStart = 0;
  let departure = start;
  const hourTolerance = 30 / 3600; // Timestamp inputs have minute precision.

  for (const [i, leg] of legs.entries()) {
    const last = i === legs.length - 1;
    const input = S.legs[i];
    const offset = input.stopTz ?? (last ? S.arrTz : leg.to.tz);
    const localArrival = stopEpoch(input.stopArrival, offset);
    const arrive = Number.isFinite(localArrival) ? localArrival : last ? finalTarget : NaN;
    const leave = stopEpoch(input.stopDeparture, offset);
    const hasArrival = Number.isFinite(arrive);
    const target = hasArrival ? arrive : last ? NaN : leave;
    const anchored = Number.isFinite(target);
    if (!last && !anchored) continue;

    const block = legs.slice(blockStart, i + 1);
    const fixedSpeed = (entry, index) => entry.canal ? NaN : optionalNumber(S.legs[blockStart + index].speedOverride);
    const fixed = block.map(fixedSpeed);
    const preceding = S.legs[i - 1];
    const fixedEntry = i === 0 || Boolean(preceding?.stopDeparture || preceding?.stopArrival);
    if (leg.canal && block.length === 1 && fixedEntry && hasArrival && Number.isFinite(departure)
        && !Number.isFinite(optionalNumber(input.transitOverride)) && (!last || i > 0 || input.stopArrival)) {
      leg.canal.hours = (arrive - departure) / HOUR;
    }
    const invalidSpeed = block.some((entry, j) => !entry.canal && ![undefined, null, ""].includes(S.legs[blockStart + j].speedOverride)
      && !(fixed[j] > 0));
    const fixedHours = block.reduce((sum, entry, j) => sum + (entry.canal?.hours ?? (fixed[j] > 0 ? entry.dist / fixed[j] : 0)), 0);
    const flexibleDistance = block.reduce((sum, entry, j) => sum + (!entry.canal && !(fixed[j] > 0) ? entry.dist : 0), 0);
    const available = (target - departure) / HOUR - fixedHours;
    const fallback = S.speedMode === "speed" ? S.serviceSpeed : NaN;
    const useFallback = !anchored || (!hasArrival && fallback > 0);
    const inferred = useFallback ? fallback : flexibleDistance > 0 ? flexibleDistance / available : NaN;
    const flexibleHours = flexibleDistance > 0 ? flexibleDistance / inferred : 0;
    const hasFixedSea = fixed.some(value => value > 0);
    const strictArrival = hasArrival && (hasFixedSea || flexibleDistance > 0 ||
      (leg.canal && fixedEntry && (!last || i > 0 || input.stopArrival)) || Boolean(input.stopArrival));
    const mismatch = anchored && Number.isFinite(departure) &&
      (available < flexibleHours - hourTolerance || (strictArrival && Math.abs(available - flexibleHours) > hourTolerance));
    const invalid = invalidSpeed || mismatch || block.some(entry => entry.canal && !(entry.canal.hours >= 0)) ||
      (flexibleDistance > 0 && Number.isFinite(departure) && (anchored || S.speedMode === "speed") && !(inferred > 0));
    if (invalid) errors.push(`Σκέλος ${i + 1}: ασύμβατη ταχύτητα, άφιξη, αναχώρηση ή διάρκεια διέλευσης.`);

    for (const [j, entry] of block.entries()) {
      entry.departure = departure;
      entry.speed = entry.canal ? NaN : fixed[j] > 0 ? fixed[j] : inferred;
      entry.hours = invalid ? NaN : entry.canal ? entry.canal.hours : entry.dist === 0 ? 0
        : entry.speed > 0 ? entry.dist / entry.speed : NaN;
      entry.arrival = departure + entry.hours * HOUR;
      entry.waitHours = 0;
      entry.nextDeparture = departure = entry.arrival;
    }
    if (Number.isFinite(leave) && Number.isFinite(leg.arrival) && leave < Math.max(leg.arrival, hasArrival ? arrive : -Infinity) - hourTolerance * HOUR) {
      errors.push(`Σκέλος ${i + 1}: η αναχώρηση προηγείται της άφιξης.`);
    }
    if (Number.isFinite(departure)) {
      const end = Number.isFinite(leave) ? leave : anchored && !strictArrival ? target : departure;
      leg.portHours = Math.max(0, (end - departure) / HOUR);
      leg.waitHours = last && Number.isFinite(leave) ? 0 : leg.portHours;
      leg.nextDeparture = departure + leg.portHours * HOUR;
      departure = leg.nextDeparture;
    }
    blockStart = i + 1;
  }
  return errors;
}

function legScheduleText(leg) {
  return `${utcText(leg.departure)} → ${utcText(leg.arrival)}`
    + (Number.isFinite(leg.speed) ? ` · ${fmt(leg.speed, 2)} kn` : "")
    + (leg.portHours > 0 ? ` · παραμονή ${fmt(leg.portHours, 1)} h · αναχ. ${utcText(leg.nextDeparture)}` : "");
}

/* ---------- Κεντρικός υπολογισμός ---------- */
function compute(departureOverride) {
  // Ανά σκέλος: λιμένες, απόσταση, διώρυγα (αν υπάρχει)
  const legs = S.legs.map((leg) => {
    const from = PORTS[leg.fromIdx] || PORTS[0];
    const to = PORTS[leg.toIdx] || PORTS[1];
    const canalRaw = legCanal(leg.fromIdx, leg.toIdx);
    const canal = canalRaw
      ? { ...canalRaw, hours: Number.isFinite(optionalNumber(leg.transitOverride)) ? optionalNumber(leg.transitOverride) : canalRaw.key === "suez" ? S.suezHours : S.panamaHours }
      : null;
    let dist, src;
    if (leg.distMode === "manual") { dist = leg.manualDist; src = "manual"; }
    else if (canal) { dist = canal.nm; src = "canal"; }
    else { dist = gcDistanceNm(from.lat, from.lon, to.lat, to.lon) * S.routingFactor; src = "gc"; }
    return { from, to, canal, dist, src, distMode: leg.distMode };
  });

  const distance = legs.reduce((sum, l) => sum + l.dist, 0);
  const from = legs[0]?.from || PORTS[0];
  const to = legs.at(-1)?.to || PORTS[1];
  const gc = legs.reduce((sum, l) => sum + (l.src === "gc" ? l.dist / S.routingFactor : l.dist), 0);
  const depEpoch = departureOverride ?? localToEpoch(S.depDate, S.depTime, S.depTz);
  const arrEpoch = localToEpoch(S.arrDate, S.arrTime, S.arrTz);
  const scheduleErrors = planLegs(legs, depEpoch, S.speedMode === "eta" ? arrEpoch : NaN);
  const total = (select) => legs.reduce((sum, l, i) => sum + select(l, i), 0);
  const transitHours = total((l) => l.canal?.hours ?? 0);
  const waitHours = total((l) => l.waitHours);
  const seaHours = total((l) => l.canal ? 0 : l.hours);
  const seaDistance = total((l) => l.canal ? 0 : l.dist);
  const canals = [...new Set(legs.filter((l) => l.canal).map((l) => l.canal.label))];
  const hours = scheduleErrors.length ? NaN : total((l) => l.hours) + waitHours;
  const finalLeg = legs.at(-1);
  const etaArrEpoch = scheduleErrors.length ? NaN
    : S.legs.at(-1)?.stopDeparture ? finalLeg?.arrival : finalLeg?.nextDeparture;
  const speed = scheduleErrors.length ? NaN
    : seaHours > 0 ? seaDistance / seaHours : S.speedMode === "speed" ? S.serviceSpeed : NaN;
  const days = hours / 24;
  const seaDays = seaHours / 24;
  // Non-sailing periods use the adjacent sailing rate unless a dedicated rate is supplied.
  const sailingSpeeds = legs.map((l) => l.speed);
  const rates = legs.map((l, i) => {
    const adjacentSpeed = Number.isFinite(l.speed) ? l.speed
      : sailingSpeeds.slice(0, i).reverse().find(Number.isFinite)
        ?? sailingSpeeds.slice(i + 1).find(Number.isFinite) ?? S.serviceSpeed;
    const phase = S.legs[i].phase === "ballast" ? "ballast" : "laden";
    const curve = S.phaseCurves?.[phase];
    const manual = interpolate(curve?.length ? curve : S.consTable, adjacentSpeed);
    const charter = !l.canal && typeof charterSeaRate === "function" ? charterSeaRate(S, phase, adjacentSpeed) : null;
    return charter ? { ...charter, manual } : manual;
  });
  const phaseForecast = forecastPhases(legs, rates, S, hours);
  const { lngM3, lngT, cargoUsed, foT, mdoT } = phaseForecast;
  const sailing = phaseForecast.rows.filter(row => row.kind === "laden" || row.kind === "ballast");
  const perDay = (key) => seaDays > 0 ? sailing.reduce((sum, row) => sum + row[key], 0) / seaDays : NaN;
  const lngM3Day = perDay("demand");
  const lngTDay = perDay("lngT");
  const foTDay = perDay("foT");
  const mdoTDay = perDay("mdoT");

  // FOE: 1 t LNG = CV_LNG / CV_FOE t FOE (kcal/kg)
  const charterEquivalent = typeof charterFoe === "function" ? charterFoe(S.charterParty, phaseForecast) : null;
  const foeFactor = charterEquivalent?.factor ?? S.cvLNG / S.cvFOE;
  const foeLNG = charterEquivalent?.lng ?? lngT * foeFactor;
  const foeTotal = charterEquivalent?.total ?? foeLNG + foT + mdoT;
  const lngFoeDay = (charterEquivalent?.fixed ? lngM3Day : lngTDay) * foeFactor;

  // Cool-down (δεξαμενές + γραμμή φόρτωσης)
  const coolTotal = (num(S.coolTanks) || 0) + (num(S.coolLine) || 0);

  // Απαιτούμενη ποσότητα με safety margin
  const marginAmount = Math.max(0, num(S.marginAmount) || 0);
  const marginPct = Math.max(0, num(S.marginPct) || 0);
  const marginM3 = S.marginMode === "pct" && marginPct ? lngM3 * marginPct / 100
    : S.marginMode === "lng" ? marginAmount : 0;
  const marginFo = S.marginMode === "fo" ? marginAmount : 0;
  const marginMdo = S.marginMode === "mdo" ? marginAmount : 0;
  const marginText = S.marginMode === "fo" ? `${fmt(marginFo, 2)} t LSHFO`
    : S.marginMode === "mdo" ? `${fmt(marginMdo, 2)} t LSMGO`
    : `${fmt(marginM3, 2)} m³ LNG${S.marginMode === "pct" && marginPct ? ` (${marginPct}%)` : ""}`;
  const requiredM3 = cargoUsed + marginM3 + coolTotal;

  // ROB άφιξης
  const departureLng = optionalNumber(S.robLng);
  const arrRobM3 = departureLng - cargoUsed;
  const arrRobM3Margin = departureLng - requiredM3;
  const arrFo = S.robFo - foT - marginFo;
  const arrMdo = S.robMdo - mdoT - marginMdo;

  const calibration = typeof cargoCalibration === "function" ? cargoCalibration() : null;
  const usableM3 = S.fillPct > 0 && S.fillPct <= 100
    ? calibration ? cargoTotalAtFill(calibration, S.fillPct) : S.capacity * S.fillPct / 100
    : NaN;
  const phases = new Set(legs.flatMap((leg, i) => leg.canal ? [] : [S.legs[i].phase === "ballast" ? "ballast" : "laden"]));
  const cargoMode = phases.size === 1 ? [...phases][0] : phases.size > 1 ? "mixed" : "";
  const heelInput = S.analysis.heel;
  const dischargeHeel = heelInput == null || heelInput === "" ? 0 : optionalNumber(heelInput);
  const hasArrivalRob = departureLng >= 0 && arrRobM3 >= 0 && Number.isFinite(arrRobM3);
  const edqM3 = cargoMode === "laden" && hasArrivalRob && dischargeHeel >= 0
    ? Math.max(0, arrRobM3 - dischargeHeel) : NaN;
  const maxIntakeM3 = cargoMode === "ballast" && hasArrivalRob && usableM3 > 0
    ? Math.max(0, usableM3 - arrRobM3) : NaN;

  let cargoNote = "";
  if (cargoMode === "mixed") cargoNote = "Ο πλους περιέχει Laden και Ballast σκέλη. Υπολόγισε χωριστά κάθε πλου με το LNG ROB της αναχώρησής του.";
  else if (!cargoMode) cargoNote = "Πρόσθεσε σκέλος πλεύσης και επίλεξε Laden ή Ballast.";
  else if (!(departureLng >= 0)) cargoNote = "Συμπλήρωσε έγκυρο LNG ROB αναχώρησης.";
  else if (!Number.isFinite(arrRobM3)) cargoNote = "Έλεγξε τη διαδρομή, την ταχύτητα και τις καταναλώσεις για να υπολογιστεί η άφιξη.";
  else if (arrRobM3 < 0) cargoNote = "Το LNG ROB αναχώρησης δεν επαρκεί για την εκτιμώμενη μείωση LNG του πλου.";
  else if (cargoMode === "laden" && !(dischargeHeel >= 0)) cargoNote = "Συμπλήρωσε έγκυρο heel μετά την εκφόρτωση.";
  else if (cargoMode === "laden" && dischargeHeel > arrRobM3) cargoNote = "Το LNG ROB άφιξης είναι μικρότερο από το heel που θέλεις να κρατήσεις.";
  else if (cargoMode === "ballast" && !(usableM3 > 0)) cargoNote = "Έλεγξε τη χωρητικότητα και το μέγιστο γέμισμα.";
  else if (cargoMode === "ballast" && arrRobM3 > usableM3) cargoNote = "Το heel άφιξης υπερβαίνει τον χρησιμοποιήσιμο όγκο δεξαμενών.";

  return {
    legs, from, to, gc, distance, transitHours, waitHours, scheduleErrors, canals, phaseForecast,
    depEpoch, arrEpoch, hours, seaHours, days, seaDays, speed, etaArrEpoch,
    rateOutsideTable: rates.some((rate, i) => !legs[i].canal && rate?.extrapolated),
    lngM3Day, lngTDay, foTDay, mdoTDay, lngM3, lngT, foT, mdoT,
    foeFactor, foeLNG, foeTotal, lngFoeDay, charterEquivalent, coolTotal, marginM3, marginText, requiredM3,
    arrRobM3, arrRobM3Margin, arrFo, arrMdo,
    cargoMode, cargoNote, cargoUsed, usableM3, dischargeHeel, edqM3, maxIntakeM3,
  };
}

function cargoVolumeText(volume, withMass = true) {
  if (!Number.isFinite(volume)) return "—";
  return fmt(volume, 0) + " m³" + (withMass && S.density > 0 ? " / " + fmt(volume * S.density, 1) + " t" : "");
}

function cargoArrivalRows(r) {
  if (!r.cargoMode || r.cargoMode === "mixed") return [["Εκτίμηση φορτίου", r.cargoNote]];
  const rows = [
    ["Μείωση LNG στον πλου", cargoVolumeText(r.cargoUsed)],
    ["LNG ROB στην άφιξη", cargoVolumeText(r.arrRobM3 >= 0 ? r.arrRobM3 : NaN)],
  ];
  if (r.cargoMode === "laden") {
    rows.push(["Heel μετά την εκφόρτωση", cargoVolumeText(r.dischargeHeel)]);
    rows.push(["EDQ", cargoVolumeText(r.edqM3)]);
  } else {
    rows.push(["Χρησιμοποιήσιμος όγκος", cargoVolumeText(r.usableM3, false)]);
    rows.push(["MAX INTAKE", cargoVolumeText(r.maxIntakeM3)]);
  }
  if (r.cargoNote) rows.push(["Έλεγχος πλάνου", r.cargoNote]);
  return rows;
}

/* ---------- Προαιρετική ανάλυση φορτίου, κόστους και εκπομπών ---------- */
function analysisRows(r) {
  const a = S.analysis;
  const get = (key) => {
    const value = optionalNumber(a[key]);
    return value >= 0 ? value : NaN;
  };
  const rows = [];
  const add = (label, value, unit, precision = 2) => {
    if (Number.isFinite(value)) rows.push([label, `${fmt(value, precision)} ${unit}`]);
  };
  const loaded = get("loaded");
  const heel = get("heel");
  const days = r.days + (get("unloadDays") || 0);
  const bogRate = get("bor") / 100;
  const grossBog = bogRate <= 1 ? loaded * (1 - (1 - bogRate) ** days) : NaN;
  const netBog = grossBog - Math.min(grossBog, get("reliq") || 0);
  const lngUsed = r.lngM3;
  const cargoLoss = Number.isFinite(netBog) ? Math.max(lngUsed, netBog) : r.phaseForecast.cargoUsed;
  const delivered = loaded - cargoLoss - (heel || 0);
  const energyFactor = S.density * S.cvLNG * 0.00396832072;
  const loadedEnergy = loaded * energyFactor;
  const deliveredEnergy = delivered >= 0 ? delivered * energyFactor : NaN;
  const term = a.incoterm;
  const saleEnergy = term === "fob" ? loadedEnergy : term === "dap" ? deliveredEnergy : NaN;

  add("Εκφόρτωση / παραμονή", get("unloadDays"), "ημ");
  if (Number.isFinite(get("unloadDays"))) add("Διάρκεια για ναύλωση / BOG", days, "ημ");
  add("Φορτωμένη ενέργεια", loadedEnergy, "MMBtu", 0);
  add("Εκτιμώμενο φυσικό BOG", grossBog, "m³ LNG");
  add("BOG μετά από επαναϋγροποίηση", netBog, "m³ LNG");
  add("Εκτιμώμενη παράδοση LNG", delivered >= 0 ? delivered : NaN, "m³");
  add("Ενέργεια παράδοσης", deliveredEnergy, "MMBtu", 0);
  add("Θερμική ενέργεια παράδοσης", deliveredEnergy * 0.00029307107, "GWh");
  add("Εκτιμώμενη παραγωγή ηλεκτρικής ενέργειας", deliveredEnergy * 0.00029307107
    * (get("powerEfficiency") <= 100 ? get("powerEfficiency") / 100 : NaN), "GWh");
  add("Ενδεικτικό heel για επιστροφή", get("returnLng") + r.coolTotal, "m³ LNG");
  if (term === "fob" || term === "dap") rows.push(["Εμπορικός όρος", term === "fob" ? "FOB" : "DES / DAP"]);
  if (Number.isFinite(delivered) && delivered < 0) rows.push(["Ισοζύγιο φορτίου", "Ελέγξτε τη φορτωμένη ποσότητα, την κατανάλωση και το heel."]);
  if (Number.isFinite(loaded) && loaded > r.usableM3) rows.push(["Φορτωμένη ποσότητα", "Υπερβαίνει τον χρησιμοποιήσιμο όγκο δεξαμενών."]);

  const mdoCost = r.mdoT * get("mdoPrice");
  const foCost = r.foT * get("foPrice");
  const lngCost = r.lngT * get("lngFuelPrice");
  const hire = days * get("hire");
  const gas = loadedEnergy * get("gas");
  const liquefaction = loadedEnergy * get("liquefaction");
  const regas = deliveredEnergy * get("regas");
  const revenue = saleEnergy * get("salePrice");
  const costs = [
    ["Κόστος LSMGO", mdoCost], ["Κόστος LSHFO", foCost], ["Κόστος LNG καυσίμου", lngCost],
    ["Ναύλωση", hire], ["Αγορά φυσικού αερίου", gas], ["Υγροποίηση", liquefaction],
    ["Επαναεριοποίηση", regas], ["Διόδια διωρύγων", get("canalFee")], ["Λιμενικά έξοδα", get("portFee")],
    ["Χρέωση εκπομπών", get("carbonFee")],
  ];
  for (const [label, value] of costs) add(label, value, "USD");
  const availableCosts = costs.map(([, value]) => value).filter(Number.isFinite);
  const costTotal = availableCosts.reduce((sum, value) => sum + value, 0);
  if (availableCosts.length) add("Σύνολο καταχωρισμένων εξόδων", costTotal, "USD");
  add("Εκτιμώμενα έσοδα", revenue, "USD");
  if (availableCosts.length) {
    add("Έσοδα μείον καταχωρισμένα έξοδα", revenue - costTotal, "USD");
    if (revenue > 0) add("Ποσοστό επί των εσόδων μετά τα καταχωρισμένα έξοδα", (revenue - costTotal) / revenue * 100, "%");
  }

  const emissions = [
    ["CO₂ από LSMGO", r.mdoT * get("mdoCo2")],
    ["CO₂ από LSHFO", r.foT * get("foCo2")],
    ["CO₂ από LNG καυσίμου", r.lngT * get("lngCo2")],
  ];
  for (const [label, value] of emissions) add(label, value, "t CO₂");
  const availableEmissions = emissions.map(([, value]) => value).filter(Number.isFinite);
  if (availableEmissions.length) {
    const total = availableEmissions.reduce((sum, value) => sum + value, 0);
    add("CO₂ από καύσιμα με καταχωρισμένο συντελεστή", total, "t CO₂");
    add("Ένταση για τους καταχωρισμένους συντελεστές", total * 1000 / deliveredEnergy, "kg CO₂/MMBtu", 4);
  }
  add("Εκπομπές από venting BOG", get("ventCo2e"), "t CO₂e");
  add("Εκπομπές από methane slip", get("slipCo2e"), "t CO₂e");
  return rows;
}

/* ---------- Αναζήτηση λιμένα ---------- */
function portOptions(selected, filterType) {
  let list = PORTS.map((p, i) => ({ ...p, i }));
  if (filterType) list = list.filter((p) => p.type === filterType);
  return list
    .sort((a, b) => a.name.localeCompare(b.name, "el"))
    .map((p) => `<option value="${p.i}" ${p.i === selected ? "selected" : ""}>${p.name} (${p.country})</option>`)
    .join("");
}

function tzOptions(sel) {
  let out = "";
  for (let h = -12; h <= 14; h += 0.5) {
    const lbl = h === 0 ? "UTC" : `UTC${h > 0 ? "+" : "−"}${Math.abs(h) % 1 ? Math.abs(h).toFixed(1) : Math.abs(h)}`;
    out += `<option value="${h}" ${h === sel ? "selected" : ""}>${lbl}</option>`;
  }
  return out;
}

function portTz(idx) { return PORTS[idx] ? PORTS[idx].tz : 0; }

/* ---------- Αποθήκευση / φόρτωση ---------- */
function voyageName() {
  const r = compute();
  const via = r.canals.length ? ` via ${r.canals.join(" + ")}` : "";
  return `${r.from.name} → ${r.to.name}${via}`;
}

function saveVoyage() {
  const list = store.get("voyages") || [];
  const entry = { name: voyageName(), date: new Date().toISOString(), data: JSON.parse(JSON.stringify(S)) };
  const existing = list.findIndex((v) => v.name === entry.name);
  if (existing >= 0) list[existing] = entry; else list.push(entry);
  store.set("voyages", list);
  toast("Το ταξίδι αποθηκεύτηκε");
}

function openLoadModal() {
  const list = store.get("voyages") || [];
  const box = $("voyageList");
  if (!list.length) { box.innerHTML = '<p class="hint">Δεν υπάρχουν αποθηκευμένα ταξίδια.</p>'; }
  else {
    box.innerHTML = list
      .map((v, i) => `<div class="voyage-item">
          <div class="v-info">
            <div class="v-name">${v.name}</div>
            <div class="v-date">${new Date(v.date).toLocaleString("el-GR")}</div>
          </div>
          <button class="btn small" data-load="${i}">Φόρτωση</button>
          <button class="btn small danger" data-del="${i}" aria-label="Διαγραφή">✕</button>
        </div>`)
      .join("");
    box.querySelectorAll("[data-load]").forEach((b) =>
      b.addEventListener("click", () => {
        S = migrateState(list[+b.dataset.load].data);
        $("loadModal").classList.remove("open");
        syncInputs(); render();
        toast("Το ταξίδι φορτώθηκε");
      }));
    box.querySelectorAll("[data-del]").forEach((b) =>
      b.addEventListener("click", () => {
        list.splice(+b.dataset.del, 1);
        store.set("voyages", list);
        openLoadModal();
      }));
  }
  $("loadModal").classList.add("open");
}

function downloadFile(name, content, type) {
  try {
    const blob = new Blob([content], { type });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast("Λήψη αρχείου: " + name);
  } catch (e) {
    toast("Αποτυχία λήψης — δοκιμάστε εξαγωγή σε αναπτυγμένη έκδοση");
  }
}

function exportJson() {
  downloadFile(
    voyageName().replace(/[^\w\-\u0370-\u03ff]+/g, "_") + ".json",
    JSON.stringify({ app: "LNG Voyage Calculator", version: 1, saved: new Date().toISOString(), state: S }, null, 2),
    "application/json"
  );
}

function importJson(file) {
  const fr = new FileReader();
  fr.onload = () => {
    try {
      const j = JSON.parse(fr.result);
      if (!j.state) throw new Error();
      S = migrateState(j.state);
      syncInputs(); render();
      toast("Επιτυχής εισαγωγή αρχείου");
    } catch (e) { toast("Μη έγκυρο αρχείο ταξιδιού"); }
  };
  fr.readAsText(file);
}

/* ---------- Αναφορά HTML ---------- */
function buildReport(r) {
  const row = (k, v) => `<tr><td>${k}</td><td class="num">${v}</td></tr>`;
  const optionalRows = analysisRows(r);
  const dt = (epoch, tz) => Number.isFinite(epoch)
    ? new Date(epoch + tz * HOUR).toLocaleString("el-GR", { timeZone: "UTC" }) + ` (UTC${tz >= 0 ? "+" : ""}${tz})` : "—";
  return `<!DOCTYPE html><html lang="el"><head><meta charset="utf-8">
<title>Αναφορά Πλόου — ${r.from.name} → ${r.to.name}</title>
<style>
body{font-family:Georgia,serif;margin:40px;color:#111}
h1{font-size:20px;border-bottom:2px solid #111;padding-bottom:8px}
h2{font-size:15px;margin:24px 0 6px;text-transform:uppercase;letter-spacing:.05em}
table{width:100%;border-collapse:collapse;font-size:13px}
td,th{border:1px solid #999;padding:5px 8px;text-align:left}
td.num{text-align:right;font-family:monospace}
th{background:#eee}
.sig{margin-top:40px;display:flex;justify-content:space-between;font-size:12px}
.sig div{border-top:1px solid #000;width:220px;padding-top:4px;text-align:center}
</style></head><body>
<h1>Αναφορά Πλόου LNG — ${r.from.name} → ${r.to.name}${r.canals.length ? " via " + r.canals.join(" + ") : ""}</h1>
<p>Συντάχθηκε: ${new Date().toLocaleString("el-GR")}</p>
<h2>Σκέλη πλόου</h2><table>
<tr><th>Σκέλος</th><th>Απόσταση</th></tr>
${r.legs.map((l, i) => `<tr><td>${i + 1}. ${l.from.name} → ${l.to.name}${l.canal ? " (" + l.canal.label + ")" : ""}</td><td class="num">${fmt(l.dist, 0)} nm${l.canal ? " · " + fmt(l.canal.hours, 1) + " h transit" : ""}<br>${legScheduleText(l)}</td></tr>`).join("")}
<tr><td><strong>Σύνολο</strong></td><td class="num"><strong>${fmt(r.distance, 0)} nm</strong></td></tr>
</table>
<h2>Ταξίδι</h2><table>
${row("Αναχώρηση", dt(r.depEpoch, S.depTz))}
${row("Άφιξη", dt(r.etaArrEpoch, S.arrTz))}
${row("Διάρκεια", fmt(r.days, 2) + " ημέρες (" + fmt(r.hours, 1) + " ώρες)")}
${row("Προτεινόμενη ταχύτητα", fmt(r.speed, 2) + " kn")}
</table>
<h2>Καταναλώσεις (ημερήσιες @ " + fmt(r.speed, 2) + " kn)</h2><table>
${row("LNG", fmt(r.lngM3Day, 0) + " m³/ημ = " + fmt(r.lngTDay, 1) + " t/ημ")}
${row("Fuel Oil", fmt(r.foTDay, 2) + " t/ημ")}
${row("Diesel (MDO)", fmt(r.mdoTDay, 2) + " t/ημ")}
</table>
<h2>Συνολικά ταξιδίου</h2><table>
${row("LNG", fmt(r.lngM3, 0) + " m³ = " + fmt(r.lngT, 1) + " t")}
${row("Fuel Oil", fmt(r.foT, 1) + " t")}
${row("MDO", fmt(r.mdoT, 1) + " t")}
${row("FOE LNG", fmt(r.foeLNG, 1) + " t (συντ. " + fmt(r.foeFactor, 3) + ")")}
${row("Συνολικό FOE", fmt(r.foeTotal, 1) + " t")}
</table>
<h2>Αποθέματα (ROB)</h2><table>
${row("LNG αναχώρησης", fmt(S.robLng, 0) + " m³ = " + fmt(S.robLng * S.density, 1) + " t")}
${row("LNG άφιξης (υπολογισμός)", fmt(r.arrRobM3, 0) + " m³ = " + fmt(r.arrRobM3 * S.density, 1) + " t")}
${row("LNG διαθέσιμο μετά από margin και cool-down", fmt(r.arrRobM3Margin, 0) + " m³ = " + fmt(r.arrRobM3Margin * S.density, 1) + " t")}
${row("FO αναχώρησης / διαθέσιμο μετά το margin", fmt(S.robFo, 1) + " / " + fmt(r.arrFo, 1) + " t")}
${row("MDO αναχώρησης / διαθέσιμο μετά το margin", fmt(S.robMdo, 1) + " / " + fmt(r.arrMdo, 1) + " t")}
${row("Cool-down δεξαμενές + γραμμή", fmt(r.coolTotal, 0) + " m³")}
${row("Safety margin", r.marginText)}
${row("Συνολική απαιτούμενη ποσότητα", fmt(r.requiredM3, 0) + " m³")}
</table>
<h2>Εκτίμηση φορτίου στην άφιξη</h2><table>
${cargoArrivalRows(r).map(([label, value]) => row(label, value)).join("")}
</table>
${optionalRows.length ? `<h2>Ανάλυση φορτίου, κόστους και εκπομπών</h2><table>${optionalRows.map(([label, value]) => row(label, value)).join("")}</table>` : ""}
<div class="sig"><div>Πλοίαρχος</div><div>Α' Μηχανικός</div><div>Ημ/νία</div></div>
</body></html>`;
}

function exportReport() {
  const r = compute();
  const stamp = new Date().toISOString().slice(0, 10);
  downloadFile(
    "LNG_Voyage_Report_" + stamp + ".html",
    buildReport(r),
    "text/html;charset=utf-8"
  );
}

/* ---------- Φωτογραφία πίνακα καταναλώσεων ---------- */
let photoData = null;
function handlePhoto(file) {
  const fr = new FileReader();
  fr.onload = () => {
    photoData = fr.result;
    $("photoPreview").innerHTML = `<img src="${photoData}" alt="Φωτογραφία πίνακα καταναλώσεων">`;
    $("photoActions").style.display = "flex";
    $("ocrText").style.display = "block";
    $("ocrText").textContent = "";
    toast("Η φωτογραφία φορτώθηκε — συμπληρώστε τον πίνακα από την εικόνα");
  };
  fr.readAsDataURL(file);
}

function runOcr() {
  if (!photoData) return;
  const out = $("ocrText");
  out.style.display = "block";
  out.textContent = "Φόρτωση μηχανής ανάγνωσης… (απαιτείται σύνδεση ίντερνετ)";
  const script = document.createElement("script");
  script.src = "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js";
  script.onload = async () => {
    try {
      out.textContent = "Ανάγνωση σε εξέλιξη…";
      const res = await Tesseract.recognize(photoData, "eng");
      out.textContent = res.data.text || "(Δεν αναγνωρίστηκε κείμενο — εισάγετε τις τιμές χειροκίνητα από την εικόνα)";
    } catch (e) {
      out.textContent = "Αποτυχία ανάγνωσης — εισάγετε τις τιμές χειροκίνητα από την εικόνα.";
    }
  };
  script.onerror = () => {
    out.textContent = "Δεν ήταν δυνατή η φόρτωση OCR (εκτός σύνδεσης;) — εισάγετε τις τιμές χειροκίνητα από την εικόνα.";
  };
  document.head.appendChild(script);
}

/* ---------- Πίνακας καταναλώσεων (UI) ---------- */
function syncConsConversions(active) {
  for (const [i, tr] of Array.from($("consBody").rows).entries()) {
    const row = S.consTable[i];
    const { volume, tonnes, foe, density } = lngConversions(row);
    const fields = { m3: volume, t: tonnes, foe };
    for (const [key, value] of Object.entries(fields)) {
      const input = tr.querySelector(`[data-f="${key}"]`);
      if (input !== active) input.value = Number.isFinite(value) ? Number(value.toFixed(6)) : "";
    }
    tr.querySelector('[data-f="density"]').placeholder = String(density);
    tr.querySelector('[data-f="density"]').title = "Πυκνότητα σε χρήση: " + fmt(density, 3) + " t/m³";
  }
}

function renderConsTable() {
  const tb = $("consBody");
  const input = (i, field, label, value = "", min = 0) =>
    `<input data-r="${i}" data-f="${field}" type="number" step="any" min="${min}" value="${Number.isFinite(value) ? value : ""}" aria-label="${label} σειρά ${i + 1}">`;
  tb.innerHTML = S.consTable.map((row, i) => `<tr>
      <td>${input(i, "speed", "Ταχύτητα", row.speed, 0.01)}</td>
      <td class="num">${input(i, "m3", "LNG m³/ημέρα")}</td>
      <td class="num">${input(i, "t", "LNG t/ημέρα")}</td>
      <td class="num">${input(i, "foe", "LNG t FOE/ημέρα")}</td>
      <td class="num">${input(i, "density", "Πυκνότητα t/m³", row.density, 0.001)}</td>
      <td class="num">${input(i, "fo", "Fuel Oil t/ημέρα", row.fo)}</td>
      <td class="num">${input(i, "mdo", "MDO t/ημέρα", row.mdo)}</td>
      <td><button class="row-del" data-del-row="${i}" aria-label="Διαγραφή σειράς ${i + 1}">✕</button></td>
    </tr>`).join("");
  syncConsConversions();
  const edit = (inp, commit) => {
    const row = S.consTable[Number(inp.dataset.r)];
    const field = inp.dataset.f;
    const value = optionalNumber(inp.value);
    if (!inp.checkValidity()) return;
    if (field === "density") {
      if (value > 0) row.density = value;
      else delete row.density;
    } else if (["m3", "t", "foe"].includes(field)) {
      if (!commit && !Number.isFinite(value)) return;
      row.lngUnit = field;
      row.lngInput = Number.isFinite(value) ? value : 0;
    } else {
      if (!Number.isFinite(value)) return;
      row[field] = value;
    }
    row.lng = lngConversions(row).volume;
    syncConsConversions(commit ? undefined : inp);
    render();
  };
  tb.querySelectorAll("input[data-r]").forEach(inp => {
    inp.addEventListener("input", () => edit(inp, false));
    inp.addEventListener("change", () => edit(inp, true));
  });
  tb.querySelectorAll("[data-del-row]").forEach(button => button.addEventListener("click", () => {
    S.consTable.splice(Number(button.dataset.delRow), 1);
    renderConsTable();
    render();
  }));
}

/* ---------- Συγχρονισμός inputs από state ---------- */
function syncInputs() {
  renderLegs();
  $("depTz").innerHTML = tzOptions(S.depTz);
  $("arrTz").innerHTML = tzOptions(S.arrTz);
  $("routingFactor").value = S.routingFactor;
  $("suezHours").value = S.suezHours;
  $("panamaHours").value = S.panamaHours;
  $("depDate").value = S.depDate;
  $("depTime").value = S.depTime;
  $("arrDate").value = S.arrDate;
  $("arrTime").value = S.arrTime;
  $("speedModeEta").checked = S.speedMode === "eta";
  $("speedModeSpd").checked = S.speedMode === "speed";
  $("serviceSpeed").value = S.serviceSpeed;
  $("serviceSpeed").disabled = S.speedMode !== "speed";
  $("density").value = S.density;
  $("capacity").value = S.capacity;
  $("fillPct").value = S.fillPct;
  $("marginMode").value = S.marginMode;
  $("marginPct").value = S.marginPct ?? "";
  $("marginAmount").value = S.marginAmount ?? "";
  for (const key of ["idleLng", "idleFo", "idleMdo"]) $(key).value = S[key] ?? "";
  document.querySelectorAll("[data-analysis]").forEach((input) => {
    input.value = S.analysis[input.dataset.analysis] ?? "";
  });
  $("coolTanks").value = S.coolTanks;
  $("coolLine").value = S.coolLine;
  $("cvLNG").value = S.cvLNG;
  $("cvFOE").value = S.cvFOE;
  $("robLng").value = S.robLng;
  $("robFo").value = S.robFo;
  $("robMdo").value = S.robMdo;
  renderConsTable();
  syncOperations();
}

/* ---------- Σκέλη πλόου (UI) ---------- */
function renderLegs() {
  if (typeof syncLinkedVoyage === "function") syncLinkedVoyage();
  const box = $("legsList");
  box.innerHTML = S.legs
    .map((leg, i) => {
      const last = i === S.legs.length - 1;
      const canal = legCanal(leg.fromIdx, leg.toIdx);
      const next = S.legs[i + 1];
      const nextCanal = next && legCanal(next.fromIdx, next.toIdx);
      const dateValue = (value) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value ?? "") ? value : "";
      return `<div class="leg-row" data-leg="${i}">
        <div class="field">
          <label>Από</label>
          <select data-legi="${i}" data-f="fromIdx">${portOptions(leg.fromIdx)}</select>
        </div>
        <div class="field">
          <label>${last ? "Προς (τελικός)" : "Προς"}</label>
          <select data-legi="${i}" data-f="toIdx">${portOptions(leg.toIdx)}</select>
        </div>
        <div class="field">
          <label>Απόσταση</label>
          <select data-legi="${i}" data-f="distMode">
            <option value="gc" ${leg.distMode === "gc" ? "selected" : ""}>Αυτόματα (GC)</option>
            <option value="manual" ${leg.distMode === "manual" ? "selected" : ""}>Χειροκίνητη</option>
          </select>
        </div>
        <div class="field">
          <label>nm</label>
          <input type="number" data-legi="${i}" data-f="manualDist" step="1" min="0"
            value="${leg.manualDist}" ${leg.distMode === "gc" ? "disabled" : ""}>
        </div>
        ${!canal ? `<label class="field leg-phase">Κατάσταση σκέλους
          <select data-legi="${i}" data-f="phase">
            <option value="laden" ${leg.phase !== "ballast" ? "selected" : ""}>Laden</option>
            <option value="ballast" ${leg.phase === "ballast" ? "selected" : ""}>Ballast</option>
          </select>
        </label>` : ""}
        <div class="leg-meta">
          <span class="leg-dist" id="legDist${i}">—</span>
        </div>
        <button class="btn small danger leg-del" data-del-leg="${i}" aria-label="Διαγραφή σκέλους ${i + 1}">✕</button>
        <div class="leg-timing">
          <strong>${last ? "Τελικό σημείο" : "Waypoint " + (i + 1)} · ${opsEscape(PORTS[leg.toIdx]?.name || "")}</strong>
          <div class="grid-form">
          ${!canal ? `<label class="field">Επιθυμητή ταχύτητα σκέλους (kn)
            <input type="number" min="0.01" step="any" data-legi="${i}" data-f="speedOverride"
              value="${Number.isFinite(leg.speedOverride) ? leg.speedOverride : ""}" placeholder="Αυτόματα">
          </label>` : ""}
            <label class="field">Ημερομηνία και ώρα άφιξης ${canal ? "στην έξοδο της διώρυγας" : "στο τέλος του σκέλους"}
              <input type="datetime-local" data-legi="${i}" data-f="stopArrival" value="${dateValue(leg.stopArrival)}">
            </label>
            <label class="field">Ημερομηνία και ώρα ${last ? "αναχώρησης από τελικό σημείο" : nextCanal ? "έναρξης διέλευσης" : "αναχώρησης για το επόμενο σκέλος"}
              <input type="datetime-local" data-legi="${i}" data-f="stopDeparture" value="${dateValue(leg.stopDeparture)}">
            </label>
            <label class="field">Ζώνη ώρας σημείου
              <select data-legi="${i}" data-f="stopTz">${tzOptions(leg.stopTz ?? (last ? S.arrTz : portTz(leg.toIdx)))}</select>
            </label>
          ${canal ? `<label class="field">Χειροκίνητη διάρκεια διέλευσης (h)
            <input type="number" min="0.1" step="any" data-legi="${i}" data-f="transitOverride"
              value="${Number.isFinite(leg.transitOverride) ? leg.transitOverride : ""}">
          </label>` : ""}
          </div>
        </div>

      </div>`;
    })
    .join("");

  box.querySelectorAll("select[data-legi], input[data-legi]").forEach((el) =>
    el.addEventListener("change", () => {
      const i = +el.dataset.legi;
      const f = el.dataset.f;
      if (f === "fromIdx" || f === "toIdx") {
        S.legs[i][f] = +el.value;
        // Αλυσίδωση σκέλων: το επόμενο ξεκινά από τον προορισμό του προηγούμενου
        if (f === "toIdx" && S.legs[i + 1]) S.legs[i + 1].fromIdx = S.legs[i].toIdx;
        if (f === "fromIdx" && S.legs[i - 1]) S.legs[i - 1].toIdx = S.legs[i].fromIdx;
      }
      else if (f === "distMode" || f === "phase") S.legs[i][f] = el.value;
      else if (f === "manualDist") S.legs[i].manualDist = num(el.value) || 0;
      else {
        S.legs[i][f] = f === "stopTz" ? num(el.value)
          : ["transitOverride", "speedOverride"].includes(f) && el.value !== "" ? num(el.value) : el.value;
        render();
        return;
      }
      // Η ζώνη ώρας αναχώρησης/άφιξης ακολουθεί τους ακραίους λιμένες
      if (f === "fromIdx" && i === 0) S.depTz = portTz(S.legs[0].fromIdx);
      if (f === "toIdx" && i === S.legs.length - 1) S.arrTz = portTz(S.legs[i].toIdx);
      $("depTz").innerHTML = tzOptions(S.depTz);
      $("arrTz").innerHTML = tzOptions(S.arrTz);
      renderLegs();
      render();
    })
  );
  box.querySelectorAll("[data-del-leg]").forEach((b) =>
    b.addEventListener("click", () => {
      if (S.legs.length > 1) {
        const i = +b.dataset.delLeg;
        const [removed] = S.legs.splice(i, 1);
        if (i > 0 && S.legs[i]) S.legs[i].fromIdx = S.legs[i - 1].toIdx;
        if (i === 0 && removed.fromIdx !== S.legs[0].fromIdx) {
          S.depTz = portTz(S.legs[0].fromIdx);
          $("depTz").innerHTML = tzOptions(S.depTz);
        }
        if (i === S.legs.length) {
          S.arrTz = portTz(S.legs.at(-1).toIdx);
          $("arrTz").innerHTML = tzOptions(S.arrTz);
        }
        renderLegs(); render();
      }
    })
  );
}

/* ---------- Κύρια απεικόνιση αποτελεσμάτων ---------- */
function render() {
  const r = compute();
  const bad = (v) => !Number.isFinite(v);

  // Sticky σύνοψη
  $("sumDist").textContent = bad(r.distance) ? "—" : fmt(r.distance, 0) + " nm";
  $("sumDays").textContent = bad(r.days) ? "—" : fmt(r.days, 1) + " ημ";
  $("sumSpeed").textContent = bad(r.speed) ? "—" : fmt(r.speed, 1) + " kn";
  $("sumLng").textContent = bad(r.lngM3) ? "—" : fmt(r.lngM3, 0) + " m³";
  const arrivalQuantity = r.cargoMode === "laden" ? r.edqM3 : r.maxIntakeM3;
  if ($("sumCargoLabel")) $("sumCargoLabel").textContent = r.cargoMode === "laden" ? "EDQ" : r.cargoMode === "ballast" ? "Max Intake" : "Φορτίο άφιξης";
  $("sumMaxIntake").textContent = cargoVolumeText(arrivalQuantity, false);
  $("sumSpeed").classList.toggle("bad", r.speed < 8 || r.speed > 21);

  // Ταξίδι — σκέλη
  r.legs.forEach((l, i) => {
    const el = $("legDist" + i);
    if (el) {
      const canalTag = l.canal ? ` — ${l.canal.label} (transit ${fmt(l.canal.hours, 0)} h)` : "";
      const srcTag = l.src === "manual" ? "χειροκίνητη" : l.src === "canal" ? "canal" : "GC";
      el.innerHTML = `${fmt(l.dist, 0)} nm <span class="src-tag">(${srcTag})</span>${canalTag}<br>${legScheduleText(l)}`;
    }
  });

  // Ταξίδι — σύνολα
  $("resRouteDist").textContent = fmt(r.distance, 0) + " nm";
  $("resDepUtc").textContent = Number.isFinite(r.depEpoch)
    ? new Date(r.depEpoch).toLocaleString("el-GR", { timeZone: "UTC", dateStyle: "medium", timeStyle: "short" }) + " UTC" : "—";
  $("resArrUtc").textContent = Number.isFinite(r.etaArrEpoch)
    ? new Date(r.etaArrEpoch).toLocaleString("el-GR", { timeZone: "UTC", dateStyle: "medium", timeStyle: "short" }) + " UTC" : "—";
  $("resDuration").textContent = bad(r.hours) ? "—" : `${fmt(r.days, 2)} ημέρες (${fmt(r.hours, 1)} ώρες)`;
  $("resSpeed").textContent = bad(r.speed) ? "—" : fmt(r.speed, 2) + " knots";
  const transitNote = r.transitHours > 0 || r.waitHours > 0
    ? `Περιλαμβάνονται ${fmt(r.transitHours, 0)} h διέλευσης και ${fmt(r.waitHours, 1)} h αναμονής · πλεύσιμος χρόνος ${fmt(r.seaHours, 1)} h (${fmt(r.seaDays, 2)} ημ)` : "";
  $("resTransit").textContent = transitNote;
  $("resTransit").style.display = transitNote ? "block" : "none";
  $("resSpeedNote").textContent = r.scheduleErrors.join(" ") || "Μέση ταχύτητα στη θάλασσα. Η ταχύτητα ανά σκέλος εμφανίζεται στη διαδρομή.";
  $("marginPct").closest(".field").hidden = S.marginMode !== "pct";
  $("marginAmount").closest(".field").hidden = !["lng", "fo", "mdo"].includes(S.marginMode);
  $("marginAmountLabel").textContent = {lng: "Ποσότητα LNG (m³)", fo: "Ποσότητα LSHFO (t)", mdo: "Ποσότητα LSMGO (t)"}[S.marginMode] || "Ποσότητα";

  // Καταναλώσεις
  $("consWarn").style.display = r.rateOutsideTable ? "block" : "none";
  if ($("consPerLeg")) $("consPerLeg").innerHTML = tableHtml(
    ["Σκέλος", "Φάση", "kn", "Ώρες", "LNG m³", "LNG t", "LNG t FOE", "LSHFO t", "MDO t"],
    r.phaseForecast.rows.map(row => [row.leg, phaseNames[row.kind], ["laden", "ballast"].includes(row.kind) ? fmt(r.legs[row.leg - 1].speed, 2) : "—",
      fmt(row.time, 2), fmt(row.demand, 2), fmt(row.lngT, 2), fmt((r.charterEquivalent?.fixed ? row.demand : row.lngT) * r.foeFactor, 2), fmt(row.foT, 2), fmt(row.mdoT, 2)])
  );
  if (Number.isFinite(r.lngM3Day)) {
    $("consAt").textContent = `Μέση ημερήσια στην πλεύση · ${fmt(r.speed, 2)} kn`;
    $("consLngDay").textContent = `${fmt(r.lngM3Day, 0)} m³/ημ = ${fmt(r.lngTDay, 1)} t/ημ`;
    $("consFoDay").textContent = `${fmt(r.foTDay, 2)} t/ημ`;
    $("consMdoDay").textContent = `${fmt(r.mdoTDay, 2)} t/ημ`;
    if ($("consFoeDay")) $("consFoeDay").textContent = `${fmt(r.lngFoeDay, 2)} t FOE/ημ`;
  } else {
    for (const id of ["consAt", "consLngDay", "consFoeDay", "consFoDay", "consMdoDay"]) {
      if ($(id)) $(id).textContent = "—";
    }
  }

  // Συνολικά ταξιδίου
  $("totLng").textContent = bad(r.lngM3) ? "—" : `${fmt(r.lngM3, 0)} m³ = ${fmt(r.lngT, 1)} t`;
  $("totFo").textContent = bad(r.foT) ? "—" : `${fmt(r.foT, 1)} t`;
  $("totMdo").textContent = bad(r.mdoT) ? "—" : `${fmt(r.mdoT, 1)} t`;
  $("totFoe").textContent = bad(r.foeLNG) ? "—" : `${fmt(r.foeLNG, 1)} t`;
  $("totFoeAll").textContent = bad(r.foeTotal) ? "—" : `${fmt(r.foeTotal, 1)} t`;

  // ROB & Απαιτήσεις
  $("depLngOut").textContent = `${fmt(S.robLng, 0)} m³ = ${fmt(S.robLng * S.density, 1)} t`;
  $("arrLngOut").textContent = bad(r.arrRobM3) ? "—" : `${fmt(r.arrRobM3, 0)} m³ = ${fmt(r.arrRobM3 * S.density, 1)} t`;
  $("arrLngMarginOut").textContent = bad(r.arrRobM3Margin) ? "—" : `${fmt(r.arrRobM3Margin, 0)} m³ = ${fmt(r.arrRobM3Margin * S.density, 1)} t`;
  $("arrLngMarginOut").classList.toggle("bad", r.arrRobM3Margin < 0);
  $("depFoOut").textContent = `${fmt(S.robFo, 1)} t`;
  $("arrFoOut").textContent = bad(r.arrFo) ? "—" : `${fmt(r.arrFo, 1)} t`;
  $("arrFoOut").classList.toggle("bad", r.arrFo < 0);
  $("depMdoOut").textContent = `${fmt(S.robMdo, 1)} t`;
  $("arrMdoOut").textContent = bad(r.arrMdo) ? "—" : `${fmt(r.arrMdo, 1)} t`;
  $("arrMdoOut").classList.toggle("bad", r.arrMdo < 0);
  $("coolOut").textContent = `${fmt(r.coolTotal, 0)} m³ = ${fmt(r.coolTotal * S.density, 1)} t`;
  $("marginOut").textContent = r.marginText;
  $("reqOut").textContent = bad(r.requiredM3) ? "—" : `${fmt(r.requiredM3, 0)} m³ = ${fmt(r.requiredM3 * S.density, 1)} t`;

  if ($("cargoArrivalTitle")) {
    $("cargoArrivalTitle").textContent = r.cargoMode === "laden" ? "Laden · EDQ στο " + r.to.name
      : r.cargoMode === "ballast" ? "Ballast · Max Intake στο " + r.to.name : "Εκτίμηση φορτίου στην άφιξη";
    $("departureLngLabel").textContent = r.cargoMode === "laden" ? "Συνολικό LNG στο πλοίο μετά τη φόρτωση (m³)"
      : r.cargoMode === "ballast" ? "LNG heel αναχώρησης μετά την εκφόρτωση (m³)" : "LNG ROB αναχώρησης (m³)";
    $("cargoArrivalNote").textContent = r.cargoNote;
    $("cargoArrivalNote").hidden = !r.cargoNote;
    $("ladenArrival").hidden = r.cargoMode !== "laden";
    $("ballastArrival").hidden = r.cargoMode !== "ballast";
    $("cargoArrivalBalances").hidden = $("ladenArrival").hidden && $("ballastArrival").hidden;
    $("voyageCargoLoss").textContent = cargoVolumeText(r.cargoUsed);
    $("cargoArrivalRob").textContent = cargoVolumeText(r.arrRobM3 >= 0 ? r.arrRobM3 : NaN);
    $("edqOut").textContent = cargoVolumeText(r.edqM3);
    $("maxUsable").textContent = cargoVolumeText(r.usableM3, false);
    $("maxIntakeOut").textContent = cargoVolumeText(r.maxIntakeM3, false);
    $("maxIntakeTOut").textContent = Number.isFinite(r.maxIntakeM3) && S.density > 0 ? fmt(r.maxIntakeM3 * S.density, 1) + " t" : "—";
  }

  // Πλήρης σύνοψη (tab 4)
  const dt = (epoch) => Number.isFinite(epoch)
    ? new Date(epoch).toLocaleString("el-GR", { timeZone: "UTC", dateStyle: "medium", timeStyle: "short" }) + " UTC" : "—";
  $("fullSummary").innerHTML = `
    <thead><tr><th colspan="2">Ταξίδι</th></tr></thead><tbody>
    <tr><td>Πλοήγηση</td><td class="num">${r.from.name} → ${r.to.name}${r.canals.length ? " via " + r.canals.join(" + ") : ""}</td></tr>
    ${r.legs.map((l, i) => `<tr><td>Σκέλος ${i + 1}: ${l.from.name} → ${l.to.name}${l.canal ? " (" + l.canal.label + ")" : ""}</td><td class="num">${fmt(l.dist, 0)} nm${l.canal ? " · " + fmt(l.canal.hours, 1) + " h transit" : ""}<br>${legScheduleText(l)}</td></tr>`).join("")}
    <tr><td>Συνολική απόσταση πλόου</td><td class="num">${fmt(r.distance, 0)} nm</td></tr>
    <tr><td>Αναχώρηση (τοπική / UTC)</td><td class="num">${S.depDate} ${S.depTime} (UTC${S.depTz >= 0 ? "+" : ""}${S.depTz}) — ${dt(r.depEpoch)}</td></tr>
    <tr><td>Άφιξη (τοπική / UTC)</td><td class="num">${Number.isFinite(r.etaArrEpoch) ? new Date(r.etaArrEpoch + S.arrTz * HOUR).toLocaleString("el-GR", {timeZone: "UTC"}) + ` (UTC${S.arrTz >= 0 ? "+" : ""}${S.arrTz})` : "—"} — ${dt(r.etaArrEpoch)}</td></tr>
    <tr><td>Διάρκεια${r.transitHours > 0 ? " (πλεύσιμος χρόνος " + fmt(r.seaHours, 1) + " h)" : ""}</td><td class="num">${fmt(r.days, 2)} ημέρες (${fmt(r.hours, 1)} ώρες)</td></tr>
    <tr><td>Ταχύτητα</td><td class="num">${fmt(r.speed, 2)} kn</td></tr>
    </tbody>
    <thead><tr><th colspan="2">Καταναλώσεις ταξιδίου</th></tr></thead><tbody>
    <tr><td>LNG (m³ / t)</td><td class="num">${fmt(r.lngM3, 0)} m³ / ${fmt(r.lngT, 1)} t</td></tr>
    <tr><td>Fuel Oil (t)</td><td class="num">${fmt(r.foT, 1)}</td></tr>
    <tr><td>MDO (t)</td><td class="num">${fmt(r.mdoT, 1)}</td></tr>
    <tr><td>FOE LNG (t)</td><td class="num">${fmt(r.foeLNG, 1)}</td></tr>
    <tr><td>Συνολικό FOE (t)</td><td class="num">${fmt(r.foeTotal, 1)}</td></tr>
    </tbody>
    <thead><tr><th colspan="2">Αποθέματα (ROB)</th></tr></thead><tbody>
    <tr><td>LNG αναχώρησης</td><td class="num">${fmt(S.robLng, 0)} m³ = ${fmt(S.robLng * S.density, 1)} t</td></tr>
    <tr><td>LNG άφιξης (υπολογισμός)</td><td class="num">${fmt(r.arrRobM3, 0)} m³ = ${fmt(r.arrRobM3 * S.density, 1)} t</td></tr>
    <tr><td>LNG διαθέσιμο μετά από margin και cool-down</td><td class="num">${fmt(r.arrRobM3Margin, 0)} m³ = ${fmt(r.arrRobM3Margin * S.density, 1)} t</td></tr>
    <tr><td>FO / MDO διαθέσιμα μετά το margin</td><td class="num">${fmt(r.arrFo, 1)} t / ${fmt(r.arrMdo, 1)} t</td></tr>
    <tr><td>Safety margin</td><td class="num">${r.marginText}</td></tr>
    <tr><td>Συνολική απαιτούμενη ποσότητα LNG</td><td class="num">${fmt(r.requiredM3, 0)} m³</td></tr>
    </tbody>
    <thead><tr><th colspan="2">Εκτίμηση φορτίου στην άφιξη</th></tr></thead><tbody>
    ${cargoArrivalRows(r).map(([label, value]) => `<tr><td>${label}</td><td class="num">${value}</td></tr>`).join("")}
    </tbody>`;

  const optionalRows = analysisRows(r);
  $("analysisResults").hidden = optionalRows.length === 0;
  $("analysisResults").querySelector("tbody").innerHTML = optionalRows
    .map(([label, value]) => `<tr><td>${label}</td><td class="num">${value}</td></tr>`).join("");

  // FOE panel
  $("foeFactorOut").textContent = fmt(r.foeFactor, 3);
  if ($("foeFactorUnit")) $("foeFactorUnit").textContent = r.charterEquivalent?.fixed ? "t FOE ανά m³ LNG · συμβατικός"
    : r.charterEquivalent ? "t LSGO-eq ανά t LNG · LHV Charter Party" : "t FOE ανά t LNG";
  $("foeLngOut").textContent = bad(r.foeLNG) ? "—" : fmt(r.foeLNG, 1) + " t";
  $("foeAllOut").textContent = bad(r.foeTotal) ? "—" : fmt(r.foeTotal, 1) + " t";

  // Προειδοποιήσεις
  const warns = [...r.scheduleErrors];
  if (r.phaseForecast.rows.some((row) => row.exceedsForcing)) {
    warns.push("Η ζήτηση forced vaporization υπερβαίνει το δηλωμένο όριο σε τουλάχιστον μία φάση.");
  }
  if (Number.isFinite(r.arrRobM3Margin) && r.arrRobM3Margin < 0)
    warns.push("Το LNG ROB αναχώρησης δεν επαρκεί για το ταξίδι με το τρέχον margin — αυξήστε το ROB ή μειώστε ταχύτητα.");
  if (Number.isFinite(r.arrFo) && r.arrFo < 0)
    warns.push("Ανεπαρκές Fuel Oil ROB για τον πλόο (λ.χ. IFO/MDO min safeguards).");
  if (Number.isFinite(r.arrMdo) && r.arrMdo < 0)
    warns.push("Ανεπαρκές MDO ROB για τον πλόο.");
  if (r.rateOutsideTable)
    warns.push("Τουλάχιστον μία ταχύτητα σκέλους είναι εκτός εύρους του πίνακα καταναλώσεων — οι τιμές είναι εκτίμηση (extrapolation).");
  $("warnings").innerHTML = warns.length
    ? warns.map((w) => `<div class="alert error">${w}</div>`).join("")
    : "";
  if (!warns.length) {
    $("warnings").innerHTML = Number.isFinite(r.speed)
      ? '<div class="alert ok">Όλες οι ποσότητες επαρκείς για τον πλόο με βάση τα τρέχοντα δεδομένα.</div>'
      : "";
  }
  if (typeof renderLinkedVoyage === "function") renderLinkedVoyage(r);
  renderPhaseForecast(r);
  if (typeof renderCharterParty === "function") renderCharterParty(r);
  if (typeof renderCargoCalibration === "function") renderCargoCalibration();
  renderOperationsControls();
  runScenarios();
}

/* ---------- Tabs ---------- */
function setupTabs() {
  const tabs = document.querySelectorAll(".tab-btn");
  const panels = document.querySelectorAll(".panel");
  tabs.forEach((t) =>
    t.addEventListener("click", () => {
      tabs.forEach((x) => x.setAttribute("aria-selected", "false"));
      panels.forEach((p) => p.classList.remove("active"));
      t.setAttribute("aria-selected", "true");
      $(t.dataset.panel).classList.add("active");
      window.scrollTo({ top: 0 });
    })
  );
}

/* ---------- Εκκίνηση ---------- */
function init() {
  // Προεπιλεγμένες ημερομηνίες: αύριο + 12 ημέρες
  const d0 = new Date();
  const d1 = new Date(d0.getTime() + 12 * 86400000);
  const iso = (d) => d.toISOString().slice(0, 10);
  if (!S.depDate) S.depDate = iso(d0);
  if (!S.arrDate) S.arrDate = iso(d1);

  // Μετατροπή παλαιών αποθηκευμένων ταξιδιών (μονά σκέλος) στη νέα δομή
  S = migrateState(S);

  syncInputs();
  setupTabs();
  render();

  // — Ταξίδι: σκέλη —
  $("addLeg").addEventListener("click", () => {
    const last = S.legs[S.legs.length - 1];
    const lastSeaLeg = S.legs.findLast(leg => !legCanal(leg.fromIdx, leg.toIdx));
    S.legs.push({ fromIdx: last.toIdx, toIdx: 35, distMode: "gc", manualDist: 1000, phase: lastSeaLeg?.phase });
    S.arrTz = portTz(35);
    $("arrTz").innerHTML = tzOptions(S.arrTz);
    renderLegs(); render();
  });

  const bind = (id, key, fn = num) =>
    $(id).addEventListener("change", (e) => { S[key] = fn(e.target.value); render(); });
  bind("routingFactor", "routingFactor");
  bind("suezHours", "suezHours");
  bind("panamaHours", "panamaHours");
  bind("depDate", "depDate", (v) => v);
  bind("depTime", "depTime", (v) => v);
  bind("arrDate", "arrDate", (v) => v);
  bind("arrTime", "arrTime", (v) => v);
  bind("depTz", "depTz", num);
  bind("arrTz", "arrTz", num);
  bind("serviceSpeed", "serviceSpeed");
  document.querySelectorAll('input[name="speedMode"]').forEach((r) =>
    r.addEventListener("change", () => {
      S.speedMode = $("speedModeSpd").checked ? "speed" : "eta";
      $("serviceSpeed").disabled = S.speedMode !== "speed";
      render();
    })
  );

  // — Καταναλώσεις —
  $("addRow").addEventListener("click", () => {
    const last = S.consTable[S.consTable.length - 1] || { speed: 10, lng: 100, fo: 0, mdo: 2 };
    S.consTable.push({ speed: last.speed + 2, lng: lngConversions(last).volume + 60, fo: last.fo, mdo: last.mdo + 0.3 });
    renderConsTable(); render();
  });
  $("photoInput").addEventListener("change", (e) => {
    if (e.target.files[0]) handlePhoto(e.target.files[0]);
    e.target.value = "";
  });
  $("ocrBtn").addEventListener("click", runOcr);
  $("clearPhoto").addEventListener("click", () => {
    photoData = null;
    $("photoPreview").innerHTML = "";
    $("photoActions").style.display = "none";
    $("ocrText").textContent = "";
    $("ocrText").style.display = "none";
  });

  // — Πλοίο / φορτία —
  for (const key of ["density", "cvLNG", "cvFOE"]) {
    $(key).addEventListener("change", event => {
      const value = optionalNumber(event.target.value);
      if (value > 0) S[key] = value;
      else event.target.value = S[key];
      for (const row of S.consTable) row.lng = lngConversions(row).volume;
      syncConsConversions();
      render();
    });
  }

  bind("capacity", "capacity");
  $("fillPct").addEventListener("change", event => {
    S.fillPct = num(event.target.value);
    if (typeof cargoCalibration === "function" && cargoCalibration()) {
      renderTransferTables();
      clearTransferResults(true);
    }
    render();
  });
  bind("marginMode", "marginMode", (v) => v);
  bind("marginPct", "marginPct", (v) => v);
  bind("marginAmount", "marginAmount", (v) => v);
  for (const key of ["idleLng", "idleFo", "idleMdo"]) bind(key, key, (v) => v);
  document.querySelectorAll("[data-analysis]").forEach((input) =>
    input.addEventListener("change", () => {
      S.analysis[input.dataset.analysis] = input.value;
      if (input.dataset.analysis === "heel") {
        for (const field of document.querySelectorAll('[data-analysis="heel"]')) field.value = input.value;
      }
      render();
    })
  );
  bind("coolTanks", "coolTanks");
  bind("coolLine", "coolLine");


  bind("robLng", "robLng");
  bind("robFo", "robFo");
  bind("robMdo", "robMdo");

  // — Ενέργειες —
  $("btnSave").addEventListener("click", saveVoyage);
  $("btnLoad").addEventListener("click", openLoadModal);
  $("btnExport").addEventListener("click", exportJson);
  $("btnReport").addEventListener("click", exportReport);
  $("btnPrint").addEventListener("click", () => window.print());
  $("btnReport2").addEventListener("click", exportReport);
  $("btnPrint2").addEventListener("click", () => window.print());
  $("btnImport").addEventListener("change", (e) => {
    if (e.target.files[0]) importJson(e.target.files[0]);
    e.target.value = "";
  });
  $("modalClose").addEventListener("click", () => $("loadModal").classList.remove("open"));
  $("loadModal").addEventListener("click", (e) => {
    if (e.target === $("loadModal")) $("loadModal").classList.remove("open");
  });

  // Θέμα (προαιρετικό toggle)
  $("themeToggle").addEventListener("click", () => {
    const cur = document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light";
    document.documentElement.setAttribute("data-theme", cur);
    store.set("theme", cur);
  });
  const savedTheme = store.get("theme");
  if (savedTheme) document.documentElement.setAttribute("data-theme", savedTheme);
  else if (window.matchMedia("(prefers-color-scheme: light)").matches)
    document.documentElement.setAttribute("data-theme", "light");

  // Συντομεύσεις: Ctrl+S αποθήκευση
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); saveVoyage(); }
  });
}

document.addEventListener("DOMContentLoaded", init);
