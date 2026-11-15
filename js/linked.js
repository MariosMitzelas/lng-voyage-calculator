"use strict";

function linkedReturnRoute(state = S) {
  const outbound = state.legs;
  return outbound.map((_, i) => {
    const reverse = outbound[outbound.length - 1 - i];
    const edit = state.linkedVoyage?.returnLegs?.[i] ?? {};
    return {
      fromIdx: i === 0 ? reverse.toIdx : state.linkedVoyage?.returnLegs?.[i - 1]?.toIdx ?? reverse.toIdx,
      toIdx: i === outbound.length - 1 ? reverse.fromIdx : edit.toIdx ?? reverse.fromIdx,
      distMode: edit.manualDist !== undefined && edit.manualDist !== "" ? "manual" : edit.useGc || state.linkedVoyage?.returnLegs?.[i - 1]?.useGc ? "gc" : reverse.distMode,
      manualDist: edit.manualDist !== undefined && edit.manualDist !== "" ? Number(edit.manualDist) : reverse.manualDist,
      stopArrival: i === outbound.length - 1 && state.linkedVoyage?.speedMode ? undefined : edit.stopArrival, stopDeparture: edit.stopDeparture, stopTz: 0,
      phase: "ballast",
    };
  });
}

function linkedTransfer(plan, mode, method) {
  if (!plan?.tanks?.length) throw new Error("Συμπλήρωσε τις δεξαμενές του πλάνου " + (mode === "loading" ? "φόρτωσης." : "εκφόρτωσης."));
  if (method === "forms") return linkedRampForm(plan, mode);
  if (method === "staged") {
    const result = calculateTransfer(plan, mode);
    if (result.errors.length) throw new Error(result.errors[0]);
    return { minutes: result.elapsed, volumes: new Map(result.tanks.map(([id, tank]) => [id, tank.volume])), moved: result.total };
  }
  const config = plan.guided ?? {};
  const model = rampModel(plan, config, true, mode);
  const result = mode === "loading" ? rampLoading(model, config) : rampDischarge(model, config);
  if (result.errors.length) throw new Error(result.errors[0]);
  if (mode === "unloading" && Math.abs(result.stages[0].ends[0]) > 1e-7) {
    throw new Error("Για πλήρη εκφόρτωση από μηδενική παροχή, συμπλήρωσε το πλάνο εκκίνησης και bulk εκφόρτωσης.");
  }
  const moved = [...result.volumes].reduce((sum, [id, volume]) => sum + Math.abs(volume - model.tanks.get(id).start), 0);
  return { minutes: result.stages.at(-1).to, volumes: result.volumes, moved };
}

