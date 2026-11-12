"use strict";

const transferKinds = {
  up: "Ramp-up", bulk: "Σταθερή παροχή", down: "Ramp-down", top: "Topping-off",
  strip: "Stripping", pause: "Παύση / αλλαγή setup",
};
const transferTables = {
  tanks: {
    title: "Δεξαμενές",
    hint: "Το μέγιστο m³ είναι ο επιτρεπτός όγκος εργασίας. Το όριο topping-off εφαρμόζεται σε στάδια Topping-off, τα οποία μπορούν να περιλαμβάνουν μείωση παροχής. Στην εκφόρτωση, το αντίστοιχο όριο εφαρμόζεται στο Stripping.",
    fields: [["id", "Tank"], ["start", "Αρχικά m³", "number"], ["target", "Στόχος m³", "number"],
      ["min", "Ελάχιστα m³", "number"], ["max", "Μέγιστα m³", "number"], ["capacity", "Χωρητικότητα 100% m³", "number"],
      ["rate", "Μέγ. m³/h", "number"],
      ["finalRate", "Όριο topping/strip m³/h", "number"], ["topStart", "Έναρξη topping m³ (προαιρετικό)", "number"]],
  },
  pumps: {
    title: "Αντλίες / ομάδες",
    hint: "Δήλωσε την εγκεκριμένη παροχή ανά αντλία στο σχεδιαζόμενο σημείο λειτουργίας. Το προαιρετικό min αφορά κάθε αντλία που δηλώνεται σε λειτουργία στο στάδιο.",
    fields: [["id", "Ομάδα"], ["count", "Διαθέσιμες", "number"], ["rate", "m³/h ανά αντλία", "number"],
      ["min", "Min m³/h ανά αντλία", "number"]],
  },
  valves: {
    title: "Βαλβίδες και κοινά τμήματα γραμμής",
    hint: "Κάθε κοινό στοιχείο δηλώνεται μία φορά. Το όριό του ελέγχεται στο άθροισμα της παροχής όλων των διαδρομών που το χρησιμοποιούν. Αποεπίλεξε «Διαθέσιμη» για κλειστή ή απομονωμένη γραμμή.",
    fields: [["id", "Valve / line"], ["enabled", "Διαθέσιμη", "checkbox"], ["rate", "Μέγ. m³/h", "number"]],
  },
  routes: {
    title: "Διαδρομές μεταφοράς",
    hint: "Πρόσθεσε μόνο εγκεκριμένα setups. Βάλε προαιρετικά μία ομάδα αντλιών και τις βαλβίδες ή γραμμές σε σειρά, π.χ. V1,V2. Μία διαδρομή αντιστοιχεί σε μία δεξαμενή.",
    fields: [["id", "Route"], ["tank", "Tank ID"], ["pump", "Pump group ID"], ["valves", "Valve / line IDs"],
      ["rate", "Όριο διαδρομής m³/h", "number"], ["setup", "Αναφορά setup / σημείωση"]],
  },
  stages: {
    title: "Στάδια με τη σειρά εκτέλεσης",
    hint: "Δήλωσε αρχική και τελική παροχή και διάρκεια ανά στάδιο. Μοίρασε την παροχή π.χ. R1:60,R2:40. Η κατανομή μένει σταθερή μέσα στο στάδιο. Στο «Αντλίες σε λειτουργία» βάλε π.χ. P1:1. Κενό χρησιμοποιεί όλες τις διαθέσιμες αντλίες της ενεργής ομάδας. Κενή διάρκεια σε ένα μόνο στάδιο σταθερής θετικής παροχής υπολογίζει τον χρόνο από τους στόχους των tanks.",
    fields: [["kind", "Στάδιο", "kind"], ["minutes", "Λεπτά", "number"], ["start", "Αρχή m³/h", "number"],
      ["end", "Τέλος m³/h", "number"], ["split", "Route ID : %"], ["online", "Αντλίες σε λειτουργία"],
      ["cap", "Όριο σταδίου m³/h", "number"]],
  },
};

