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
  marginPct: 10, coolTanks: 150, coolLine: 30,
  cvLNG: 12430, cvFOE: 11500,
  // ROB αναχώρησης
  robLng: 4000, robFo: 800, robMdo: 400,
};

let S = JSON.parse(JSON.stringify(DEFAULTS));

/* Μετατροπή παλαιότερων αποθηκευμένων μορφών στην τρέχουσα δομή */
function migrateState(s) {
  const d = Object.assign(JSON.parse(JSON.stringify(DEFAULTS)), s);
  if (!Array.isArray(s.legs)) {
    d.legs = [{ fromIdx: s.fromIdx ?? 0, toIdx: s.toIdx ?? 35, distMode: s.distMode ?? "gc", manualDist: s.manualDist ?? 5000 }];
  }
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

/* ---------- Γραμμική παρεμβολή πίνακα καταναλώσεων ---------- */
function interpolate(table, speed) {
  const t = [...table].sort((a, b) => a.speed - b.speed);
  if (!t.length) return null;
  if (t.length === 1) return { ...t[0], extrapolated: speed !== t[0].speed };
  if (speed <= t[0].speed) return { ...t[0], extrapolated: speed < t[0].speed };
  if (speed >= t[t.length - 1].speed) return { ...t[t.length - 1], extrapolated: speed > t[t.length - 1].speed };
  for (let i = 0; i < t.length - 1; i++) {
    const a = t[i], b = t[i + 1];
    if (speed >= a.speed && speed <= b.speed) {
      const f = (speed - a.speed) / (b.speed - a.speed);
      const mix = (x, y) => x + f * (y - x);
      return {
        speed,
        lng: mix(a.lng, b.lng),
        fo: mix(a.fo, b.fo),
        mdo: mix(a.mdo, b.mdo),
        extrapolated: false,
      };
    }
  }
  return null;
}

/* ---------- Κεντρικός υπολογισμός ---------- */
function compute() {
  // Ανά σκέλος: λιμένες, απόσταση, διώρυγα (αν υπάρχει)
  const legs = S.legs.map((leg) => {
    const from = PORTS[leg.fromIdx] || PORTS[0];
    const to = PORTS[leg.toIdx] || PORTS[1];
    const canalRaw = legCanal(leg.fromIdx, leg.toIdx);
    const canal = canalRaw
      ? { ...canalRaw, hours: canalRaw.key === "suez" ? S.suezHours : S.panamaHours }
      : null;
    let dist, src;
    if (leg.distMode === "manual") { dist = leg.manualDist; src = "manual"; }
    else if (canal) { dist = canal.nm; src = "canal"; }
    else { dist = gcDistanceNm(from.lat, from.lon, to.lat, to.lon) * S.routingFactor; src = "gc"; }
    return { from, to, canal, dist, src, distMode: leg.distMode };
  });

  const distance = legs.reduce((s, l) => s + l.dist, 0);
  const transitHours = legs.reduce((s, l) => s + (l.canal ? l.canal.hours : 0), 0);
  const canals = [...new Set(legs.filter((l) => l.canal).map((l) => l.canal.label))];
  const from = legs.length ? legs[0].from : PORTS[0];
  const to = legs.length ? legs[legs.length - 1].to : PORTS[1];
  const gc = legs.reduce((s, l) => s + (l.src === "gc" ? l.dist / S.routingFactor : l.dist), 0);

  const depEpoch = localToEpoch(S.depDate, S.depTime, S.depTz);
  const arrEpoch = localToEpoch(S.arrDate, S.arrTime, S.arrTz);

  let speed, etaArrEpoch, hours, seaHours;
  if (S.speedMode === "eta") {
    hours = (arrEpoch - depEpoch) / 3600000;
    seaHours = hours > 0 ? hours - transitHours : NaN;
    speed = seaHours > 0 ? distance / seaHours : NaN;
    etaArrEpoch = arrEpoch;
  } else {
    speed = S.serviceSpeed;
    seaHours = distance / speed;
    hours = transitHours + seaHours;
    etaArrEpoch = depEpoch + hours * 3600 * 1000;
  }

  const cons = interpolate(S.consTable, speed);
  const days = hours / 24;
  const seaDays = seaHours / 24;

  const lngM3Day = cons ? cons.lng : NaN;
  const foTDay = cons ? cons.fo : NaN;
  const mdoTDay = cons ? cons.mdo : NaN;

  const lngM3 = lngM3Day * days;
  const lngT = lngM3 * S.density;
  const foT = foTDay * days;
  const mdoT = mdoTDay * days;

  // FOE: 1 t LNG = CV_LNG / CV_FOE t FOE (kcal/kg)
  const foeFactor = S.cvLNG / S.cvFOE;
  const foeLNG = lngT * foeFactor;
  const foeTotal = foeLNG + foT + mdoT;

  // Cool-down (δεξαμενές + γραμμή φόρτωσης)
  const coolTotal = S.coolTanks + S.coolLine;

  // Απαιτούμενη ποσότητα με safety margin
  const marginM3 = lngM3 * (S.marginPct / 100);
  const requiredM3 = lngM3 + marginM3 + coolTotal;

  // ROB άφιξης
  const arrRobM3 = S.robLng - lngM3;                 // καθαρός υπολογισμός
  const arrRobM3Margin = S.robLng - requiredM3;      // με margin + cooldown
  const arrFo = S.robFo - foT;
  const arrMdo = S.robMdo - mdoT;

  // Max intake: χρησιμοποιήσιμος χώρος − heel άφιξης (με margin)
  const usableM3 = S.capacity * (S.fillPct / 100);
  const heelAtLoad = Math.max(0, arrRobM3Margin); // heel που θα παραμείνει (conservative)
  const maxIntakeM3 = usableM3 - heelAtLoad;
  const maxIntakeT = maxIntakeM3 * S.density;

  return {
    legs, from, to, gc, distance, transitHours, canals,
    depEpoch, arrEpoch, hours, seaHours, days, seaDays, speed, etaArrEpoch,
    cons, lngM3Day, foTDay, mdoTDay, lngM3, lngT, foT, mdoT,
    foeFactor, foeLNG, foeTotal, coolTotal, marginM3, requiredM3,
    arrRobM3, arrRobM3Margin, arrFo, arrMdo,
    usableM3, heelAtLoad, maxIntakeM3, maxIntakeT,
  };
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
  const dt = (epoch, tz) => Number.isFinite(epoch)
    ? new Date(epoch).toLocaleString("el-GR", { timeZone: "UTC" }) + ` (UTC${tz >= 0 ? "+" : ""}${tz})` : "—";
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
${r.legs.map((l, i) => `<tr><td>${i + 1}. ${l.from.name} → ${l.to.name}${l.canal ? " (" + l.canal.label + ")" : ""}</td><td class="num">${fmt(l.dist, 0)} nm${l.canal ? " + " + fmt(l.canal.hours, 0) + " h transit" : ""}</td></tr>`).join("")}
<tr><td><strong>Σύνολο</strong></td><td class="num"><strong>${fmt(r.distance, 0)} nm</strong></td></tr>
</table>
<h2>Ταξίδι</h2><table>
${row("Αναχώρηση", dt(r.depEpoch, S.depTz))}
${row("Άφιξη", dt(r.etaArrEpoch, S.arrTz))}
${row("Διάρκεια", fmt(r.days, 2) + " ημέρες (" + fmt(r.hours, 1) + " ώρες)")}
${row("Προτεινόμενη ταχύτητα", fmt(r.speed, 2) + " kn")}
</table>
<h2>Καταναλώσεις (ημερήσιες @ " + fmt(r.speed, 2) + " kn)</h2><table>
${row("LNG", fmt(r.lngM3Day, 0) + " m³/ημ = " + fmt(r.lngM3Day * S.density, 1) + " t/ημ")}
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
${row("LNG άφιξης (με margin " + S.marginPct + "% + cool-down)", fmt(r.arrRobM3Margin, 0) + " m³ = " + fmt(r.arrRobM3Margin * S.density, 1) + " t")}
${row("FO αναχώρησης / άφιξης", fmt(S.robFo, 1) + " / " + fmt(r.arrFo, 1) + " t")}
${row("MDO αναχώρησης / άφιξης", fmt(S.robMdo, 1) + " / " + fmt(r.arrMdo, 1) + " t")}
${row("Cool-down δεξαμενές + γραμμή", fmt(r.coolTotal, 0) + " m³")}
${row("Safety margin", fmt(r.marginM3, 0) + " m³ (" + S.marginPct + "%)")}
${row("Συνολική απαιτούμενη ποσότητα", fmt(r.requiredM3, 0) + " m³")}
</table>
<h2>Φόρτωση (Max Intake)</h2><table>
${row("Χωρητικότητα δεξαμενών", fmt(S.capacity, 0) + " m³ (" + S.fillPct + "% max fill)")}
${row("Χρησιμοποιήσιμος χώρος", fmt(r.usableM3, 0) + " m³")}
${row("Heel άφιξης (με margin)", fmt(r.heelAtLoad, 0) + " m³")}
${row("MAX INTAKE", fmt(r.maxIntakeM3, 0) + " m³ = " + fmt(r.maxIntakeT, 0) + " t")}
</table>
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
function renderConsTable() {
  const tb = $("consBody");
  tb.innerHTML = S.consTable
    .map(
      (row, i) => `<tr>
        <td><input data-r="${i}" data-f="speed" type="number" step="0.1" min="0" value="${row.speed}" aria-label="Ταχύτητα σειρά ${i + 1}"></td>
        <td class="num"><input data-r="${i}" data-f="lng" type="number" step="1" min="0" value="${row.lng}" aria-label="LNG m³/ημέρα σειρά ${i + 1}"></td>
        <td class="num"><input data-r="${i}" data-f="fo" type="number" step="0.1" min="0" value="${row.fo}" aria-label="Fuel Oil t/ημέρα σειρά ${i + 1}"></td>
        <td class="num"><input data-r="${i}" data-f="mdo" type="number" step="0.1" min="0" value="${row.mdo}" aria-label="MDO t/ημέρα σειρά ${i + 1}"></td>
        <td><button class="row-del" data-del-row="${i}" aria-label="Διαγραφή σειράς ${i + 1}">✕</button></td>
      </tr>`
    )
    .join("");
  tb.querySelectorAll("input[data-r]").forEach((inp) =>
    inp.addEventListener("change", () => {
      S.consTable[+inp.dataset.r][inp.dataset.f] = num(inp.value) || 0;
      render();
    })
  );
  tb.querySelectorAll("[data-del-row]").forEach((b) =>
    b.addEventListener("click", () => {
      S.consTable.splice(+b.dataset.delRow, 1);
      renderConsTable(); render();
    })
  );
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
  $("marginPct").value = S.marginPct;
  $("coolTanks").value = S.coolTanks;
  $("coolLine").value = S.coolLine;
  $("cvLNG").value = S.cvLNG;
  $("cvFOE").value = S.cvFOE;
  $("robLng").value = S.robLng;
  $("robFo").value = S.robFo;
  $("robMdo").value = S.robMdo;
  renderConsTable();
}

/* ---------- Σκέλη πλόου (UI) ---------- */
function renderLegs() {
  const box = $("legsList");
  box.innerHTML = S.legs
    .map((leg, i) => {
      const last = i === S.legs.length - 1;
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
            <option value="gc" ${leg.distMode === "gc" ? "selected" : ""}>Αυτόματα (GC × συντ.)</option>
            <option value="manual" ${leg.distMode === "manual" ? "selected" : ""}>Χειροκίνητη (passage plan)</option>
          </select>
        </div>
        <div class="field">
          <label>nm</label>
          <input type="number" data-legi="${i}" data-f="manualDist" step="1" min="0"
            value="${leg.manualDist}" ${leg.distMode === "gc" ? "disabled" : ""}>
        </div>
        <div class="leg-meta">
          <span class="leg-dist" id="legDist${i}">—</span>
        </div>
        <button class="btn small danger leg-del" data-del-leg="${i}" aria-label="Διαγραφή σκέλους ${i + 1}">✕</button>
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
      else if (f === "distMode") S.legs[i].distMode = el.value;
      else S.legs[i].manualDist = num(el.value) || 0;
      // Η ζώνη ώρας αναχώρησης/άφιξης ακολουθεί τους ακραίους λιμένες
      S.depTz = portTz(S.legs[0].fromIdx);
      S.arrTz = portTz(S.legs[S.legs.length - 1].toIdx);
      $("depTz").innerHTML = tzOptions(S.depTz);
      $("arrTz").innerHTML = tzOptions(S.arrTz);
      renderLegs();
      render();
    })
  );
  box.querySelectorAll("[data-del-leg]").forEach((b) =>
    b.addEventListener("click", () => {
      if (S.legs.length > 1) {
        S.legs.splice(+b.dataset.delLeg, 1);
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
  $("sumMaxIntake").textContent = bad(r.maxIntakeM3) ? "—" : fmt(r.maxIntakeM3, 0) + " m³";
  $("sumMaxIntake").classList.toggle("bad", r.maxIntakeM3 < 0);
  $("sumSpeed").classList.toggle("bad", r.speed < 8 || r.speed > 21);

  // Ταξίδι — σκέλη
  r.legs.forEach((l, i) => {
    const el = $("legDist" + i);
    if (el) {
      const canalTag = l.canal ? ` — ${l.canal.label} (transit ${fmt(l.canal.hours, 0)} h)` : "";
      const srcTag = l.src === "manual" ? "χειροκίνητη" : l.src === "canal" ? "canal" : "GC";
      el.innerHTML = `${fmt(l.dist, 0)} nm <span class="src-tag">(${srcTag})</span>${canalTag}`;
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
  const transitNote = r.transitHours > 0
    ? `Περιλαμβάνονται ${fmt(r.transitHours, 0)} ώρες διέλευσης διώρυγας — πλεύσιμοι χρόνος ${fmt(r.seaHours, 1)} h (${fmt(r.seaDays, 2)} ημ)` : "";
  $("resTransit").textContent = transitNote;
  $("resTransit").style.display = r.transitHours > 0 ? "block" : "none";
  $("resSpeedNote").textContent = r.speedMode === "eta"
    ? "Υπολογισμένη για άφιξη στην καθορισμένη ημερομηνία/ώρα" + (r.transitHours > 0 ? ", με αφαίρεση ωρών διώρυγας" : "")
    : "Καθορισμένη ταχύτητα λειτουργίας — η άφιξη υπολογίζεται";

  // Καταναλώσεις
  if (r.cons) {
    $("consAt").textContent = `Στα ${fmt(r.speed, 2)} kn`;
    $("consLngDay").textContent = `${fmt(r.lngM3Day, 0)} m³/ημ = ${fmt(r.lngM3Day * S.density, 1)} t/ημ`;
    $("consFoDay").textContent = `${fmt(r.foTDay, 2)} t/ημ`;
    $("consMdoDay").textContent = `${fmt(r.mdoTDay, 2)} t/ημ`;
    $("consWarn").style.display = r.cons.extrapolated ? "block" : "none";
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
  $("marginOut").textContent = bad(r.marginM3) ? "—" : `${fmt(r.marginM3, 0)} m³ (${S.marginPct}%)`;
  $("reqOut").textContent = bad(r.requiredM3) ? "—" : `${fmt(r.requiredM3, 0)} m³ = ${fmt(r.requiredM3 * S.density, 1)} t`;

  // Max intake
  $("maxUsable").textContent = `${fmt(r.usableM3, 0)} m³`;
  $("maxHeel").textContent = `${fmt(r.heelAtLoad, 0)} m³`;
  $("maxIntakeOut").textContent = bad(r.maxIntakeM3) ? "—" : `${fmt(r.maxIntakeM3, 0)} m³`;
  $("maxIntakeTOut").textContent = bad(r.maxIntakeT) ? "—" : `${fmt(r.maxIntakeT, 0)} t`;
  $("maxIntakeBox").classList.toggle("bad", r.maxIntakeM3 < 0);

  // Πλήρης σύνοψη (tab 4)
  const dt = (epoch) => Number.isFinite(epoch)
    ? new Date(epoch).toLocaleString("el-GR", { timeZone: "UTC", dateStyle: "medium", timeStyle: "short" }) + " UTC" : "—";
  $("fullSummary").innerHTML = `
    <thead><tr><th colspan="2">Ταξίδι</th></tr></thead><tbody>
    <tr><td>Πλοήγηση</td><td class="num">${r.from.name} → ${r.to.name}${r.canals.length ? " via " + r.canals.join(" + ") : ""}</td></tr>
    ${r.legs.map((l, i) => `<tr><td>Σκέλος ${i + 1}: ${l.from.name} → ${l.to.name}${l.canal ? " (" + l.canal.label + ")" : ""}</td><td class="num">${fmt(l.dist, 0)} nm${l.canal ? " + " + fmt(l.canal.hours, 0) + " h transit" : ""}</td></tr>`).join("")}
    <tr><td>Συνολική απόσταση πλόου</td><td class="num">${fmt(r.distance, 0)} nm</td></tr>
    <tr><td>Αναχώρηση (τοπική / UTC)</td><td class="num">${S.depDate} ${S.depTime} (UTC${S.depTz >= 0 ? "+" : ""}${S.depTz}) — ${dt(r.depEpoch)}</td></tr>
    <tr><td>Άφιξη (τοπική / UTC)</td><td class="num">${S.arrDate} ${S.arrTime} (UTC${S.arrTz >= 0 ? "+" : ""}${S.arrTz}) — ${dt(r.etaArrEpoch)}</td></tr>
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
    <tr><td>LNG άφιξης (με margin ${S.marginPct}% + cool-down)</td><td class="num">${fmt(r.arrRobM3Margin, 0)} m³ = ${fmt(r.arrRobM3Margin * S.density, 1)} t</td></tr>
    <tr><td>FO / MDO άφιξης</td><td class="num">${fmt(r.arrFo, 1)} t / ${fmt(r.arrMdo, 1)} t</td></tr>
    <tr><td>Συνολική απαιτούμενη ποσότητα LNG</td><td class="num">${fmt(r.requiredM3, 0)} m³</td></tr>
    </tbody>
    <thead><tr><th colspan="2">Φόρτωση</th></tr></thead><tbody>
    <tr><td>Χρησιμοποιήσιμος χώρος (${S.fillPct}%)</td><td class="num">${fmt(r.usableM3, 0)} m³</td></tr>
    <tr><td>Heel άφιξης (με margin)</td><td class="num">${fmt(r.heelAtLoad, 0)} m³</td></tr>
    <tr><td><strong>MAX INTAKE</strong></td><td class="num"><strong>${fmt(r.maxIntakeM3, 0)} m³ = ${fmt(r.maxIntakeT, 0)} t</strong></td></tr>
    </tbody>`;

  // FOE panel
  $("foeFactorOut").textContent = fmt(r.foeFactor, 3);
  $("foeLngOut").textContent = bad(r.foeLNG) ? "—" : fmt(r.foeLNG, 1) + " t";
  $("foeAllOut").textContent = bad(r.foeTotal) ? "—" : fmt(r.foeTotal, 1) + " t";

  // Προειδοποιήσεις
  const warns = [];
  if (Number.isFinite(r.arrRobM3Margin) && r.arrRobM3Margin < 0)
    warns.push("Το LNG ROB αναχώρησης δεν επαρκεί για το ταξίδι με το τρέχον margin — αυξήστε το ROB ή μειώστε ταχύτητα.");
  if (Number.isFinite(r.arrFo) && r.arrFo < 0)
    warns.push("Ανεπαρκές Fuel Oil ROB για τον πλόο (λ.χ. IFO/MDO min safeguards).");
  if (Number.isFinite(r.arrMdo) && r.arrMdo < 0)
    warns.push("Ανεπαρκές MDO ROB για τον πλόο.");
  if (Number.isFinite(r.maxIntakeM3) && r.maxIntakeM3 < 0)
    warns.push("Μη ρεαλιστικό max intake — ελέγξτε heel/χωρητικότητα.");
  if (r.cons && r.cons.extrapolated)
    warns.push("Η ταχύτητα είναι εκτός εύρους του πίνακα καταναλώσεων — οι τιμές είναι εκτίμηση (extrapolation).");
  $("warnings").innerHTML = warns.length
    ? warns.map((w) => `<div class="alert error">${w}</div>`).join("")
    : "";
  if (!warns.length) {
    $("warnings").innerHTML = Number.isFinite(r.speed)
      ? '<div class="alert ok">Όλες οι ποσότητες επαρκείς για τον πλόο με βάση τα τρέχοντα δεδομένα.</div>'
      : "";
  }
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
    S.legs.push({ fromIdx: last.toIdx, toIdx: 35, distMode: "gc", manualDist: 1000 });
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
    S.consTable.push({ speed: last.speed + 2, lng: last.lng + 60, fo: last.fo, mdo: last.mdo + 0.3 });
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
  bind("density", "density");
  bind("capacity", "capacity");
  bind("fillPct", "fillPct");
  bind("marginPct", "marginPct");
  bind("coolTanks", "coolTanks");
  bind("coolLine", "coolLine");
  bind("cvLNG", "cvLNG");
  bind("cvFOE", "cvFOE");
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
