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
      stopArrival: edit.stopArrival, stopDeparture: edit.stopDeparture, stopTz: 0,
      phase: "ballast",
    };
  });
}

function linkedTransfer(plan, mode, method) {
  if (!plan?.tanks?.length) throw new Error("Συμπλήρωσε τις δεξαμενές του πλάνου " + (mode === "loading" ? "φόρτωσης." : "εκφόρτωσης."));
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
  try {
    if (!S.legs.some(leg => !legCanal(leg.fromIdx, leg.toIdx)) ||
        S.legs.some(leg => !legCanal(leg.fromIdx, leg.toIdx) && leg.phase === "ballast")) {
      throw new Error("Δήλωσε τα σκέλη της μετάβασης ως Laden στην καρτέλα Ταξίδι & Απόσταση.");
    }
    const loaded = linkedTransfer(S.transfer?.loading, "loading", settings.method);
    const dep = localToEpoch(S.depDate, S.depTime, S.depTz);
    const loadStart = opsDate(S.transfer.loading.start);
    const loadFinish = loadStart + loaded.minutes * 60000;
    if (!Number.isFinite(loadFinish) || !Number.isFinite(dep)) throw new Error("Συμπλήρωσε την έναρξη φόρτωσης (UTC) και την αναχώρηση του Laden πλου.");
    if (loadFinish > dep + 30000) throw new Error("Η αναχώρηση Laden προηγείται του τέλους φόρτωσης.");
    const loadedRob = [...loaded.volumes.values()].reduce((sum, volume) => sum + volume, 0);
    add("Έναρξη φόρτωσης", loadStart);
    add("Τέλος φόρτωσης", loadFinish, loaded.minutes / 60, loadedRob, loaded.moved);

    step = "Laden";
    const ladenRob = loadedRob - loss("loaded");
    if (ladenRob < 0) throw new Error("Η μείωση LNG μετά τη φόρτωση υπερβαίνει το τελικό ROB της.");
    const outbound = withVoyage({ ...S, robLng: ladenRob });
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
    const arrivalRob = outbound.arrRobM3 - loss("before");
    if (arrivalRob < 0) throw new Error("Η μείωση LNG πριν την εκφόρτωση υπερβαίνει το ROB άφιξης.");
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
    const unloaded = linkedTransfer({ ...unload, tanks, start: opsIso(start) }, "unloading", settings.method);
    const finish = start + unloaded.minutes * 60000;
    const heel = [...unloaded.volumes.values()].reduce((sum, volume) => sum + volume, 0);
    add("Τέλος εκφόρτωσης · EDQ", finish, unloaded.minutes / 60, heel, unloaded.moved);

    step = "Ballast";
    const last = S.legs.at(-1);
    const departure = last.stopDeparture ? stopEpoch(last.stopDeparture, last.stopTz ?? S.arrTz) : finish;
    if (!(departure >= finish - 30000)) throw new Error("Η αναχώρηση Ballast προηγείται του τέλους εκφόρτωσης.");
    const returnRob = heel - loss("after");
    if (returnRob < 0) throw new Error("Η μείωση LNG μετά την εκφόρτωση υπερβαίνει το heel.");
    const serviceSpeed = settings.speed == null || settings.speed === "" ? S.serviceSpeed : optionalNumber(settings.speed);
    if (!(serviceSpeed > 0)) throw new Error("Συμπλήρωσε θετική ταχύτητα επιστροφής.");
    const [depDate, depTime] = opsIso(departure).split("T");
    const returnFo = arrivalFo - loss("portFo");
    const returnMdo = arrivalMdo - loss("portMdo");
    const returnState = { ...S, robFo: returnFo, robMdo: returnMdo, legs: linkedReturnRoute(), robLng: returnRob,
      depDate, depTime, depTz: 0, arrTz: 0, speedMode: "speed", serviceSpeed };
    if (returnState.legs.some(leg => leg.distMode === "manual" && !(leg.manualDist >= 0))) throw new Error("Έλεγξε τα μίλια της επιστροφής.");
    const inbound = withVoyage(returnState, () => compute(departure));
    if (inbound.scheduleErrors.length) throw new Error(inbound.scheduleErrors[0]);
    if (!Number.isFinite(inbound.etaArrEpoch) || !(inbound.arrRobM3 >= 0)) throw new Error("Έλεγξε το χρονοδιάγραμμα και την επάρκεια του heel στο Ballast σκέλος.");
    add("Αναχώρηση Ballast · " + inbound.from.name, departure, NaN, returnRob, NaN, NaN, returnFo, returnMdo);
    add("Άφιξη Ballast · " + inbound.to.name, inbound.etaArrEpoch, inbound.hours, inbound.arrRobM3, inbound.cargoUsed, inbound.distance, returnFo - inbound.foT, returnMdo - inbound.mdoT);
    if (Number.isFinite(inbound.maxIntakeM3)) {
      const [label, quantity] = ["Max Intake επόμενης φόρτωσης", cargoVolumeText(inbound.maxIntakeM3)];
      rows.push([label, utcText(inbound.etaArrEpoch), "—", "—", quantity, "—", "—", "—"]);
    }
    const shortage = [arrivalFo, arrivalMdo, returnFo - inbound.foT, returnMdo - inbound.mdoT].some(value => value < 0);
    return { rows, message: shortage ? "Ανεπαρκές LSHFO ή MDO σε τουλάχιστον μία φάση του ταξιδιού." : "" };
  } catch (error) {
    return { rows, message: step + " · " + error.message };
  }
}

function renderLinkedVoyage() {
  const panel = $("linkedVoyage");
  if (!panel?.open) return;
  const { rows, message } = computeLinkedVoyage();
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
    input.value = settings[input.dataset.linked] ?? (input.dataset.linked === "method" ? "guided" : "");
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
      ${field("stopArrival", "datetime-local", "Άφιξη (UTC)")}
      ${i < route.length - 1 ? field("stopDeparture", "datetime-local", "Αναχώρηση (UTC)") : ""}
      </div></fieldset>`;
  }).join("") : "";
  renderLinkedVoyage();
}

document.addEventListener("DOMContentLoaded", () => {
  const panel = $("linkedVoyage");
  if (!panel) return;
  panel.addEventListener("toggle", syncLinkedVoyage);
  $("transferPlanner")?.addEventListener("change", renderLinkedVoyage);
  $("transferPlanner")?.addEventListener("click", event => {
    if (event.target.closest("#transferInputs button, #transferTemplate")) renderLinkedVoyage();
  });
  panel.addEventListener("change", event => {
    const { linked, returnIndex, returnKey } = event.target.dataset;
    if (!linked && !returnKey) return;
    const settings = S.linkedVoyage ??= {};
    if (linked) settings[linked] = event.target.value;
    else {
      const legs = settings.returnLegs ??= {};
      const leg = legs[returnIndex] ??= {};
      leg[returnKey] = returnKey === "toIdx" ? Number(event.target.value) : event.target.value;
      if (returnKey === "toIdx") {
        leg.manualDist = "";
        leg.useGc = true;
        syncLinkedVoyage();
        return;
      }
    }
    renderLinkedVoyage();
  });
});