const txIdPattern = /^[A-Za-z0-9_-]+$/;
const txNum = (value) => value === "" || value == null ? NaN : Number(value);
const txBlank = (value) => value === "" || value == null;
const txDisplay = (value, digits = 1) => fmt(value, digits);

function transferPlan() {
  const state = S.transfer ??= {};
  const mode = state.mode === "unloading" ? "unloading" : "loading";
  const plan = state[mode] ??= {};
  for (const key of Object.keys(transferTables)) plan[key] ??= [];
  return plan;
}

function txPairs(input, label, errors) {
  const result = new Map();
  if (txBlank(input)) return result;
  for (const token of String(input).split(",")) {
    const parts = token.split(":").map((part) => part.trim());
    const [id, raw] = parts;
    const amount = txNum(raw);
    if (parts.length !== 2 || !txIdPattern.test(id) || !Number.isFinite(amount) || amount < 0 || result.has(id)) {
      errors.push(`${label}: έλεγξε τα αναγνωριστικά και τις τιμές.`);
      continue;
    }
    result.set(id, amount);
  }
  return result;
}

function txRateCeiling(value) {
  return txBlank(value) ? Infinity : txNum(value);
}

function calculateTransfer(plan, mode) {
  const errors = [];
  const warnings = [];
  const loading = mode === "loading";
  const sign = loading ? 1 : -1;
  const error = (message) => errors.push(message);
  const numberFields = (row, fields, label) => {
    for (const [key, title, type] of fields) {
      if (type === "number" && !txBlank(row[key]) && !(txNum(row[key]) >= 0 && Number.isFinite(txNum(row[key])))) {
        error(`${label}: μη έγκυρη τιμή στο «${title}».`);
      }
    }
  };
  const index = (key) => {
    const map = new Map();
    for (const row of plan[key] || []) {
      const id = String(row.id ?? "").trim();
      if (!txIdPattern.test(id) || map.has(id)) {
        error(`${transferTables[key].title}: απαιτείται μοναδικό αναγνωριστικό με λατινικούς χαρακτήρες, αριθμούς, _ ή -.`);
        continue;
      }
      numberFields(row, transferTables[key].fields, id);
      map.set(id, row);
    }
    return map;
  };

  const tanks = index("tanks");
  const pumps = index("pumps");
  const valves = index("valves");
  const routes = index("routes");
  const stages = plan.stages || [];
  const globalFields = [["terminal", "terminal"], ["manifold", "manifold / arms"], ["vapour", "vapour / άλλο κοινό όριο"],
    ["rampUp", "ramp-up"], ["rampDown", "ramp-down"]];
  for (const [key, label] of globalFields) {
    if (!txBlank(plan[key]) && !(Number.isFinite(txNum(plan[key])) && txNum(plan[key]) >= 0)) error(`Μη έγκυρο όριο ${label}.`);
  }
  if (!tanks.size || !stages.length) error("Πρόσθεσε τουλάχιστον μία δεξαμενή και ένα στάδιο.");
  const balances = new Map();
  let targetVolume = 0;
  for (const [id, tank] of tanks) {
    const start = txNum(tank.start);
    const target = txNum(tank.target);
    const min = txBlank(tank.min) ? 0 : txNum(tank.min);
    const max = txRateCeiling(tank.max);
    if (!Number.isFinite(start) || !Number.isFinite(target) || start < min || start > max || target < min || target > max || (target - start) * sign < 0) {
      error(`${id}: ο αρχικός όγκος και ο στόχος πρέπει να συμφωνούν με την κατεύθυνση και τα όρια της δεξαμενής.`);
    }
    balances.set(id, { start, target, min, max, volume: start });
    targetVolume += (target - start) * sign;
  }
  for (const [id, pump] of pumps) {
    const count = txNum(pump.count);
    const rate = txNum(pump.rate);
    if (!(Number.isInteger(count) && count >= 1 && rate > 0 && Number.isFinite(rate)) || txNum(pump.min) > rate) {
      error(`${id}: δήλωσε θετικό ακέραιο αριθμό αντλιών και έγκυρη παροχή ανά αντλία.`);
    }
  }
  for (const [id, route] of routes) {
    const tank = String(route.tank ?? "").trim();
    const pump = String(route.pump ?? "").trim();
    const chain = txBlank(route.valves) ? [] : String(route.valves).split(",").map((v) => v.trim());
    if (!tanks.has(tank) || (pump && !pumps.has(pump)) || chain.some((v) => !valves.has(v)) || new Set(chain).size !== chain.length) {
      error(`${id}: έλεγξε το tank, την ομάδα αντλιών και τα IDs των βαλβίδων / γραμμών.`);
    }
    routes.set(id, { ...route, tank, pump, chain });
  }
  if (errors.length) return { errors, warnings };

  let fixedVolume = 0;
  let autoIndex = -1;
  const stageData = stages.map((stage, i) => {
    const label = `${i + 1}. ${transferKinds[stage.kind] ?? "Στάδιο"}`;
    numberFields(stage, transferTables.stages.fields, label);
    const start = txNum(stage.start);
    const end = txNum(stage.end);
    const peak = Math.max(start, end);
    let minutes = txNum(stage.minutes);
    const split = txPairs(stage.split, label, errors);
    const online = txPairs(stage.online, label, errors);
    if (!Object.hasOwn(transferKinds, stage.kind) || ![start, end].every((n) => Number.isFinite(n) && n >= 0)) error(`${label}: δήλωσε τύπο και παροχές αρχής/τέλους.`);
    if ((stage.kind === "up" && end <= start) || (stage.kind === "down" && end >= start)
        || (stage.kind === "bulk" && (end !== start || peak <= 0)) || (stage.kind === "pause" && peak !== 0)
        || (stage.kind !== "pause" && peak === 0)) error(`${label}: οι παροχές δεν αντιστοιχούν στον τύπο του σταδίου.`);
    const sum = [...split.values()].reduce((a, b) => a + b, 0);
    if (peak > 0 && (Math.abs(sum - 100) > 1e-6 || [...split].some(([id, n]) => !routes.has(id) || n <= 0))) {
      error(`${label}: οι ενεργές διαδρομές πρέπει να υπάρχουν και τα ποσοστά να αθροίζουν σε 100%.`);
    }
    if (peak === 0 && (split.size || online.size)) error(`${label}: η παύση πρέπει να έχει κενές διαδρομές και αντλίες.`);
    const average = (start + end) / 2;
    if (txBlank(stage.minutes)) {
      if (stage.kind !== "bulk" || autoIndex >= 0 || !(average > 0) || start !== end) error(`${label}: επιτρέπεται μόνο ένα αυτόματο στάδιο σταθερής παροχής.`);
      else autoIndex = i;
    } else {
      if (!(minutes > 0)) error(`${label}: η διάρκεια πρέπει να είναι θετική.`);
      fixedVolume += average * minutes / 60;
    }
    return { ...stage, label, start, end, peak, minutes, average, split, online };
  });
  if (autoIndex >= 0) {
    const hold = stageData[autoIndex];
    hold.minutes = (targetVolume - fixedVolume) * 60 / hold.average;
    if (hold.minutes < -1e-7) error("Ο όγκος των καθορισμένων σταδίων ξεπερνά τους συνολικούς στόχους δεξαμενών.");
    else hold.minutes = Math.max(0, hold.minutes);
  }
  if (errors.length) return { errors, warnings };

  const startEpoch = opsDate(plan.start);
  let elapsed = 0;
  let total = 0;
  const checks = [];
  for (const [i, stage] of stageData.entries()) {
    const { label, start, end, peak, minutes, average, split, online } = stage;
    const groups = { tanks: new Map(), pumps: new Map(), valves: new Map() };
    const limits = [
      ["Terminal", txRateCeiling(plan.terminal)], ["Manifold / arms", txRateCeiling(plan.manifold)],
      ["Vapour / άλλο κοινό όριο", txRateCeiling(plan.vapour)], ["Όριο σταδίου", txRateCeiling(stage.cap)],
    ];
    const share = (map, id, fraction) => map.set(id, (map.get(id) || 0) + fraction);
    const applyLimit = (name, limit, fraction) => limits.push([name, limit / fraction]);
    const stageRoutes = [];
    for (const [id, percent] of split) {
      const fraction = percent / 100;
      const route = routes.get(id);
      share(groups.tanks, route.tank, fraction);
      if (route.pump) share(groups.pumps, route.pump, fraction);
      for (const valve of route.chain) share(groups.valves, valve, fraction);
      applyLimit(`Route ${id}`, txRateCeiling(route.rate), fraction);
      stageRoutes.push([id, route]);
    }
    for (const [id, fraction] of groups.tanks) {
      const tank = tanks.get(id);
      applyLimit(`Tank ${id}`, txRateCeiling(tank.rate), fraction);
      if (loading ? stage.kind === "top" : stage.kind === "strip") {
        applyLimit(`Tank ${id} topping/strip`, txRateCeiling(tank.finalRate), fraction);
      }
    }
    const pumpNotes = [];
    for (const [id, fraction] of groups.pumps) {
      const pump = pumps.get(id);
      const count = online.get(id) ?? txNum(pump.count);
      if (!Number.isInteger(count) || count < 1 || count > txNum(pump.count)) error(`${label}: μη διαθέσιμο πλήθος αντλιών στην ομάδα ${id}.`);
      applyLimit(`Αντλίες ${id}`, count * txNum(pump.rate), fraction);
      const minimum = txNum(pump.min);
      if (minimum > 0 && Math.min(start, end) * fraction < count * minimum - 1e-7 && minutes > 0) {
        error(`${label}: η ομάδα ${id} πέφτει κάτω από τη δηλωμένη ελάχιστη παροχή για ${count} αντλίες.`);
      }
      pumpNotes.push(`${id} × ${count}`);
    }
    for (const id of online.keys()) if (!groups.pumps.has(id)) error(`${label}: η ομάδα ${id} δεν ανήκει σε ενεργή διαδρομή.`);
    for (const [id, fraction] of groups.valves) {
      const valve = valves.get(id);
      if (valve.enabled === false) error(`${label}: η διαδρομή χρησιμοποιεί κλειστή/απομονωμένη βαλβίδα ή γραμμή ${id}.`);
      applyLimit(`Βαλβίδα / γραμμή ${id}`, txRateCeiling(valve.rate), fraction);
    }

    const binding = limits.reduce((min, item) => item[1] < min[1] ? item : min);
    if (peak > binding[1] + 1e-7) error(`${label}: ${binding[0]} επιτρέπει έως ${txDisplay(binding[1])} m³/h για αυτή την κατανομή. Ζητήθηκαν ${txDisplay(peak)}.`);
    const slope = minutes > 0 ? (end - start) / minutes : 0;
    if (slope > txRateCeiling(plan.rampUp) + 1e-7 || -slope > txRateCeiling(plan.rampDown) + 1e-7) {
      error(`${label}: υπέρβαση του δηλωμένου ρυθμού μεταβολής παροχής.`);
    }
    const previous = stageData[i - 1];
    if (Math.abs(start - (previous?.end ?? 0)) > 1e-7) error(`${label}: η αρχική παροχή πρέπει να συνεχίζει από την προηγούμενη τελική παροχή (αρχικά 0).`);
    if (previous && start > 0 && (stage.split.size !== previous.split.size
        || [...stage.split].some(([id, value]) => previous.split.get(id) !== value))) {
      warnings.push(`${label}: αλλαγή κατανομής ή διαδρομής με μη μηδενική παροχή. Το μοντέλο ελέγχει κάθε σταθερό setup χωριστά.`);
    }
    if (previous && start > 0 && checks.at(-1)?.pumps !== pumpNotes.join(" · ")) {
      warnings.push(`${label}: αλλαγή αριθμού ή ομάδας αντλιών με μη μηδενική παροχή.`);
    }
    const volume = average * minutes / 60;
    const allocation = [];
    for (const [id, fraction] of groups.tanks) {
      const tank = balances.get(id);
      const moved = volume * fraction;
      tank.volume += sign * moved;
      allocation.push(`${id}: ${txDisplay(moved)} → ${txDisplay(tank.volume)} m³`);
      if (tank.volume < tank.min - 1e-7 || tank.volume > tank.max + 1e-7) error(`${label}: ο προβλεπόμενος όγκος της ${id} βγαίνει εκτός ορίων.`);
    }
    const from = elapsed;
    elapsed += minutes;
    total += volume;
    checks.push({ ...stage, volume, from, elapsed, startEpoch, allocation,
      binding: Number.isFinite(binding[1]) ? binding : ["Χωρίς δηλωμένο όριο", NaN],
      setup: stageRoutes.map(([id, route]) => `${id}${route.chain.length ? " [" + route.chain.join(" → ") + "]" : ""}${route.setup ? " " + route.setup : ""}`).join(" · "),
      pumps: pumpNotes.join(" · "),
    });
  }
  if (stageData.length && stageData.at(-1).end !== 0) error("Το τελευταίο στάδιο πρέπει να καταλήγει σε μηδενική παροχή.");
  for (const [id, tank] of balances) {
    if (Math.abs(tank.volume - tank.target) > 0.1) error(`${id}: απόκλιση από τον στόχο ${txDisplay(tank.volume - tank.target)} m³. Έλεγξε τη διάρκεια ή την κατανομή.`);
  }
  if (txBlank(plan.terminal)) warnings.push("Δεν καταχωρίστηκε συνολικό όριο τερματικού.");
  if (!loading && !checks.some((stage) => stage.pumps)) warnings.push("Οι ενεργές διαδρομές δεν έχουν δηλωμένες ομάδες αντλιών εκφόρτωσης.");
  if (![...routes.values()].some((route) => route.chain.length)) warnings.push("Δεν δηλώθηκαν κοινές βαλβίδες ή τμήματα γραμμής στις διαδρομές.");
  return { errors, warnings, stages: checks, tanks: [...balances], total, elapsed, finish: startEpoch + elapsed * 60000 };
}

