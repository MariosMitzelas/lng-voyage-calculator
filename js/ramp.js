"use strict";

const rampTolerance = 1e-7;
const rampNumber = (value, label, min = 0) => {
  const number = txNum(value);
  if (!Number.isFinite(number) || number < min) throw new Error(label + " — μη έγκυρη τιμή.");
  return number;
};
const rampOptional = (value, label, fallback) => txBlank(value) ? fallback : rampNumber(value, label);
const rampRows = (value) => String(value ?? "").split(/\r?\n/).filter(line => line.trim()).map(line => line.split(",").map(cell => cell.trim()));
const rampIds = (value) => String(value ?? "").split(",").map(id => id.trim()).filter(Boolean);
const rampSum = (values) => [...values].reduce((sum, value) => sum + value, 0);
const rampChange = (minutes, label) => rampNumber(minutes, label, 0.01);

function rampIndex(rows, label) {
  const index = new Map();
  for (const row of rows || []) {
    if (typeof row.id !== "string" || !txIdPattern.test(row.id) || index.has(row.id)) throw new Error(label + " — έλεγξε τα μοναδικά IDs.");
    index.set(row.id, row);
  }
  return index;
}

function rampModel(plan, config, requireTargets = true) {
  const tanks = rampIndex(plan.tanks, "Tanks");
  const valves = rampIndex(plan.valves, "Valve / line");
  const groups = rampIndex(plan.pumps, "Ομάδες αντλιών");
  const routes = rampIndex(plan.routes, "Routes");
  const globalLimit = Math.min(...["terminal", "manifold", "vapour"].map(key => rampOptional(plan[key], key, Infinity)));
  for (const tank of tanks.values()) {
    const { id } = tank;
    const min = rampOptional(tank.min, id + " min", 0);
    const max = rampOptional(tank.max, id + " max", Infinity);
    const capacity = rampOptional(tank.capacity, id + " χωρητικότητα", Infinity);
    if (max < min || capacity <= 0) throw new Error(id + " — ασύμβατα όρια όγκου.");
    const start = rampNumber(tank.start, id + " αρχικό ROB");
    tanks.set(id, { ...tank, min, max: Math.min(max, capacity), capacity, start,
      target: !requireTargets && txBlank(tank.target) ? start : rampNumber(tank.target, id + " στόχος") });
  }
  const tables = new Map();
  for (const [id, level, volume, ...extra] of rampRows(config.levels)) {
    if (!tanks.has(id) || extra.length) throw new Error("Calibration — αναμενόταν tank,στάθμη m,όγκος m³.");
    if (!tables.has(id)) tables.set(id, []);
    const points = tables.get(id);
    const point = [rampNumber(level, id + " στάθμη"), rampNumber(volume, id + " όγκος")];
    if (points.length && point.some((value, i) => value <= points.at(-1)[i])) {
      throw new Error(id + " — οι στάθμες και οι όγκοι του calibration πρέπει να αυξάνονται.");
    }
    points.push(point);
  }
  const interpolateLevel = (id, value, column) => {
    const points = tables.get(id) || [];
    const i = points.findIndex(point => point[column] >= value - rampTolerance);
    if (i < 0 || value < points[0][column] - rampTolerance) return null;
    const a = points[i === 0 ? 0 : i - 1];
    const b = points[i];
    return a === b ? b[1 - column] : a[1 - column] + (value - a[column]) /
      (b[column] - a[column]) * (b[1 - column] - a[1 - column]);
  };
  return { plan, tanks, valves, groups, routes, globalLimit, interpolateLevel };
}

function rampRoute(model, id) {
  const route = model.routes.get(id);
  if (!route || !model.tanks.has(route.tank)) throw new Error(id + " — άγνωστη διαδρομή ή tank.");
  const chain = rampIds(route.valves);
  if (new Set(chain).size !== chain.length || chain.some(key => !model.valves.has(key) || model.valves.get(key).enabled === false)) {
    throw new Error(id + " — ελλιπής, κλειστή ή διπλή βαλβίδα / γραμμή.");
  }
  if (route.pump && !model.groups.has(route.pump)) throw new Error(id + " — άγνωστη ομάδα αντλιών.");
  return { ...route, chain };
}

function rampRouteList(model, value) {
  const ids = rampIds(value);
  const routes = (ids.length ? ids : [...model.routes.keys()]).map(id => rampRoute(model, id));
  if (!routes.length || new Set(routes.map(route => route.tank)).size !== routes.length) {
    throw new Error("Δήλωσε μία διαδρομή ανά tank, με τη σειρά ολοκλήρωσης.");
  }
  return routes;
}

function rampStage(label, from, to, rates, phase) {
  return { label, from, to, rates, phase };
}