function computeLinkedVoyage() {
  const settings = S.linkedVoyage ?? {};
  const rows = [];
  const add = (label, time, hours, rob, moved, distance, fo, mdo) => rows.push([
    label, utcText(time), fmt(hours, 2), cargoVolumeText(rob), cargoVolumeText(moved), fmt(distance), fmt(fo, 1), fmt(mdo, 1),
  ]);
  const loss = (key) => {
    const value = Number(settings[key] ?? "");
    if (!Number.isFinite(value) || value < 0) throw new Error("Έλεγξε τις ποσότητες μείωσης LNG στο λιμάνι.");
    return value;
  };
  let step = "Φόρτωση";
  let outbound;
  let ladenBalance;
  let heelBalance;
  try {
    if (!S.legs.some(leg => !legCanal(leg.fromIdx, leg.toIdx)) ||
        S.legs.some(leg => !legCanal(leg.fromIdx, leg.toIdx) && leg.phase === "ballast")) {
      throw new Error("Δήλωσε τα σκέλη της μετάβασης ως Laden στην καρτέλα Ταξίδι & Απόσταση.");
    }
    const loaded = linkedTransfer(S.transfer?.loading, "loading", settings.method ?? "forms");
    const dep = localToEpoch(S.depDate, S.depTime, S.depTz);
    const loadStart = opsDate(S.transfer.loading.start);
    const loadFinish = loadStart + loaded.minutes * 60000;
    if (!Number.isFinite(loadFinish) || !Number.isFinite(dep)) throw new Error("Συμπλήρωσε την έναρξη φόρτωσης (UTC) και την αναχώρηση του Laden πλου.");
    if (loadFinish > dep + 30000) throw new Error("Η αναχώρηση Laden προηγείται του τέλους φόρτωσης.");
    const loadedRob = [...loaded.volumes.values()].reduce((sum, volume) => sum + volume, 0);
    add("Έναρξη φόρτωσης", loadStart);
    add("Τέλος φόρτωσης", loadFinish, loaded.minutes / 60, loadedRob, loaded.moved);

    step = "Laden";
    const postLoading = loss("loaded");
    const ladenRob = loadedRob - postLoading;
    if (ladenRob < 0) throw new Error("Η μείωση LNG μετά τη φόρτωση υπερβαίνει το τελικό ROB της.");
    outbound = withVoyage({ ...S, robLng: ladenRob });
    if (outbound.scheduleErrors.length) throw new Error(outbound.scheduleErrors[0]);
    if (!Number.isFinite(outbound.etaArrEpoch) || !(outbound.arrRobM3 >= 0)) throw new Error("Έλεγξε το χρονοδιάγραμμα και την επάρκεια LNG του Laden πλου.");
    const ladenFo = optionalNumber(S.robFo);
    const ladenMdo = optionalNumber(S.robMdo);
    const arrivalFo = ladenFo - outbound.foT;
    const arrivalMdo = ladenMdo - outbound.mdoT;
    add("Αναχώρηση Laden · " + outbound.from.name, dep, NaN, ladenRob, NaN, NaN, ladenFo, ladenMdo);
    add("Άφιξη Laden · " + outbound.to.name, outbound.etaArrEpoch, outbound.hours, outbound.arrRobM3, outbound.cargoUsed, outbound.distance, arrivalFo, arrivalMdo);

    step = "Εκφόρτωση";
    const unload = S.transfer?.unloading;
    const preDischarge = loss("before");
    const arrivalRob = outbound.arrRobM3 - preDischarge;
    if (arrivalRob < 0) throw new Error("Η μείωση LNG πριν την εκφόρτωση υπερβαίνει το ROB άφιξης.");
    ladenBalance = { loadedRob, loadedQuantity: loaded.moved, arrivalRob, postLoading, preDischarge, voyageLoss: outbound.cargoUsed, fuelUsed: outbound.lngM3 };
    const tankIds = new Set(unload?.tanks?.map(tank => tank.id));
    if (tankIds.size !== loaded.volumes.size || [...loaded.volumes.keys()].some(id => !tankIds.has(id))) {
      throw new Error("Χρησιμοποίησε τα ίδια tank IDs στη φόρτωση και την εκφόρτωση.");
    }
    const enteredRob = unload.tanks.map(tank => optionalNumber(tank.start));
    const totalEntered = enteredRob.reduce((sum, volume) => sum + volume, 0);
    if (enteredRob.some(volume => !(volume >= 0)) || !(totalEntered > 0)) {
      throw new Error("Βάλε αρχικά m³ ανά tank στο πλάνο εκφόρτωσης για την κατανομή του ROB άφιξης.");
    }
    const tanks = unload.tanks.map((tank, i) => ({ ...tank, start: arrivalRob * enteredRob[i] / totalEntered }));
    const start = unload.start ? opsDate(unload.start) : outbound.etaArrEpoch;
    if (!(start >= outbound.etaArrEpoch - 30000)) throw new Error("Η έναρξη εκφόρτωσης προηγείται της άφιξης ή έχει μη έγκυρη ώρα.");
    add("Έναρξη εκφόρτωσης", start, (start - outbound.etaArrEpoch) / HOUR, arrivalRob);
    const unloaded = linkedTransfer({ ...unload, tanks, start: opsIso(start) }, "unloading", settings.method ?? "forms");
    const finish = start + unloaded.minutes * 60000;
    const heel = [...unloaded.volumes.values()].reduce((sum, volume) => sum + volume, 0);
    add("Τέλος εκφόρτωσης · EDQ", finish, unloaded.minutes / 60, heel, unloaded.moved);
    heelBalance = { planned: heel, edq: unloaded.moved };

    step = "Ballast";
    const last = S.legs.at(-1);
    const departure = settings.departure ? opsDate(settings.departure)
      : last.stopDeparture ? stopEpoch(last.stopDeparture, last.stopTz ?? S.arrTz) : finish;
    if (!(departure >= finish - 30000)) throw new Error("Η αναχώρηση Ballast προηγείται του τέλους εκφόρτωσης.");
    const postDischarge = loss("after");
    const returnRob = heel - postDischarge;
    heelBalance = { ...heelBalance, departure, postDischarge, returnRob };
    const serviceSpeed = settings.speed == null || settings.speed === "" ? S.serviceSpeed : optionalNumber(settings.speed);
    const byArrival = settings.speedMode === "eta";
    const target = byArrival ? opsDate(settings.arrival) : NaN;
    if (byArrival && !(target > departure)) throw new Error("Δήλωσε επιθυμητή άφιξη μετά την αναχώρηση Ballast.");
    if (!byArrival && !(serviceSpeed > 0)) throw new Error("Συμπλήρωσε θετική ταχύτητα επιστροφής.");
    const [depDate, depTime] = opsIso(departure).split("T");
    const returnFo = arrivalFo - loss("portFo");
    const returnMdo = arrivalMdo - loss("portMdo");
    const [arrDate, arrTime] = opsIso(target).split("T");
    const returnState = { ...S, robFo: returnFo, robMdo: returnMdo, legs: linkedReturnRoute(), robLng: returnRob,
      depDate, depTime, depTz: 0, arrDate, arrTime, arrTz: 0, speedMode: byArrival ? "eta" : "speed", serviceSpeed };
    if (returnState.legs.some(leg => leg.distMode === "manual" && !(leg.manualDist >= 0))) throw new Error("Έλεγξε τα μίλια της επιστροφής.");
    const inbound = withVoyage(returnState, () => compute(departure));
    if (inbound.scheduleErrors.length) throw new Error(inbound.scheduleErrors[0]);
    if (!Number.isFinite(inbound.etaArrEpoch)) throw new Error("Έλεγξε το χρονοδιάγραμμα του Ballast σκέλους.");
    heelBalance.required = inbound.requiredM3 + postDischarge;
    add("Αναχώρηση Ballast · " + inbound.from.name, departure, NaN, returnRob, NaN, NaN, returnFo, returnMdo);
    add("Άφιξη Ballast · " + inbound.to.name, inbound.etaArrEpoch, inbound.hours, inbound.arrRobM3 >= 0 ? inbound.arrRobM3 : NaN, inbound.cargoUsed, inbound.distance, returnFo - inbound.foT, returnMdo - inbound.mdoT);
    if (Number.isFinite(inbound.maxIntakeM3)) {
      const [label, quantity] = ["Max Intake επόμενης φόρτωσης", cargoVolumeText(inbound.maxIntakeM3)];
      rows.push([label, utcText(inbound.etaArrEpoch), "—", "—", quantity, "—", "—", "—"]);
    }
    const warnings = [];
    if ([arrivalFo, arrivalMdo, inbound.arrFo, inbound.arrMdo].some(value => value < 0)) {
      warnings.push("Ανεπαρκές LSHFO ή LSMGO για τον κύκλο, μαζί με τυχόν απόθεμα Ballast.");
    }
    if (returnRob < 0 || inbound.arrRobM3Margin < 0) warnings.push("Το heel επιστροφής δεν καλύπτει τη μείωση LNG, το safety margin και το cool-down.");
    if (inbound.rateOutsideTable) warnings.push("Η ταχύτητα επιστροφής είναι εκτός της καμπύλης καταναλώσεων.");
    return { rows, outbound, inbound, ladenBalance, heelBalance, message: warnings.join(" ") };
  } catch (error) {
    return { rows, outbound, ladenBalance, heelBalance, message: step + " · " + error.message };
  }
}