function txInput(key, rowIndex, row, field) {
  const [name, label, type = "text"] = field;
  const attrs = `aria-label="${opsEscape(label)} · ${rowIndex + 1}" data-transfer-table="${key}" data-transfer-row="${rowIndex}" data-transfer-key="${name}"`;
  if (type === "kind") return `<select ${attrs}>${optionsHtml(Object.entries(transferKinds), row[name] ?? "up")}</select>`;
  if (type === "checkbox") return `<input ${attrs} type="checkbox" ${row[name] !== false ? "checked" : ""}>`;
  const number = type === "number" ? 'min="0" step="any" inputmode="decimal"' : "";
  return `<input ${attrs} type="${type}" ${number} value="${opsEscape(row[name])}">`;
}

function renderTransferTables() {
  const plan = transferPlan();
  $("transferInputs").innerHTML = Object.entries(transferTables).map(([key, config]) => `
    <section class="transfer-group" aria-label="${config.title}">
      <h3>${config.title}</h3><p class="hint">${config.hint}</p>
      <div class="table-wrap">
        <table class="data-table transfer-table">
          <thead><tr>${config.fields.map(([, label]) => `<th scope="col">${opsEscape(label)}</th>`).join("")}<th scope="col">Ενέργεια</th></tr></thead>
          <tbody>${plan[key].map((row, i) => `<tr>${config.fields.map((field) => `<td>${txInput(key, i, row, field)}</td>`).join("")}
            <td class="transfer-row-actions">
              ${key === "stages" ? `<button class="btn small" type="button" aria-label="Μετακίνηση σταδίου ${i + 1} επάνω"
                data-transfer-move="${i}" ${i === 0 ? "disabled" : ""}>↑</button>` : ""}
              <button class="btn small" type="button" data-transfer-remove="${key}" data-transfer-index="${i}" aria-label="Αφαίρεση γραμμής ${i + 1}">×</button>
            </td></tr>`).join("")}</tbody>
        </table>
      </div>
      <button class="btn small" type="button" data-transfer-add="${key}">Προσθήκη γραμμής</button>
    </section>`).join("");
}

