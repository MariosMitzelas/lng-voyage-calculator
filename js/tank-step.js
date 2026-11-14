"use strict";

function checkTankStep(tank, end, rate) {
  const { id, start, min, max, ceiling } = tank;
  const name = pickerTankLabel(id);
  if (Math.min(start, end) < min - rampTolerance || Math.max(start, end) > max + rampTolerance) {
    throw new Error(name + " · Ο αρχικός ή τελικός όγκος ξεπερνά τα όρια ROB.");
  }
  if (rate < -rampTolerance) {
    throw new Error(name + " · Χρειάζεται αντίθετη ροή. Άλλαξε διαφορά, παροχή ή διάρκεια.");
  }
  if (!Number.isFinite(end) || !Number.isFinite(rate)) throw new Error(name + " · Έλεγξε τις τιμές.");
  if (rate > ceiling + rampTolerance) {
    throw new Error(name + " · Απαιτούνται " + fmt(rate, 2) + " m³/h. Δηλωμένο όριο " + fmt(ceiling, 2) + " m³/h.");
  }
}

function calculateTankStep(tanks, config, mode, limit) {
  if (tanks.length < 2) throw new Error("Επίλεξε τουλάχιστον δύο δεξαμενές.");
  const sign = mode === "unloading" ? -1 : 1;
  const maintain = config.goal === "maintain";
  const time = config.basis === "time";
  const totalRate = time && maintain ? null : formNumber(config.rate, "συνολική παροχή", 0.01);
  if (!time) {
    const minutes = formNumber(config.minutes, "διάρκεια", 0.01);
    const hours = minutes / 60;
    const reference = tanks.find(tank => tank.id === config.reference);
    if (!reference) throw new Error("Επίλεξε δεξαμενή αναφοράς.");
    const percent = config.basis === "percent";
    if (percent && tanks.some(tank => !(Number.isFinite(tank.capacity) && tank.capacity > 0))) {
      throw new Error("Συμπλήρωσε χωρητικότητα 100% για κάθε δεξαμενή.");
    }
    const scale = tank => percent ? tank.capacity / 100 : 1;
    const initialOffsets = tanks.map(tank => tank.start / scale(tank) - reference.start / scale(reference));
    const offsets = tanks.map((tank, i) => {
      if (maintain) return initialOffsets[i];
      if (tank === reference) return 0;
      const raw = percent ? tank.percentOffset : tank.offset;
      const value = txBlank(raw) ? 0 : txNum(raw);
      if (!Number.isFinite(value)) throw new Error(pickerTankLabel(tank.id) + " · Έλεγξε τη διαφορά.");
      return value;
    });
    const moved = totalRate * hours;
    const finalRef = (rampSum(tanks.map((tank, i) => tank.start - offsets[i] * scale(tank))) + sign * moved) /
      rampSum(tanks.map(scale));
    if (!Number.isFinite(finalRef) || totalRate > limit + rampTolerance) {
      throw new Error("Η συνολική παροχή ή διάρκεια ξεπερνά τα όρια του πλάνου.");
    }
    const rows = tanks.map((tank, i) => {
      const end = (finalRef + offsets[i]) * scale(tank);
      const rate = sign * (end - tank.start) / hours;
      checkTankStep(tank, end, rate);
      return { id: tank.id, start: tank.start, end, rate: Math.max(0, rate), initialOffset: initialOffsets[i], offset: offsets[i] };
    });
    return { totalRate, minutes, moved, rows };
  }

  const gap = formNumber(config.gap, "λεπτά μεταξύ ολοκληρώσεων", 0.01);
  const quantities = tanks.map(tank => {
    const quantity = sign * (tank.target - tank.start);
    if (!(quantity > rampTolerance)) throw new Error(pickerTankLabel(tank.id) + " · Δήλωσε στόχο ROB στην κατεύθυνση της εργασίας.");
    return quantity;
  });
  const moved = rampSum(quantities);
  const span = (tanks.length - 1) * gap;
  const first = maintain ? formNumber(config.minutes, "λεπτά μέχρι το πρώτο tank", 0.01) : moved / totalRate * 60 - span;
  if (!(first >= 0.01) || !Number.isFinite(first)) {
    throw new Error("Ο διαθέσιμος όγκος δεν επαρκεί για αυτό το step στη δηλωμένη παροχή.");
  }
  const minutes = first + span;
  const rate = totalRate ?? moved * 60 / minutes;
  if (!Number.isFinite(rate) || rate > limit + rampTolerance) throw new Error("Η απαιτούμενη συνολική παροχή ξεπερνά το όριο του πλάνου.");
  const finish = tanks.map((_, i) => first + i * gap);

  // Solve fixed shares among open tanks from the last completion backwards.
  // A common flow integral lets each tank close at its scheduled time.
  const weights = new Array(tanks.length);
  let remainingVolume = 0;
  let activeWeight = 0;
  for (let i = tanks.length - 1; i >= 0; i--) {
    const scaledFinish = i === tanks.length - 1 ? 1 : (remainingVolume - rate * (minutes - finish[i]) / 60) / activeWeight;
    if (!(scaledFinish > 0) || !Number.isFinite(scaledFinish)) {
      throw new Error("Η σειρά και το διάστημα δεν επιτυγχάνονται για τους όγκους αυτούς. Μείωσε το step ή άλλαξε σειρά.");
    }
    weights[i] = quantities[i] / scaledFinish;
    if (!Number.isFinite(weights[i])) throw new Error("Έλεγξε τις παροχές και τους όγκους.");
    activeWeight += weights[i];
    remainingVolume += quantities[i];
  }

  const stages = finish.map((to, i) => {
    const phaseWeights = rampSum(weights.slice(i));
    const rates = tanks.map((tank, j) => {
      const flow = j < i ? 0 : rate * weights[j] / phaseWeights;
      checkTankStep(tank, tank.target, flow);
      return flow;
    });
    return { from: finish[i - 1] ?? 0, to, rates };
  });
  return { totalRate: rate, minutes, moved, stages };
}