function ladenBalanceRows(balance) {
  const { loadedRob, arrivalRob, postLoading, preDischarge, voyageLoss, fuelUsed } = balance;
  return [
    ["ROB στο τέλος φόρτωσης", cargoVolumeText(loadedRob)],
    ["Μείωση πριν την αναχώρηση από το λιμάνι φόρτωσης", cargoVolumeText(postLoading)],
    ["Μείωση LNG στον πλου Laden", cargoVolumeText(voyageLoss)],
    ["Από τη μείωση εν πλω · LNG για καύσιμο", cargoVolumeText(fuelUsed)],
    ["Από τη μείωση εν πλω · επιπλέον μείωση πέρα από το καύσιμο", cargoVolumeText(Math.max(0, voyageLoss - fuelUsed))],
    ["Μείωση στο λιμάνι πριν την εκφόρτωση", cargoVolumeText(preDischarge)],
    ["ROB στην έναρξη εκφόρτωσης", cargoVolumeText(arrivalRob)],
    ["Συνολική μείωση LNG · τέλος φόρτωσης → έναρξη εκφόρτωσης", cargoVolumeText(loadedRob - arrivalRob)],
  ];
}

function heelBalanceRows(balance) {
  const { planned, required, postDischarge, returnRob } = balance;
  const rows = [
    ["Required heel · στο τέλος εκφόρτωσης", cargoVolumeText(required)],
    ["Heel που θα κρατήσεις · στο τέλος εκφόρτωσης", cargoVolumeText(planned)],
  ];
  if (Number.isFinite(required)) {
    const difference = planned - required;
    rows.push([difference < 0 ? "Έλλειμμα heel" : "Πλεόνασμα heel", cargoVolumeText(Math.abs(difference))]);
    rows.push(["Μείωση στο λιμάνι έως την αναχώρηση Ballast", cargoVolumeText(postDischarge)]);
    rows.push(["Heel αναχώρησης Ballast", cargoVolumeText(returnRob)]);
  }
  return rows;
}