function txBars(result) {
  const rateMax = Math.max(1, ...result.stages.map((stage) => stage.peak));
  const volumeMax = Math.max(1, ...result.stages.map((stage) => stage.volume));
  const bar = (value, scale, cssClass, label) => `<div class="transfer-bar-line"><span>${label}</span>
    <div class="transfer-track" aria-hidden="true"><div class="transfer-fill ${cssClass}" style="width:${Math.max(0, value / scale * 100)}%"></div></div>
    <strong>${txDisplay(value)}</strong></div>`;
  return `<h3>Ραβδογράμματα ανά στάδιο</h3><div class="transfer-chart">${result.stages.map((stage) => `
    <section class="transfer-chart-stage" aria-label="${opsEscape(stage.label)}">
      <h4>${opsEscape(stage.label)} <span>${txDisplay(stage.minutes)} min</span></h4>
      ${bar(stage.start, rateMax, "transfer-rate-start", "Αρχή m³/h")}
      ${bar(stage.end, rateMax, "transfer-rate-end", "Τέλος m³/h")}
      ${bar(stage.volume, volumeMax, "transfer-volume", "Όγκος m³")}
    </section>`).join("")}</div>`;
}

function renderTransferResult() {
  const plan = transferPlan();
  const r = calculateTransfer(plan, S.transfer.mode ?? "loading");
  const status = $("transferStatus");
  status.replaceChildren();
  const show = (text, cssClass) => {
    const p = document.createElement("p");
    p.textContent = text;
    p.className = cssClass;
    status.append(p);
  };
  if (r.errors.length) show("Το πλάνο έχει αποκλίσεις από τα δηλωμένα δεδομένα ή όρια.", "transfer-error");
  for (const message of r.errors) show(message, "transfer-error");
  for (const message of r.warnings) show(message, "hint");
  $("transferResults").hidden = !r.stages;
  if (!r.stages) return;

  if (!r.errors.length) show("Οι υπολογισμένες παροχές και οι όγκοι είναι εντός των δηλωμένων ορίων.", "transfer-ok");
  show(`Συνολικά ${txDisplay(r.total)} m³ σε ${txDisplay(r.elapsed / 60, 2)} h. Ολοκλήρωση ${utcText(r.finish)}.`, "transfer-total");
  $("transferBars").innerHTML = txBars(r);
  $("transferStageResults").innerHTML = tableHtml(
    ["Στάδιο", "Από → έως", "Αρχή → τέλος (m³/h)", "Μέση (m³/h)", "Όγκος (m³)", "Περιοριστικό στοιχείο",
      "Valve setup / διαδρομές", "Αντλίες", "Μεταφορά → ROB ανά tank"],
    r.stages.map((stage) => [
      stage.label,
      Number.isFinite(stage.startEpoch)
        ? `${utcText(stage.startEpoch + stage.from * 60000)} → ${utcText(stage.startEpoch + stage.elapsed * 60000)}`
        : `+${txDisplay(stage.from)} → +${txDisplay(stage.elapsed)} min`,
      `${txDisplay(stage.start)} → ${txDisplay(stage.end)}`, txDisplay(stage.average), txDisplay(stage.volume),
      `${stage.binding[0]}${Number.isFinite(stage.binding[1]) ? " · " + txDisplay(stage.binding[1]) + " m³/h" : ""}`,
      stage.setup || "—", stage.pumps || "—", stage.allocation.join(" · ") || "—",
    ])
  );
  $("transferTankResults").innerHTML = tableHtml(
    ["Tank", "Αρχικά m³", "Τελικά m³", "Στόχος m³", "Απόκλιση m³", "Δηλωμένα όρια m³"],
    r.tanks.map(([id, tank]) => [id, txDisplay(tank.start), txDisplay(tank.volume), txDisplay(tank.target),
      txDisplay(tank.volume - tank.target), `${txDisplay(tank.min)} → ${txDisplay(tank.max)}`])
  );
}