function tankStepConfig(plan) {
  if (plan.tankStep) return plan.tankStep;
  const guided = plan.guided ?? {};
  const routes = rampIds(guided.balanceRoutes);
  const selected = [...new Set(routes.map(id => plan.routes.find(route => route.id === id)?.tank).filter(Boolean))];
  const offsets = new Map(rampIds(guided.balanceOffsets).map(pair => pair.split(":").map(item => item.trim())));
  const oldBalance = selected.length > 0 || offsets.size > 0 || Boolean(guided.balanceRate);
  return plan.tankStep = {
    basis: oldBalance ? "percent" : "volume",
    goal: guided.balanceStyle === "maintain" ? "maintain" : "achieve",
    rate: guided.balanceRate,
    minutes: guided.balanceMinutes,
    gap: guided.tankGap ?? 15,
    reference: guided.reference,
    order: selected,
    tanks: Object.fromEntries([...offsets].map(([id, offset]) => [id, { percentOffset: offset }])),
  };
}

function tankStepSources(plan, mode) {
  const sources = new Map(calibratedTransferPlan(plan, mode).tanks.map(tank => [tank.id, tank]));
  if (mode === "unloading" && plan.form?.linked !== "plan" && plan.form?.detail === "tanks") {
    for (const [id, start, target] of parseFormRows(plan.form?.tankData)) {
      const source = sources.get(id) ?? {};
      sources.set(id, { ...source, start: start || source.start, target: target || source.target });
    }
  }
  return sources;
}