function voyageSequence(linked) {
  const { outbound, inbound, heelBalance } = linked;
  const laden = outbound?.arrRobM3 >= 0 && Number.isFinite(outbound.etaArrEpoch) && !outbound.scheduleErrors.length
    ? outbound : null;
  const last = S.legs.at(-1);
  const loadingPort = laden?.from.name ?? PORTS[S.legs[0]?.fromIdx]?.name ?? "Λιμάνι φόρτωσης";
  const dischargePort = laden?.to.name ?? PORTS[last?.toIdx]?.name ?? "Λιμάνι εκφόρτωσης";
  const quantity = (label, value) => label + " " + cargoVolumeText(value, false);
  const speed = voyage => Number.isFinite(voyage?.speed) ? fmt(voyage.speed, 2) + " kn" : "—";
  const passage = (voyage, byArrival) => [
    "Απόσταση " + (Number.isFinite(voyage?.distance) ? fmt(voyage.distance, 0) + " nm" : "—")
      + " · Διάρκεια " + (Number.isFinite(voyage?.days) ? fmt(voyage.days, 2) + " ημέρες" : "—"),
    (byArrival ? "Απαιτούμενη μέση ταχύτητα " : "Μέση ταχύτητα ") + speed(voyage),
  ];
  const consumptions = voyage => [
    quantity("LNG καύσιμο", voyage?.lngM3),
    quantity("Μείωση LNG ROB", voyage?.cargoUsed),
    "LSMGO " + fmt(voyage?.mdoT, 2) + " t · LSHFO " + fmt(voyage?.foT, 2) + " t",
  ];
  const rows = [
    ["1. Αναχώρηση φόρτωσης · " + loadingPort, [utcText(laden?.depEpoch), quantity("ROB αναχώρησης", laden?.departureLng)]],
    ["Πλους Laden", [...passage(laden, S.speedMode === "eta"), ...consumptions(laden)]],
    ["2. Άφιξη εκφόρτωσης · " + dischargePort, [utcText(laden?.etaArrEpoch), quantity("QOB άφιξης", laden?.arrRobM3)]],
    ["3. Αναχώρηση εκφόρτωσης · " + dischargePort, [
      utcText(heelBalance?.departure),
      quantity("Required heel κατά την αναχώρηση", inbound?.requiredM3),
      ...(inbound ? [
        [
          quantity("Μείωση LNG στον πλου", inbound.cargoUsed),
          quantity("Safety margin LNG", inbound.marginM3),
          quantity("Cool-down", inbound.coolTotal),
        ].join(" + "),
      ] : []),
      quantity("ROB αναχώρησης", heelBalance?.returnRob >= 0 ? heelBalance.returnRob : NaN),
      quantity("Heel που κρατάς στο τέλος εκφόρτωσης", heelBalance?.planned),
      ...(heelBalance?.postDischarge > 0 ? [
        quantity("Μείωση LNG στο λιμάνι έως την αναχώρηση", heelBalance.postDischarge),
        quantity("Required heel στο τέλος εκφόρτωσης", heelBalance.required),
      ] : []),
    ]],
    ["Πλους Ballast", [
      ...passage(inbound, S.linkedVoyage?.speedMode === "eta"), ...consumptions(inbound),
    ]],
    ["4. Άφιξη επόμενης φόρτωσης · " + loadingPort, [
      utcText(inbound?.etaArrEpoch), quantity("ROB άφιξης", inbound?.arrRobM3 >= 0 ? inbound.arrRobM3 : NaN),
      quantity("Max Intake", inbound?.maxIntakeM3),
    ]],
  ];
  return '<thead><tr><th scope="col">Στάδιο</th><th scope="col">Χρόνος και ποσότητες</th></tr></thead><tbody>'
    + rows.map(([label, values]) => '<tr><th scope="row">' + opsEscape(label) + '</th><td>'
      + values.map(opsEscape).join("<br>") + "</td></tr>").join("") + "</tbody>";
}