function rampCheck(model, stages, mode, finishTargets = true) {
  const errors = new Set();
  const sign = mode === "unloading" ? -1 : 1;
  const initial = new Map([...model.tanks].map(([id, tank]) => [id, tank.start]));
  const volumes = new Map(initial);
  const rampUp = rampOptional(model.plan.rampUp, "Όριο αύξησης", Infinity);
  const rampDown = rampOptional(model.plan.rampDown, "Όριο μείωσης", Infinity);
  for (const [id, tank] of model.tanks) {
    if ((finishTargets ? [tank.start, tank.target] : [tank.start]).some(volume => volume < tank.min || volume > tank.max)) errors.add(id + " — αρχικό ROB ή στόχος εκτός ορίων.");
  }
  let previousEnd;
  for (const stage of stages) {
    const duration = stage.to - stage.from;
    const sums = { tanks: new Map(), valves: new Map(), pumps: new Map() };
    const ends = [0, 0];
    const add = (map, key, a, b) => {
      const pair = map.get(key) || [0, 0];
      map.set(key, [pair[0] + a, pair[1] + b]);
    };
    const ceiling = (a, b, limit, label) => {
      if (Math.max(a, b) > limit + rampTolerance) errors.add(stage.label + " — υπέρβαση " + label + " (" + txDisplay(limit) + " m³/h).");
    };
    for (const [id, [a, b]] of stage.rates) {
      if (Math.max(a, b) <= rampTolerance) continue;
      const route = rampRoute(model, id);
      ends[0] += a;
      ends[1] += b;
      add(sums.tanks, route.tank, a, b);
      for (const key of route.chain) add(sums.valves, key, a, b);
      if (route.pump && mode === "unloading") add(sums.pumps, route.pump, a, b);
      ceiling(a, b, rampOptional(route.rate, id + " όριο", Infinity), id);
    }
    for (const [id, [a, b]] of sums.tanks) {
      const tank = model.tanks.get(id);
      const startVolume = volumes.get(id);
      const volume = startVolume + sign * (a + b) * duration / 120;
      ceiling(a, b, rampOptional(tank.rate, id + " rate", Infinity), id);
      if (mode === "loading" && !txBlank(tank.finalRate)) {
        const toppingRate = rampNumber(tank.finalRate, id + " topping rate");
        const toppingStart = rampOptional(tank.topStart, id + " έναρξη topping", null);
        if (toppingStart === null && stage.phase === "topping" || toppingStart !== null && startVolume >= toppingStart) {
          ceiling(a, b, toppingRate, id + " topping");
        } else if (toppingStart !== null && volume > toppingStart) {
          // The square of flow varies linearly with transferred volume on a linear ramp.
          const fraction = (toppingStart - startVolume) / (volume - startVolume);
          const crossingRate = Math.sqrt((1 - fraction) * a ** 2 + fraction * b ** 2);
          ceiling(crossingRate, b, toppingRate, id + " topping");
        }
      }
      volumes.set(id, volume);
      if (volume < tank.min - rampTolerance || volume > tank.max + rampTolerance) errors.add(stage.label + " — " + id + " εκτός ορίων ROB.");
    }
    for (const [id, [a, b]] of sums.valves) {
      ceiling(a, b, rampOptional(model.valves.get(id).rate, id + " rate", Infinity), id);
    }
    for (const [id, [a, b]] of sums.pumps) {
      const group = model.groups.get(id);
      const count = rampNumber(group.count, id + " πλήθος", 1);
      if (!Number.isInteger(count)) throw new Error(id + " — δήλωσε ακέραιο πλήθος αντλιών.");
      ceiling(a, b, count * rampNumber(group.rate, id + " rate"), id);
    }
    ceiling(...ends, model.globalLimit, "terminal / manifold / vapour");
    const slope = (ends[1] - ends[0]) / duration;
    if (slope > rampUp + rampTolerance || -slope > rampDown + rampTolerance ||
        (previousEnd !== undefined && (ends[0] - previousEnd > rampTolerance && Number.isFinite(rampUp) ||
          previousEnd - ends[0] > rampTolerance && Number.isFinite(rampDown)))) {
      errors.add(stage.label + " — υπέρβαση του δηλωμένου ρυθμού μεταβολής της συνολικής παροχής.");
    }
    previousEnd = ends[1];
    stage.tankRates = sums.tanks;
    stage.ends = ends;
    stage.rob = new Map(volumes);
  }
  if (finishTargets) for (const [id, tank] of model.tanks) {
    if (Math.abs(volumes.get(id) - tank.target) > 0.1) errors.add(id + " — απόκλιση από τον τελικό στόχο.");
  }
  return { stages, errors: [...errors], volumes };
}

// Distribute the peak among active routes and redistribute any share blocked by a line or tank limit.
function shoreShares(model, active, peak, topping) {
  if (peak <= 0 || !active.length) return new Map();
  const useCapacity = active.every(route => Number.isFinite(model.tanks.get(route.tank).capacity));
  const weights = new Map(active.map(route => [route.id, useCapacity ? model.tanks.get(route.tank).capacity : 1]));
  const flows = new Map(active.map(route => [route.id, 0]));
  const limits = active.flatMap(route => {
    const tank = model.tanks.get(route.tank);
    const finalRate = topping && txBlank(tank.topStart) ? rampOptional(tank.finalRate, tank.id + " topping rate", Infinity) : Infinity;
    return [{ ids: [route.id], cap: Math.min(finalRate, rampOptional(tank.rate, tank.id + " rate", Infinity),
      rampOptional(route.rate, route.id + " rate", Infinity)) }];
  });
  for (const [key, valve] of model.valves) {
    const ids = active.filter(route => route.chain.includes(key)).map(route => route.id);
    if (ids.length) limits.push({ ids, cap: rampOptional(valve.rate, key + " rate", Infinity) });
  }
  const free = new Set(weights.keys());
  let left = peak;
  while (left > rampTolerance && free.size) {
    let step = left / rampSum([...free].map(id => weights.get(id)));
    const remainingLimits = limits.map(({ ids, cap }) => ({
      ids: ids.filter(id => free.has(id)), room: cap - rampSum(ids.map(id => flows.get(id))),
    })).filter(limit => limit.ids.length);
    for (const limit of remainingLimits) {
      limit.step = Math.max(0, limit.room) / rampSum(limit.ids.map(id => weights.get(id)));
      step = Math.min(step, limit.step);
    }
    for (const id of free) {
      const change = step * weights.get(id);
      flows.set(id, flows.get(id) + change);
      left -= change;
    }
    for (const limit of remainingLimits) if (limit.step <= step + 1e-12) {
      for (const id of limit.ids) free.delete(id);
    }
  }
  // Keep the requested profile visible for diagnostics when redistribution cannot meet the shore setpoint.
  if (left > rampTolerance) {
    const totalWeight = rampSum(weights.values());
    return new Map([...weights].map(([id, weight]) => [id, weight / totalWeight]));
  }
  return new Map([...flows].map(([id, flow]) => [id, flow / peak]));
}