function renderTankStep(sync = false) {
  const panel = $("tankStep");
  if (!panel?.open) return;
  const plan = transferPlan();
  const mode = S.transfer.mode ?? "loading";
  const config = tankStepConfig(plan);
  const sources = tankStepSources(plan, mode);
  const time = config.basis === "time";
  const percent = config.basis === "percent";
  const maintain = config.goal === "maintain";
  const order = config.order;
  const reference = order.includes(config.reference) ? config.reference : order[0];
  const rateInput = panel.querySelector('[data-tank-step="rate"]');
  const manualTableA = plan.form?.detail !== "tanks" && plan.form?.linked !== "plan";
  const formRate = mode === "loading" ? plan.form?.bulk ?? rampFormDefaults.bulk
    : manualTableA ? plan.form?.totalRate ?? rampFormDefaults.totalRate : undefined;
  const rate = config.rate ?? formRate;
  const commonCeiling = Math.min(...["terminal", "manifold", "vapour"].map(key => txRateCeiling(plan[key])),
    mode === "unloading" ? txRateCeiling(plan.form?.limit ?? rampFormDefaults.limit) : Infinity);
  $("tankStepGap").hidden = !time;
  $("tankStepReference").hidden = time;
  rateInput.closest("label").hidden = time && maintain;
  $("tankStepDuration").hidden = time && !maintain;
  $("tankStepDurationLabel").textContent = time ? "Λεπτά μέχρι το πρώτο tank" : "Λεπτά έως τον στόχο";
  $("tankStepHint").textContent = time
    ? maintain ? "Βάλε τον χρόνο που μένει μέχρι το πρώτο tank και το διάστημα μεταξύ ολοκληρώσεων. Η συνολική παροχή υπολογίζεται από τα τρέχοντα ROB."
      : "Βάλε σειρά και στόχο ROB ανά tank. Η συνολική παροχή μοιράζεται ξανά κάθε φορά που ολοκληρώνεται ένα tank."
    : maintain ? "Η κατανομή κρατά τη σημερινή διαφορά στην επιλεγμένη μονάδα σε όλη τη διάρκεια."
      : "Θετική τιμή σημαίνει μεγαλύτερο ROB από το tank αναφοράς. Κενό σημαίνει ίσο ROB στην επιλεγμένη μονάδα.";

  const values = id => ({ ...sources.get(id), ...(Object.hasOwn(config.tanks, id) ? config.tanks[id] : {}) });
  if (sync) {
    const ref = $("tankStepReference").querySelector("select");
    ref.innerHTML = optionsHtml(order.map(id => [id, pickerTankLabel(id)]), reference);
    for (const input of panel.querySelectorAll("[data-tank-step]")) {
      const key = input.dataset.tankStep;
      input.value = (key === "reference" ? reference : key === "rate" ? rate : config[key]) ?? "";
    }
    const ids = [...new Set([...order, ...standardTankIds, ...sources.keys()])];
    $("tankStepTanks").innerHTML = ids.map(id => {
      const index = order.indexOf(id);
      const tank = values(id);
      const escaped = opsEscape(id);
      const field = (key, label, min = 'min="0"', readonly = false) =>
        `<label class="field">${label}<input type="number" step="any" inputmode="decimal" ${min} ${readonly ? "readonly" : ""}
          data-step-tank="${escaped}" data-step-value="${key}" value="${opsEscape(tank[key])}"></label>`;
      const move = (direction, arrow, label, disabled) => `<button type="button" class="btn small"
        data-step-tank="${escaped}" data-step-move="${direction}" aria-label="${label} ${opsEscape(pickerTankLabel(id))}"
        ${disabled ? "disabled" : ""}>${arrow}</button>`;
      const capacity = percent ? field("capacity", "Χωρητικότητα 100% (m³)", 'min="0"', Boolean(cargoCalibration()?.tanks.some(row => row.id === cargoTankId(id)))) : "";
      const parameters = time ? field("target", mode === "unloading" ? "Heel ολοκλήρωσης (m³)" : "ROB ολοκλήρωσης (m³)")
        : capacity + (!maintain && id !== reference ? field(percent ? "percentOffset" : "offset", percent ? "Διαφορά (ποσ. μονάδες)" : "Διαφορά ROB (m³)", "") : "");
      return `<fieldset><legend>${time && index >= 0 ? (index + 1) + ". " : ""}${opsEscape(pickerTankLabel(id))}</legend>
        <label><input type="checkbox" data-step-tank="${escaped}" ${index >= 0 ? "checked" : ""}> Συμμετέχει</label>
        ${index < 0 ? "" : `<div class="grid-form">${field("start", "Τρέχον ROB (m³)")}${parameters}</div>
          ${time ? move(-1, "↑", "Μετακίνηση επάνω", !index) + move(1, "↓", "Μετακίνηση κάτω", index === order.length - 1) : ""}`}</fieldset>`;
    }).join("");
  }

  const status = $("tankStepStatus");
  const output = $("tankStepResults");
  output.innerHTML = "";
  if (!order.length) {
    status.textContent = "Επίλεξε τις δεξαμενές που συμμετέχουν.";
    return;
  }
  try {
    const pumps = mode === "unloading" ? parseFormRows(plan.form?.pumpData) : [];
    if (order.length < 2) throw new Error("Επίλεξε τουλάχιστον δύο δεξαμενές.");
    const tanks = order.map(id => {
      const tank = values(id);
      const name = pickerTankLabel(id);
      const capacity = rampOptional(tank.capacity, name + " χωρητικότητα", Infinity);
      const pumpRates = pumps.filter(row => row[1] === id && !txBlank(row[2])).map(row => txNum(row[2]));
      const pumpLimit = pumpRates.length && pumpRates.every(value => value > 0 && Number.isFinite(value)) ? rampSum(pumpRates) : Infinity;
      return { ...tank, id, capacity, start: formNumber(tank.start, name + " ROB"), target: txNum(tank.target),
        min: rampOptional(tank.min, name + " min ROB", 0), max: Math.min(capacity, rampOptional(tank.max, name + " max ROB", Infinity)),
        ceiling: Math.min(pumpLimit, rampOptional(tank.rate, name + " όριο παροχής", Infinity),
          rampOptional(tank.finalRate, name + " όριο topping/strip", Infinity)) };
    });
    const result = calculateTankStep(tanks, { ...config, rate, reference }, mode, commonCeiling);
    status.textContent = fmt(result.totalRate, 2) + " m³/h συνολικά · " + fmt(result.minutes, 2) + " min · " + fmt(result.moved, 2) + " m³";
    if (time) {
      const headers = ["Από → έως (min)", "Ολοκλήρωση", ...tanks.map(tank => pickerTankLabel(tank.id) + " (m³/h)")];
      output.innerHTML = tableHtml(headers, result.stages.map(({ from, to, rates }, i) =>
        [fmt(from, 2) + " → " + fmt(to, 2), pickerTankLabel(tanks[i].id) + " · " + fmt(tanks[i].target, 2) + " m³",
          ...rates.map(flow => fmt(flow, 2))]));
    } else {
      const unit = percent ? "ποσ. μονάδες" : "m³";
      output.innerHTML = tableHtml(["Δεξαμενή", "Rate (m³/h)", "Τελικό ROB (m³)", "Αρχική → τελική διαφορά (" + unit + ")"],
        result.rows.map(row => [pickerTankLabel(row.id), fmt(row.rate, 2), fmt(row.end, 2),
          fmt(row.initialOffset, 2) + " → " + fmt(row.offset, 2)]));
    }
  } catch (error) {
    status.textContent = error.message;
  }
}