function renderLinkedVoyage(main = compute(), linkedPlan) {
  const panel = $("linkedVoyage");
  const picker = $("consVoyage");
  const standalone = main.cargoMode === "ballast";
  picker.options[1].hidden = standalone;
  if (standalone) picker.value = "outbound";
  const returning = picker.value === "return";
  const linked = linkedPlan ?? (panel.open || (!standalone && (returning || S.transfer?.loading)) ? computeLinkedVoyage() : null);
  const result = standalone ? main : returning ? linked?.inbound : linked?.outbound ?? main;
  const settings = S.linkedVoyage ?? {};
  const byArrival = settings.speedMode === "eta";
  $("returnSpeedField").hidden = byArrival;
  $("returnArrivalField").hidden = !byArrival;
  $("ballastAllowances").hidden = !returning && !standalone;
  $("goReturn").hidden = !returning || standalone;
  picker.options[0].text = standalone ? "Ενεργός πλους · Ballast" : main.cargoMode === "laden" ? "Μετάβαση · Laden" : "Ενεργός πλους";
  $("consVoyageStatus").textContent = result
    ? result.from.name + " → " + result.to.name + (returning && linked?.message ? " · " + linked.message : "")
    : linked?.message ?? "Συμπλήρωσε το πλάνο επιστροφής.";
  const summary = result ? [
    ["Διάρκεια / μέση ταχύτητα", fmt(result.hours, 2) + " h · " + fmt(result.speed, 2) + " kn"],
    ...(!returning && linked?.ladenBalance ? ladenBalanceRows(linked.ladenBalance) : [
      ["LNG καύσιμο", cargoVolumeText(result.lngM3)], ["Μείωση LNG στον πλου", cargoVolumeText(result.cargoUsed)],
    ]),
    ["LSHFO / LSMGO", fmt(result.foT, 2) + " t / " + fmt(result.mdoT, 2) + " t"],
  ] : [];
  if (result?.cargoMode === "ballast") summary.push(
    ...(linked?.heelBalance && returning ? heelBalanceRows(linked.heelBalance) : [
      ["Required heel · στην αναχώρηση", cargoVolumeText(result.requiredM3)],
      ["Heel που θα κρατήσεις · στην αναχώρηση", cargoVolumeText(result.arrRobM3 + result.cargoUsed)],
    ]),
    ["ROB άφιξης", cargoVolumeText(result.arrRobM3 >= 0 ? result.arrRobM3 : NaN)],
    ["Safety margin / cool-down", result.marginText + " / " + cargoVolumeText(result.coolTotal, false)],
    ["LNG διαθέσιμο μετά τις προβλέψεις", cargoVolumeText(result.arrRobM3Margin)],
    ["Max Intake βάσει ROB άφιξης", cargoVolumeText(result.maxIntakeM3)]
  );
  if (!result && returning && linked?.heelBalance) summary.push(...heelBalanceRows(linked.heelBalance));
  $("consVoyageTable").innerHTML = summary.length ? tableHtml(["Μέγεθος", "Πρόβλεψη"], summary) : "";
  renderConsumptionDetails(result);
  if (!panel.open) return;
  const { rows, message, inbound, ladenBalance, heelBalance } = linked;
  $("linkedVoyageSequence").innerHTML = voyageSequence(linked);
  $("linkedLadenBalance").hidden = !ladenBalance;
  $("linkedHeelBalance").hidden = !heelBalance;
  $("linkedLadenTable").innerHTML = ladenBalance ? tableHtml(["Μεταβολή LNG", "Πρόβλεψη"], ladenBalanceRows(ladenBalance)) : "";
  $("linkedHeelTable").innerHTML = heelBalance ? tableHtml(["Heel επιστροφής", "Πρόβλεψη"], heelBalanceRows(heelBalance)) : "";
  $("returnHeadline").textContent = inbound
    ? "Αναχώρηση " + utcText(inbound.depEpoch) + " · ETA " + utcText(inbound.etaArrEpoch) + " · " + fmt(inbound.speed, 2) + " kn"
    : "";
  $("linkedStatus").textContent = message;
  $("linkedStatus").hidden = !message;
  $("linkedTimeline").innerHTML = tableHtml(
    ["Φάση", "Ώρα UTC", "Διάρκεια h", "LNG ROB", "Μεταφορά / μείωση LNG", "nm", "LSHFO ROB (t)", "MDO ROB (t)"], rows);
}