function rampLoading(model, config) {
  const routes = rampRouteList(model, config.loadingRoutes);
  const tanks = routes.map(route => model.tanks.get(route.tank));
  const peak = rampNumber(config.bulkRate, "Bulk shore rate", 1);
  const gap = rampChange(config.tankGap ?? 15, "Χρόνος μεταξύ ολοκληρώσεων");
  const parts = [];
  const events = [];
  let at = 0;
  let rate = 0;
  const add = (next, transition, hold, label, phase) => {
    if (transition > 0) {
      parts.push({ from: at, to: at + transition, a: rate, b: next, label, phase });
      at += transition;
    } else if (Math.abs(next - rate) > rampTolerance) {
      throw new Error(label + " — δήλωσε θετικό χρόνο μετάβασης.");
    }
    rate = next;
    if (hold > 0) {
      parts.push({ from: at, to: at + hold, a: rate, b: rate, label: label + " · hold", phase });
      at += hold;
    }
  };
  const parseSteps = (rows, phase) => {
    for (const [value, transition, hold, tag, ...extra] of rows) {
      const next = rampNumber(value, "Shore setpoint");
      if (extra.length || (phase === "up" ? next <= rate : next >= rate)) throw new Error("Έλεγξε τη σειρά των shore setpoints.");
      const move = rampChange(transition, "Χρόνος μετάβασης");
      const rest = rampOptional(hold, "Hold", 0);
      events.push({ at, name: tag || (phase === "up" ? "Shore rate-up" : "Shore rate-down"), before: rate, after: next,
        notice: at - rampOptional(config.notice, "Χρόνος ειδοποίησης", 0) });
      add(next, move, rest, tag || (phase === "up" ? "Ramp-up" : "Shore rate-down"), phase);
    }
  };
  const up = rampRows(config.shoreUp);
  if (!up.length) throw new Error("Δήλωσε τα shore ramp-up setpoints έως το bulk rate.");
  parseSteps(up, "up");
  if (Math.abs(rate - peak) > rampTolerance) throw new Error("Το τελευταίο ramp-up setpoint πρέπει να ισούται με το bulk rate.");
  const pre = parts.splice(0);
  const upMinutes = at;
  const upEventCount = events.length;
  const response = rampOptional(config.response, "Ανταπόκριση στεριάς", 0);
  if (response > 0) add(rate, 0, response, "Αναμονή ανταπόκρισης στεριάς", "response");
  const down = rampRows(config.shoreDown);
  if (config.downStyle === "thousands" || !config.downStyle) {
    const step = rampNumber(config.downStep ?? 1000, "Βήμα rate-down", 1);
    const count = Math.ceil(peak / step);
    if (count > 150) throw new Error("Αύξησε το βήμα ή δώσε συγκεκριμένα shore setpoints.");
    const move = rampChange(config.downTransition, "Χρόνος κάθε μείωσης");
    const hold = rampOptional(config.downHold, "Χρόνος σταθεροποίησης", 0);
    parseSteps(Array.from({ length: count }, (_, i) => [Math.max(0, peak - (i + 1) * step), move, i + 1 === count ? 0 : hold]), "down");
  } else {
    if (!down.length) throw new Error("Δήλωσε τα shore setpoints μετά από κάθε μείωση ή stop.");
    if (config.downStyle === "pumps" && (down.some(row => !row[3]) || new Set(down.map(row => row[3])).size !== down.length)) {
      throw new Error("Δήλωσε ένα διαφορετικό shore pump ID σε κάθε μείωση.");
    }
    parseSteps(down, "down");
    if (parts.at(-1)?.a === 0 && parts.at(-1)?.b === 0) throw new Error("Το hold μετά το τελικό μηδέν πρέπει να είναι 0.");
  }
  if (rate !== 0) throw new Error("Το τελευταίο shore setpoint πρέπει να είναι 0.");
  const firstFinish = at - gap * (routes.length - 1);
  if (firstFinish < upMinutes + response - rampTolerance) throw new Error("Το shore ramp-down είναι πολύ σύντομο για την απόσταση ολοκλήρωσης των tanks.");
  const finishes = routes.map((route, i) => firstFinish + i * gap);
  const remaining = new Map(tanks.map(tank => [tank.id, 0]));
  const tail = [];
  for (const part of parts) {
    const cuts = [part.from, ...finishes.filter(time => time > part.from + rampTolerance && time < part.to - rampTolerance), part.to];
    for (let i = 0; i < cuts.length - 1; i++) {
      const from = cuts[i];
      const to = cuts[i + 1];
      const active = routes.filter((route, j) => finishes[j] > from + rampTolerance);
      const atRate = time => part.a + (part.b - part.a) * (time - part.from) / (part.to - part.from);
      const shares = shoreShares(model, active, Math.max(atRate(from), atRate(to)), part.phase === "down");
      const rates = new Map(active.map(route => {
        const share = shares.get(route.id) ?? 0;
        const a = atRate(from) * share;
        const b = atRate(to) * share;
        remaining.set(route.tank, remaining.get(route.tank) + (a + b) * (to - from) / 120);
        return [route.id, [a, b]];
      }));
      tail.push(rampStage(part.label, from, to, rates, part.phase === "down" ? "topping" : part.phase));
    }
  }
  const preVolumes = tanks.map(tank => tank.target - tank.start - remaining.get(tank.id));
  if (preVolumes.some(volume => volume < -rampTolerance)) throw new Error("Κάποιο tank χρειάζεται περισσότερο ελεύθερο χώρο πριν το rate-down. Άλλαξε σειρά, rates ή διάρκεια.");
  const preTotal = rampSum(preVolumes);
  const upVolume = rampSum(pre.map(part => (part.a + part.b) * (part.to - part.from) / 120));
  const bulk = (preTotal - upVolume) * 60 / peak;
  if (bulk < -rampTolerance || preTotal <= 0) throw new Error("Το ramp-up και το ramp-down μεταφέρουν περισσότερο από τον διαθέσιμο όγκο.");
  const bulkMinutes = Math.max(0, bulk);
  const preRates = (a, b) => new Map(routes.map((route, i) => [route.id, [a, b].map(value => value * preVolumes[i] / preTotal)]));
  const stages = pre.map(part => rampStage(part.label, part.from, part.to, preRates(part.a, part.b), "up"));
  if (bulkMinutes > rampTolerance) stages.push(rampStage("Bulk", upMinutes, upMinutes + bulkMinutes, preRates(peak, peak), "bulk"));
  tail.forEach(stage => { stage.from += bulkMinutes; stage.to += bulkMinutes; });
  stages.push(...tail);
  const shoreDownEvents = events.slice(upEventCount);
  for (const event of shoreDownEvents) {
    event.at += bulkMinutes;
    event.notice += bulkMinutes;
    event.transitionAt = event.at;
  }
  if (response > 0) {
    const first = shoreDownEvents[0];
    events.push({ at: upMinutes + bulkMinutes, name: "Αίτημα πρώτου shore rate-down",
      notice: first.notice - response, before: peak, after: first.after });
    delete first.notice;
  }
  for (const [i, route] of routes.entries()) events.push({ at: finishes[i] + bulkMinutes, name: route.tank + " complete", tank: route.tank, rob: tanks[i].target });
  const checked = rampCheck(model, stages, "loading");
  const baseline = stages.find(stage => Math.abs(stage.to - (firstFinish + bulkMinutes)) < rampTolerance);
  const offsets = tanks.map(tank => {
    const atFirst = baseline?.rob.get(tank.id) ?? tank.start;
    return { tank, rate: peak * preVolumes[tanks.indexOf(tank)] / preTotal, atFirst,
      requestRob: tank.target - remaining.get(tank.id) };
  });
  return { ...checked, events, offsets, tailStart: upMinutes + bulkMinutes, title: "Πλάνο shore rate και topping-off" };
}