document.addEventListener("DOMContentLoaded", () => {
  const panel = $("tankStep");
  panel.addEventListener("toggle", () => renderTankStep(true));
  panel.addEventListener("input", event => {
    const input = event.target;
    if (input.type === "checkbox") return;
    const { tankStep: key, stepTank: id, stepValue: field } = input.dataset;
    if (!key && !field) return;
    const config = tankStepConfig(transferPlan());
    if (key) config[key] = input.value;
    else {
      if (!Object.hasOwn(config.tanks, id)) Object.defineProperty(config.tanks, id, { value: {}, enumerable: true });
      config.tanks[id][field] = input.value;
    }
    renderTankStep(input.tagName === "SELECT");
  });
  panel.addEventListener("change", event => {
    const { stepTank: id } = event.target.dataset;
    if (!id || event.target.type !== "checkbox") return;
    const config = tankStepConfig(transferPlan());
    config.order = event.target.checked ? [...config.order, id] : config.order.filter(tank => tank !== id);
    if (!config.order.includes(config.reference)) config.reference = config.order[0];
    renderTankStep(true);
  });
  panel.addEventListener("click", event => {
    const button = event.target.closest("[data-step-move]");
    if (!button) return;
    const { order } = tankStepConfig(transferPlan());
    const i = order.indexOf(button.dataset.stepTank);
    const next = i + Number(button.dataset.stepMove);
    if (next < 0 || next >= order.length) return;
    [order[i], order[next]] = [order[next], order[i]];
    renderTankStep(true);
  });
});