function syncLinkedVoyage() {
  const panel = $("linkedVoyage");
  if (!panel) return;
  const settings = S.linkedVoyage ?? {};
  for (const input of panel.querySelectorAll("[data-linked]")) {
    input.value = settings[input.dataset.linked] ?? (input.dataset.linked === "method" ? "forms" : input.dataset.linked === "speedMode" ? "speed" : "");
  }
  $("returnRoute").innerHTML = panel.open ? linkedReturnRoute().map((leg, i, route) => {
    const edit = settings.returnLegs?.[i] ?? {};
    const field = (key, type, label, extra = "") => {
      const value = type === "datetime-local" && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(edit[key] ?? "") ? "" : edit[key] ?? "";
      return `<label class="field">${label}<input data-return-index="${i}" data-return-key="${key}" type="${type}" value="${opsEscape(value)}" ${extra}></label>`;
    };
    return `<fieldset><legend>Ballast ${i + 1} · ${opsEscape(PORTS[leg.fromIdx]?.name)}</legend><div class="grid-form">
      ${i === route.length - 1 ? `<p>${opsEscape(PORTS[leg.toIdx]?.name)}</p>` :
        `<label class="field">Προς<select data-return-index="${i}" data-return-key="toIdx">${portOptions(leg.toIdx)}</select></label>`}
      ${field("manualDist", "number", "Χειροκίνητα nm", 'min="0" step="any"')}
      ${i < route.length - 1 || (!settings.speedMode && edit.stopArrival) ? field("stopArrival", "datetime-local", "Άφιξη (UTC)") : ""}
      ${i < route.length - 1 ? field("stopDeparture", "datetime-local", "Αναχώρηση (UTC)") : ""}
      </div></fieldset>`;
  }).join("") : "";
  renderLinkedVoyage();
}

document.addEventListener("DOMContentLoaded", () => {
  const panel = $("linkedVoyage");
  if (!panel) return;
  panel.addEventListener("toggle", syncLinkedVoyage);
  $("consVoyage").addEventListener("change", () => renderLinkedVoyage());
  $("goReturn").addEventListener("click", () => {
    document.querySelector('[data-panel="panel-voyage"]').click();
    panel.open = true;
    panel.scrollIntoView({ block: "start" });
    $("returnSpeedField").closest(".grid-form").querySelector("input").focus({ preventScroll: true });
  });
  const transferPlanner = $("transferPlanner");
  transferPlanner?.addEventListener("change", () => render());
  transferPlanner?.addEventListener("click", event => {
    if (event.target.closest("button[data-picker-action]")) render();
  });
  panel.addEventListener("change", event => {
    const { linked, returnIndex, returnKey } = event.target.dataset;
    if (!linked && !returnKey) return;
    const settings = S.linkedVoyage ??= {};
    if (linked) {
      settings[linked] = event.target.value;
      if (linked === "speedMode") {
        const legacyTarget = settings.returnLegs?.[S.legs.length - 1]?.stopArrival;
        if (settings.speedMode === "eta" && !settings.arrival && legacyTarget) settings.arrival = legacyTarget;
        syncLinkedVoyage();
        render();
        return;
      }
    }
    else {
      const legs = settings.returnLegs ??= {};
      const leg = legs[returnIndex] ??= {};
      leg[returnKey] = returnKey === "toIdx" ? Number(event.target.value) : event.target.value;
      if (returnKey === "toIdx") {
        leg.manualDist = "";
        leg.useGc = true;
        syncLinkedVoyage();
        render();
        return;
      }
    }
    render();
  });
});