function rampVolumeInput(model, tank, raw, label) {
  if (txBlank(raw)) return null;
  if (/m$/i.test(raw)) {
    const level = rampNumber(raw.slice(0, -1).trim(), label);
    const volume = model.interpolateLevel(tank, level, 0);
    if (volume === null) throw new Error(label + " — η στάθμη είναι εκτός των καταχωρισμένων calibration points.");
    return volume;
  }
  return rampNumber(raw, label);
}

function rampDischarge(model, config) {
  const pumps = [];
  const byId = new Map();
  const routes = new Map();
  const byTank = new Map();
  for (const [id, routeId, rate, min, max, stop, floor, ...extra] of rampRows(config.shipPumps)) {
    if (extra.length || typeof id !== "string" || !txIdPattern.test(id) || byId.has(id)) throw new Error("Δήλωσε μοναδικό pump ID και route σε κάθε γραμμή.");
    const route = routes.get(routeId) || rampRoute(model, routeId);
    routes.set(routeId, route);
    const group = model.groups.get(route.pump);
    const pump = {
      id, route, rate: rampNumber(rate, id + " παροχή", 1),
      min: Math.max(rampOptional(min, id + " ελάχιστη παροχή", 0), rampOptional(group?.min, id + " min ομάδας", 0)),
      max: Math.min(rampOptional(max, id + " μέγιστη παροχή", Infinity), rampOptional(group?.rate, id + " max ομάδας", Infinity)),
      stopVolume: rampVolumeInput(model, route.tank, stop, id + " stop ROB"),
      floor: rampVolumeInput(model, route.tank, floor, id + " ελάχιστο ROB"),
    };
    if (!Number.isFinite(pump.max) || pump.max <= 0 || pump.min > pump.max || pump.rate < pump.min || pump.rate > pump.max) throw new Error(id + " — η δηλωμένη παροχή είναι εκτός εύρους.");
    if (!byTank.has(route.tank)) byTank.set(route.tank, []);
    byTank.get(route.tank).push(pump);
    byId.set(id, pump);
    pumps.push(pump);
  }
  if (!pumps.length || pumps.length > 40) throw new Error("Δήλωσε από 1 έως 40 αντλίες που θα συμμετέχουν.");
  for (const [id, group] of model.groups) {
    const count = pumps.filter(pump => pump.route.pump === id).length;
    if (!count) continue;
    const available = rampNumber(group.count, id + " διαθέσιμες", 1);
    if (!Number.isInteger(available) || count > available) throw new Error(id + " — έλεγξε το διαθέσιμο πλήθος της ομάδας.");
  }
  const order = (value, label) => {
    const ids = rampIds(value);
    if (!ids.length) return [...pumps];
    if (ids.length !== pumps.length || new Set(ids).size !== ids.length || ids.some(id => !byId.has(id))) {
      throw new Error(label + " — χρησιμοποίησε όλα τα online pump IDs, μία φορά το καθένα.");
    }
    return ids.map(id => byId.get(id));
  };
  const stopOrder = order(config.stopOrder, "Σειρά stop");
  const window = rampChange(config.stopWindow ?? 60, "Διάρκεια ramp-down");
  const firstAtStart = config.stopAnchor === "first";
  const spacing = window / (firstAtStart && pumps.length > 1 ? pumps.length - 1 : pumps.length);
  const minimumSpacing = rampOptional(config.minStopGap, "Ελάχιστη απόσταση stops", 0);
  if (pumps.length > 1 && spacing < Math.max(minimumSpacing, 1 / 60) - rampTolerance) {
    throw new Error("Η απόσταση μεταξύ stops είναι μικρότερη από τη συμφωνημένη. Αύξησε τη διάρκεια ramp-down.");
  }
  const shutdown = rampChange(config.stopTransition, "Διάρκεια μείωσης πριν από κάθε stop");
  if (shutdown > spacing + rampTolerance) throw new Error("Οι μεταβάσεις pump stop επικαλύπτονται. Μείωσε τον χρόνο μετάβασης ή αύξησε το παράθυρο.");
  const full = !txBlank(config.bulkMinutes);
  const startNotice = rampOptional(config.startNotice, "Χρόνος start notice", 0);
  const stopNotice = rampOptional(config.notice, "Χρόνος stop notice", 0);
  const events = [];
  let rampUpEnd = 0;
  const times = [0];
  if (full) {
    const startOrder = order(config.startOrder, "Σειρά start");
    const startup = rampChange(config.startTransition, "Διάρκεια εκκίνησης");
    const startGap = rampChange(config.startGap, "Χρόνος μεταξύ starts");
    if (pumps.length > 1 && startup > startGap + rampTolerance) throw new Error("Οι μεταβάσεις εκκίνησης επικαλύπτονται.");
    startOrder.forEach((pump, i) => {
      pump.start = i * startGap;
      pump.startEnd = pump.start + startup;
      times.push(pump.start, pump.startEnd);
      events.push({ at: pump.start, notice: pump.start - startNotice, name: "Start " + pump.id, tank: pump.route.tank });
    });
    rampUpEnd = startOrder.at(-1).startEnd;
  }
  const downStart = rampUpEnd + (full ? rampNumber(config.bulkMinutes, "Διάρκεια bulk") : 0);
  const stopBase = downStart + (firstAtStart && pumps.length > 1 ? shutdown : spacing);
  times.push(downStart);
  stopOrder.forEach((pump, i) => {
    pump.end = stopBase + i * spacing;
    pump.endStart = pump.end - shutdown;
    times.push(pump.endStart, pump.end);
  });
  const boundaries = [...new Set(times)].sort((a, b) => a - b).filter((time, i, sorted) => i === 0 || time - sorted[i - 1] > rampTolerance);
  const baseRate = (pump, time) => {
    const opening = full ? Math.max(0, Math.min(1, (time - pump.start) / (pump.startEnd - pump.start))) : 1;
    const closing = Math.max(0, Math.min(1, (pump.end - time) / shutdown));
    return pump.rate * Math.min(opening, closing);
  };
  const errors = new Set();
  const warnings = new Set();
  const scales = new Map();
  for (const [id, tankPumps] of byTank) {
    const tank = model.tanks.get(id);
    const ordered = [...tankPumps].sort((a, b) => a.end - b.end);
    const last = ordered.at(-1);
    if (last.stopVolume !== null && Math.abs(last.stopVolume - tank.target) > 0.1) {
      errors.add(last.id + " — ο τελευταίος στόχος stop διαφέρει από το τελικό heel.");
    }
    const knots = [{ time: 0, volume: tank.start }];
    for (const pump of ordered.slice(0, -1)) if (pump.stopVolume !== null) knots.push({ time: pump.end, volume: pump.stopVolume });
    knots.push({ time: last.end, volume: tank.target });
    const segments = [];
    for (let i = 1; i < knots.length; i++) {
      const start = knots[i - 1];
      const end = knots[i];
      const cuts = [start.time, ...boundaries.filter(time => time > start.time + rampTolerance && time < end.time - rampTolerance), end.time];
      let weight = 0;
      for (let j = 1; j < cuts.length; j++) {
        const [a, b] = [cuts[j - 1], cuts[j]];
        weight += rampSum(tankPumps.map(pump => baseRate(pump, a) + baseRate(pump, b))) * (b - a) / 120;
      }
      const volume = start.volume - end.volume;
      if (volume <= 0 || weight <= 0 || end.volume < tank.min) {
        throw new Error(id + " — τα stop ROB και το heel πρέπει να μειώνονται και να μένουν εντός ορίων.");
      }
      segments.push({ to: end.time, factor: volume / weight });
    }
    scales.set(id, segments);
  }
  const stages = [];
  for (let i = 1; i < boundaries.length; i++) {
    const [from, to] = [boundaries[i - 1], boundaries[i]];
    const middle = (from + to) / 2;
    const rates = new Map();
    const pumpRates = new Map();
    for (const pump of pumps) {
      const segment = scales.get(pump.route.tank).find(entry => middle < entry.to);
      if (!segment || baseRate(pump, middle) === 0) continue;
      const pair = [from, to].map(time => baseRate(pump, time) * segment.factor);
      pumpRates.set(pump.id, pair);
      if (Math.max(...pair) > pump.max + rampTolerance) {
        errors.add(pump.id + " — χρειάζονται " + txDisplay(Math.max(...pair)) + " m³/h, πάνω από το δηλωμένο μέγιστο.");
      }
      if ([from, to].some((time, j) => (!full || time >= pump.startEnd - rampTolerance) &&
          time <= pump.endStart + rampTolerance && pair[j] < pump.min - rampTolerance)) {
        errors.add(pump.id + " — η προβλεπόμενη σταθερή παροχή πέφτει κάτω από το δηλωμένο ελάχιστο.");
      }
      const current = rates.get(pump.route.id) || [0, 0];
      rates.set(pump.route.id, [current[0] + pair[0], current[1] + pair[1]]);
    }
    const phase = middle >= downStart ? "down" : middle < rampUpEnd ? "up" : "bulk";
    const stage = rampStage({ up: "Pump ramp-up", bulk: "Bulk", down: "Pump ramp-down" }[phase], from, to, rates, phase);
    stage.pumpRates = pumpRates;
    stages.push(stage);
  }
  const checked = rampCheck(model, stages, "unloading");
  for (const pump of stopOrder) {
    const index = stages.findIndex(stage => Math.abs(stage.to - pump.end) < rampTolerance);
    const stage = stages[index];
    const id = pump.route.tank;
    const rob = stage.rob.get(id);
    const level = model.interpolateLevel(id, rob, 1);
    if (pump.floor === null) warnings.add("Λείπει το εγκεκριμένο ελάχιστο ROB/level για μία ή περισσότερες αντλίες.");
    if (pump.floor !== null && rob < pump.floor - rampTolerance) errors.add(pump.id + " — το stop προβλέπεται κάτω από το δηλωμένο ελάχιστο ROB.");
    const transition = stages.find(entry => Math.abs(entry.from - pump.endStart) < rampTolerance);
    events.push({ at: pump.end, notice: pump.end - stopNotice, name: "Stop " + pump.id, tank: id, rob, level,
      transitionAt: pump.endStart, before: transition?.ends[0], after: stages[index + 1]?.ends[0] ?? 0 });
  }
  if (events.some(event => event.name.startsWith("Stop ") && event.level === null)) {
    warnings.add("Στάθμη εμφανίζεται μόνο εντός του calibration που έχεις καταχωρίσει για το συγκεκριμένο tank.");
  }
  const downStage = stages.find(stage => Math.abs(stage.to - downStart) < rampTolerance);
  const snapshot = [...byTank].map(([id]) => ({ id, volume: downStage?.rob.get(id) ?? model.tanks.get(id).start }));
  return { ...checked, errors: [...checked.errors, ...errors], warnings: [...warnings], events, spacing, snapshot, tailStart: downStart,
    title: "Διαδοχικές στάσεις cargo pumps" };
}