function clearTransferResults() {
  $("transferResults").hidden = true;
  $("transferStatus").replaceChildren();
  if (typeof clearGuidedRamp === "function") clearGuidedRamp();
}

function syncTransferPlanner() {
  const plan = transferPlan();
  $("transferMode").value = S.transfer.mode ?? "loading";
  for (const input of $("transferPlanner").querySelectorAll("[data-transfer-field]")) {
    input.value = plan[input.dataset.transferField] ?? "";
  }
  renderTransferTables();
  clearTransferResults();
  if (typeof syncGuidedRamp === "function") syncGuidedRamp();
}

function editTransferField(event) {
  const input = event.target;
  const { transferField, transferTable, transferRow, transferKey } = input.dataset;
  if (!transferField && !transferTable) return;
  const plan = transferPlan();
  if (transferField) plan[transferField] = input.value;
  else plan[transferTable][Number(transferRow)][transferKey] = input.type === "checkbox" ? input.checked : input.value;
  clearTransferResults();
}

function transferTableAction(event) {
  const button = event.target.closest("button");
  if (!button) return;
  const { transferAdd, transferRemove, transferIndex, transferMove } = button.dataset;
  const plan = transferPlan();
  if (transferAdd) {
    const prefixes = { tanks: "T", pumps: "P", valves: "V", routes: "R" };
    const rows = plan[transferAdd];
    let next = rows.length + 1;
    const prefix = prefixes[transferAdd];
    while (rows.some((row) => row.id === prefix + next)) next++;
    rows.push(transferAdd === "stages" ? { kind: "up" } : { id: prefix + next });
  } else if (transferRemove) {
    plan[transferRemove].splice(Number(transferIndex), 1);
  } else if (transferMove !== undefined) {
    const index = Number(transferMove);
    if (index <= 0) return;
    const [stage] = plan.stages.splice(index, 1);
    plan.stages.splice(index - 1, 0, stage);
  } else return;
  renderTransferTables();
  clearTransferResults();
}

function applyTransferTemplate() {
  const plan = transferPlan();
  if (plan.stages.length) {
    $("transferStatus").textContent = "Το πρότυπο είναι διαθέσιμο όταν ο πίνακας σταδίων είναι κενός.";
    return;
  }
  if (!plan.tanks.length) plan.tanks.push({ id: "T1" });
  if (!plan.routes.length) plan.routes.push({ id: "R1", tank: plan.tanks[0].id });
  const split = `${plan.routes[0].id}:100`;
  plan.stages = [{ kind: "up", start: "0", split }, { kind: "bulk", split }, { kind: "down", end: "0", split }];
  renderTransferTables();
  clearTransferResults();
}

document.addEventListener("DOMContentLoaded", () => {
  $("transferMode").addEventListener("change", (event) => {
    transferPlan();
    S.transfer.mode = event.target.value;
    syncTransferPlanner();
  });
  $("transferPlanner").addEventListener("input", editTransferField);
  $("transferPlanner").addEventListener("change", editTransferField);
  $("transferInputs").addEventListener("click", transferTableAction);
  $("transferTemplate").addEventListener("click", applyTransferTemplate);
  $("transferRun").addEventListener("click", renderTransferResult);
});
