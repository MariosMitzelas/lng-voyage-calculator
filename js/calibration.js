"use strict";

const cargoFillPoints = [96, 98, 98.5, 99, 100];
const cargoTankId = (id) => {
  const match = /^(?:CT|T|Cargo\s+Tank\s*)?([1-4])$/i.exec(String(id ?? "").trim());
  return match ? "T" + match[1] : "";
};

function validCargoCalibration(profile) {
  return profile?.version === 1 && Array.isArray(profile.tanks) && profile.tanks.length === 4
    && profile.tanks.every((tank, i) => {
      const id = "T" + (i + 1);
      return tank?.id === id && tank.name === "Cargo Tank " + (i + 1)
        && Array.isArray(tank.points) && tank.points.length === cargoFillPoints.length
        && tank.points.every((point, j) => point?.fillPct === cargoFillPoints[j]
          && Number.isFinite(point.volumeM3) && point.volumeM3 > (tank.points[j - 1]?.volumeM3 ?? 0)
          && Number.isInteger(point.heightMm) && point.heightMm > (tank.points[j - 1]?.heightMm ?? 0))
        && Number.isFinite(tank.includingHatchM3) && tank.includingHatchM3 >= tank.points.at(-1).volumeM3;
    });
}

function cargoCalibration(state = S) {
  return validCargoCalibration(state.cargoCalibration) ? state.cargoCalibration : null;
}

function cargoTankLabel(id, state = S) {
  return cargoCalibration(state)?.tanks.find(tank => tank.id === cargoTankId(id))?.name ?? id;
}

function cargoVolumeAtFill(tank, fillPct) {
  return tank.points.find(point => point.fillPct === fillPct)?.volumeM3 ?? tank.points.at(-1).volumeM3 * fillPct / 100;
}

function cargoTotalAtFill(profile, fillPct) {
  return profile.tanks.reduce((sum, tank) => sum + cargoVolumeAtFill(tank, fillPct), 0);
}

function installCargoCalibration(profile, state = S) {
  if (!validCargoCalibration(profile)) return;
  state.cargoCalibration = JSON.parse(JSON.stringify(profile));
  state.capacity = Math.round(cargoTotalAtFill(profile, 100) * 1000) / 1000;
  const transfer = state.transfer ??= {};
  for (const mode of ["loading", "unloading"]) {
    const plan = transfer[mode] ??= {};
    if (!plan.tanks?.length) plan.tanks = profile.tanks.map(({ id }) => ({ id }));
  }
}

function calibratedTransferPlan(plan, mode, state = S) {
  const profile = cargoCalibration(state);
  if (!profile) return plan;
  const fill = mode === "loading" && state.fillPct > 0 && state.fillPct <= 100 ? state.fillPct : 100;
  return { ...plan, tanks: (plan.tanks || []).map(row => {
    const tank = profile.tanks.find(entry => entry.id === cargoTankId(row.id));
    if (!tank) return row;
    const max = cargoVolumeAtFill(tank, fill);
    const manual = txNum(row.max);
    return { ...row, capacity: tank.points.at(-1).volumeM3,
      max: txBlank(row.max) ? max : Number.isFinite(manual) && manual >= 0 ? Math.min(manual, max) : row.max };
  }) };
}

function cargoCalibrationPoints(id, state = S) {
  return cargoCalibration(state)?.tanks.find(tank => tank.id === cargoTankId(id))?.points
    .map(point => [point.heightMm / 1000, point.volumeM3]) ?? [];
}

function renderCargoCalibration() {
  const details = $("cargoCalibration");
  if (!details) return;
  const profile = cargoCalibration();
  $("capacity").readOnly = Boolean(profile);
  details.hidden = !profile;
  if (!profile) return;
  const headers = ["Cargo Tank", ...cargoFillPoints.map(fill => fmt(fill, 1) + "% · m³ / mm"), "100% με hatch · m³"];
  const volumes = tank => tank.points.map(point => fmt(point.volumeM3, 3) + " / " + fmt(point.heightMm));
  const rows = profile.tanks.map(tank => [tank.name, ...volumes(tank), fmt(tank.includingHatchM3, 3)]);
  rows.push(["Σύνολο m³", ...cargoFillPoints.map(fill => fmt(cargoTotalAtFill(profile, fill), 3)),
    fmt(profile.tanks.reduce((sum, tank) => sum + tank.includingHatchM3, 0), 3)]);
  $("cargoCalibrationTable").innerHTML = tableHtml(headers, rows);
  $("cargoCalibrationFill").textContent = "Επιλεγμένο γέμισμα " + fmt(S.fillPct, 1) + "% · " +
    fmt(cargoTotalAtFill(profile, S.fillPct), 3) + " m³ χωρίς expansion hatch.";
}