function rampBalance(model, config, mode) {
  const routes = rampRouteList(model, config.balanceRoutes);
  const tanks = routes.map(route => model.tanks.get(route.tank));
  const reference = config.reference || tanks[0].id;
  if (!tanks.some(tank => tank.id === reference)) throw new Error("Το tank αναφοράς πρέπει να συμμετέχει στην κατανομή.");
  if (tanks.some(tank => !Number.isFinite(tank.capacity))) throw new Error("Για κατανομή σε % δήλωσε τη χωρητικότητα κάθε tank.");
  const minutes = rampChange(config.balanceMinutes, "Χρόνος έως στόχο");
  const rate = rampNumber(config.balanceRate, "Συνολική παροχή", 1);
  const targetOffsets = new Map();
  if (config.balanceStyle !== "maintain") for (const value of rampIds(config.balanceOffsets)) {
    const [id, raw, ...extra] = value.split(":").map(part => part.trim());
    if (extra.length || !tanks.some(tank => tank.id === id) || targetOffsets.has(id) || txBlank(raw) || !Number.isFinite(Number(raw))) {
      throw new Error("Χρησιμοποίησε tank:ποσοστιαίες μονάδες, π.χ. T1:2,T2:-1.");
    }
    targetOffsets.set(id, Number(raw) / 100);
  }
  if (targetOffsets.get(reference)) throw new Error("Το tank αναφοράς έχει πάντοτε διαφορά 0.");
  const referenceTank = model.tanks.get(reference);
  const desired = tanks.map(tank => config.balanceStyle === "maintain" ?
    tank.start / tank.capacity - referenceTank.start / referenceTank.capacity : targetOffsets.get(tank.id) ?? 0);
  const sign = mode === "unloading" ? -1 : 1;
  const finalRef = (rampSum(tanks.map(tank => tank.start)) + sign * rate * minutes / 60 -
    rampSum(tanks.map((tank, i) => tank.capacity * desired[i]))) / rampSum(tanks.map(tank => tank.capacity));
  const rates = new Map(routes.map((route, i) => {
    const tank = tanks[i];
    const flow = (tank.capacity * (finalRef + desired[i]) - tank.start) * sign * 60 / minutes;
    if (flow < -rampTolerance) throw new Error(tank.id + " — ο στόχος απαιτεί ροή αντίθετη από την εργασία. Άλλαξε διάρκεια, συνολική παροχή ή διαφορά.");
    return [route.id, [Math.max(0, flow), Math.max(0, flow)]];
  }));
  const checked = rampCheck(model, [rampStage("Κατανομή παροχής", 0, minutes, rates, "bulk")], mode, false);
  const offsets = tanks.map((tank, i) => ({ tank, rate: rates.get(routes[i].id)[0], delta: desired[i] * 100,
    initialDelta: (tank.start / tank.capacity - referenceTank.start / referenceTank.capacity) * 100 }));
  return { ...checked, offsets, reference, title: "Παροχή ανά tank και διαφορά πλήρωσης" };
}

