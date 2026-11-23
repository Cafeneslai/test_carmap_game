/**
 * compass.js — Convert the car heading into the rotation of the minimap arrow
 */

/**
 * The car heading is the yaw about +Y with the nose at +Z, so heading 0 faces south and
 * PI/2 faces east (north is -Z, east is +X). The minimap arrow points north at 0deg and
 * CSS rotates clockwise, so the compass bearing is 180deg minus the yaw.
 *
 * @param {number} heading radians
 * @returns {number} degrees, clockwise from north
 */
export function headingToBearingDeg(heading) {
  return 180 - (heading * 180) / Math.PI;
}