const rampColors = ["#49c5ed", "#55d49e", "#f4b761", "#b7a4ff", "#f88497", "#76baff"];

function rampClock(minutes) {
  const seconds = Math.round(Math.abs(minutes) * 60);
  const clock = [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
    .map(value => String(value).padStart(2, "0")).join(":");
  return (minutes < 0 ? "−" : "+") + clock;
}

function rampEventTime(epoch, minutes) {
  if (!Number.isFinite(minutes)) return "—";
  if (!Number.isFinite(epoch)) return rampClock(minutes);
  return new Date(epoch + Math.round(minutes * 60) * 1000).toISOString().slice(0, 19).replace("T", " ") + " UTC";
}

function rampChart(result, scope) {
  const stages = result.stages.filter(stage => scope === "all" || (scope === "up" ? stage.phase === "up" :
    ["down", "topping", "response"].includes(stage.phase)));
  if (!stages.length) return "<p class=\"hint\">Δεν υπάρχουν στάδια σε αυτή την προβολή.</p>";
  const start = stages[0].from;
  const end = stages.at(-1).to;
  const max = Math.max(1, ...stages.flatMap(stage => stage.ends));
  const limit = Number.isFinite(result.limit) && result.limit <= max * 1.5 ? result.limit : null;
  const ceiling = Math.max(max, limit || 0);
  const ids = [...new Set(stages.flatMap(stage => [...stage.tankRates.keys()]))];
  const color = id => rampColors[ids.indexOf(id) % rampColors.length];
  const columns = stages.map(stage => {
    const mean = rampSum(stage.ends) / 2;
    const title = [rampClock(stage.from) + " → " + rampClock(stage.to), txDisplay(mean) + " m³/h",
      ...[...stage.tankRates].map(([id, pair]) => id + " " + txDisplay(rampSum(pair) / 2) + " m³/h")].join(" · ");
    return `<div class="ramp-column" style="width:${(stage.to - stage.from) / (end - start) * 100}%" title="${opsEscape(title)}">
      ${[...stage.tankRates].map(([id, pair]) => `<div style="height:${rampSum(pair) / 2 / ceiling * 100}%;background:${color(id)}"></div>`).join("")}</div>`;
  }).join("");
  const markers = (result.events || []).filter(event => event.at >= start - rampTolerance && event.at <= end + rampTolerance &&
    (event.tank || scope !== "all")).map(event =>
    `<span class="ramp-marker" style="left:${(event.at - start) / (end - start) * 100}%" title="${opsEscape(event.name + " " + rampClock(event.at))}"></span>`).join("");
  return `<div class="ramp-legend">${ids.map(id => `<span><i style="background:${color(id)}"></i>${opsEscape(id)}</span>`).join("")}</div>
    <div class="ramp-grid"><div class="ramp-axis"><span>${txDisplay(ceiling, 0)}<br>m³/h</span><span>0</span></div>
    <div class="ramp-plot" role="img" aria-label="Μέση παροχή ανά tank και στάδιο, σε πραγματικό χρόνο">
      ${columns}${markers}${limit === null ? "" : `<span class="ramp-limit" style="bottom:${limit / ceiling * 100}%" title="Κοινό όριο ${txDisplay(limit, 0)} m³/h"></span>`}
    </div><div class="ramp-time"><span>${rampClock(start)}</span><span>${rampClock(end)}</span></div></div>
    <p class="hint">Οι μπάρες δείχνουν τη μέση παροχή ανά tank. Το πλάτος αντιστοιχεί στη διάρκεια. Οι κάθετες γραμμές σημειώνουν συμβάντα.</p>`;
}

function rampOffsetChart(result) {
  const offsets = result.offsets;
  if (!offsets || offsets.some(row => !Number.isFinite(row.tank.capacity))) return "";
  const rows = result.reference ? offsets.map(row => ({ id: row.tank.id, from: row.initialDelta, to: row.delta })) :
    offsets.map(row => ({ id: row.tank.id, from: (row.requestRob - row.tank.target) * 100 / row.tank.capacity,
      to: (row.atFirst - row.tank.target) * 100 / row.tank.capacity }));
  const max = Math.max(0.1, ...rows.flatMap(row => [Math.abs(row.from), Math.abs(row.to)]));
  const bar = value => `<div class="ramp-offset-track"><i style="left:${value < 0 ? 50 - Math.abs(value) / max * 50 : 50}%;width:${Math.abs(value) / max * 50}%"></i></div><strong>${txDisplay(value, 2)}</strong>`;
  return `<h4>${result.reference ? "Διαφορά από " + opsEscape(result.reference) : "Διαφορά από τον στόχο κάθε tank"} · ποσοστιαίες μονάδες</h4>
    <p class="hint">${result.reference ? "Αρχική → τελική διαφορά" : "Αίτημα rate-down → πρώτη ολοκλήρωση"}</p>
    ${rows.map(row => `<div class="ramp-offset-row"><span>${opsEscape(row.id)}</span>${bar(row.from)}${bar(row.to)}</div>`).join("")}`;
}

let guidedResult = null;

function clearGuidedRamp() {
  guidedResult = null;
  $("rampFeedback").textContent = "";
  $("rampOutput").hidden = true;
}

function guidedConfig() {
  return transferPlan().guided ??= {};
}

function syncGuidedRamp() {
  const config = guidedConfig();
  const defaults = { tankGap: 15, downStyle: "thousands", downStep: 1000, stopWindow: 60, stopAnchor: "start", balanceStyle: "target" };
  for (const field of $("rampGuided").querySelectorAll("[data-ramp]")) field.value = config[field.dataset.ramp] ?? defaults[field.dataset.ramp] ?? "";
  const loading = S.transfer.mode !== "unloading";
  $("rampShoreFields").hidden = !loading;
  $("rampShipFields").hidden = loading;
  $("rampCalculate").textContent = loading ? "Υπολογισμός shore ramp & topping-off" : "Υπολογισμός cargo pumps";
  updateRampFields();
  clearGuidedRamp();
}

function updateRampFields() {
  const style = guidedConfig().downStyle || "thousands";
  $("rampShoreThousands").hidden = style !== "thousands";
  $("rampShoreList").hidden = style === "thousands";
}

function runGuidedRamp(balance) {
  clearGuidedRamp();
  const output = $("rampOutput");
  const plan = transferPlan();
  const mode = S.transfer.mode ?? "loading";
  try {
    const config = guidedConfig();
    const model = rampModel(plan, config, !balance);
    const result = balance ? rampBalance(model, config, mode) : mode === "loading" ? rampLoading(model, config) : rampDischarge(model, config);
    result.limit = model.globalLimit;
    guidedResult = result;
    const hasErrors = result.errors.length > 0;
    $("rampFeedback").textContent = hasErrors ? "Σύγκρουση στα δηλωμένα όρια — έλεγξε τις αποκλίσεις παρακάτω." : "Ο υπολογισμός ολοκληρώθηκε με τα δηλωμένα δεδομένα.";
    $("rampTitle").textContent = result.title;
    $("rampIssues").innerHTML = [...result.errors, ...(result.warnings || [])].map((message, i) =>
      `<li class="${i < result.errors.length ? "transfer-error" : "hint"}">${opsEscape(message)}</li>`).join("");
    $("rampIssues").hidden = !$("rampIssues").innerHTML;
    const minutes = result.stages.at(-1).to;
    const moved = rampSum([...result.volumes].map(([id, volume]) => Math.abs(volume - model.tanks.get(id).start)));
    $("rampSummary").textContent = txDisplay(moved, 2) + " m³ · " + rampClock(minutes).slice(1) +
      (result.spacing ? " · Βήμα pump stops " + rampClock(result.spacing).slice(1) : "");
    $("rampView").value = "all";
    $("rampPlot").innerHTML = rampChart(result, "all");
    $("rampOffsetChart").innerHTML = rampOffsetChart(result);
    const epoch = opsDate(plan.start);
    const showValue = (value, digits = 2) => Number.isFinite(value) ? txDisplay(value, digits) : "—";
    $("rampEvents").innerHTML = result.events?.length ? tableHtml(
      ["Συμβάν", "Notice", "Έναρξη αλλαγής", "Ώρα συμβάντος", "Πριν → μετά m³/h", "Στάθμη m", "ROB m³"],
      [...result.events].sort((a, b) => a.at - b.at).map(event => [
        event.name, rampEventTime(epoch, event.notice), rampEventTime(epoch, event.transitionAt),
        rampEventTime(epoch, event.at), [event.before, event.after].some(Number.isFinite) ?
          showValue(event.before) + " → " + showValue(event.after) : "—", showValue(event.level, 3), showValue(event.rob),
      ])) : "";
    $("rampRates").innerHTML = tableHtml(["Από → έως", "Στάδιο", "Σύνολο m³/h", "Παροχή ανά tank m³/h", "Παροχή ανά αντλία m³/h", "ROB τέλους m³"],
      result.stages.map(stage => [
        rampClock(stage.from) + " → " + rampClock(stage.to), stage.label, stage.ends.map(value => showValue(value)).join(" → "),
        [...stage.tankRates].map(([id, pair]) => id + " " + pair.map(value => showValue(value)).join(" → ")).join(" · "),
        [...(stage.pumpRates || [])].map(([id, pair]) => id + " " + pair.map(value => showValue(value)).join(" → ")).join(" · ") || "—",
        [...stage.rob].map(([id, volume]) => id + " " + showValue(volume)).join(" · "),
      ]));
    $("rampOffsets").innerHTML = result.snapshot ? tableHtml(
      ["Tank", "Προβλεπόμενο ROB στην έναρξη ramp-down m³", "Στάθμη m", "Τελικό heel m³"],
      result.snapshot.map(({ id, volume }) => [id, showValue(volume), showValue(model.interpolateLevel(id, volume, 1), 3),
        showValue(result.volumes.get(id))])) : result.offsets ? tableHtml(
      result.reference ? ["Tank", "Παροχή m³/h", "Αρχική διαφορά π.μ.", "Τελική διαφορά π.μ.", "Τελικό ROB m³"] :
        ["Tank", "Bulk rate m³/h", "ROB στο αίτημα m³", "Υπόλοιπο στο αίτημα m³", "ROB στο πρώτο complete m³", "Υπόλοιπο στο πρώτο complete m³", "Υπόλοιπο στο πρώτο complete π.μ."],
      result.offsets.map(row => {
        const { tank } = row;
        const remaining = tank.target - row.atFirst;
        return result.reference ? [tank.id, showValue(row.rate), showValue(row.initialDelta), showValue(row.delta), showValue(result.volumes.get(tank.id))] :
          [tank.id, showValue(row.rate), showValue(row.requestRob), showValue(tank.target - row.requestRob), showValue(row.atFirst),
            showValue(remaining), showValue(Number.isFinite(tank.capacity) ? 100 * remaining / tank.capacity : NaN)];
      })) : "";
    output.hidden = false;
  } catch (error) {
    $("rampFeedback").textContent = error.message;
  }
}

document.addEventListener("DOMContentLoaded", () => {
  $("rampGuided").addEventListener("input", event => {
    const key = event.target.dataset.ramp;
    if (!key) return;
    guidedConfig()[key] = event.target.value;
    updateRampFields();
    clearGuidedRamp();
  });
  $("rampCalculate").addEventListener("click", () => runGuidedRamp(false));
  $("rampBalanceRun").addEventListener("click", () => runGuidedRamp(true));
  $("rampView").addEventListener("change", event => {
    if (guidedResult) $("rampPlot").innerHTML = rampChart(guidedResult, event.target.value);
  });
});
