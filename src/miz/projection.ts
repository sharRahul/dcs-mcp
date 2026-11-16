/**
 * Offline lat/long <-> DCS map coordinates.
 *
 * Every DCS theatre is a transverse-Mercator grid on WGS84 with its own central
 * meridian and false origin (constants in data/theatres.json, exported from DCS
 * by pydcs). DCS's `x` is the grid NORTHING and `y` the EASTING — the same
 * x-north/y-east convention as everywhere else in a mission.
 *
 * The forward and inverse series are Krüger's to sixth order in n (Karney 2011),
 * the same family PROJ's `tmerc` uses; within a theatre's extent they agree with
 * an exact solution to well under a millimetre, far below what DCS itself
 * resolves. What this cannot know is whether ED changes a theatre's origin in a
 * future version — cross-check one point with the live `dcs_convert_coords`
 * when a placement matters.
 */
import { theatre as theatreData, resolveTheatreName, type Projection } from "../data/reference.js";

const A_WGS84 = 6378137;
const F_WGS84 = 1 / 298.257223563;

const n = F_WGS84 / (2 - F_WGS84);
const n2 = n * n;
const n3 = n2 * n;
const n4 = n3 * n;
const n5 = n4 * n;
const n6 = n5 * n;
const E = Math.sqrt(F_WGS84 * (2 - F_WGS84));
/** Rectifying radius. */
const A_RECT = (A_WGS84 / (1 + n)) * (1 + n2 / 4 + n4 / 64 + n6 / 256);

const ALPHA = [
  n / 2 - (2 * n2) / 3 + (5 * n3) / 16 + (41 * n4) / 180 - (127 * n5) / 288 + (7891 * n6) / 37800,
  (13 * n2) / 48 - (3 * n3) / 5 + (557 * n4) / 1440 + (281 * n5) / 630 - (1983433 * n6) / 1935360,
  (61 * n3) / 240 - (103 * n4) / 140 + (15061 * n5) / 26880 + (167603 * n6) / 181440,
  (49561 * n4) / 161280 - (179 * n5) / 168 + (6601661 * n6) / 7257600,
  (34729 * n5) / 80640 - (3418889 * n6) / 1995840,
  (212378941 * n6) / 319334400,
];

const BETA = [
  n / 2 - (2 * n2) / 3 + (37 * n3) / 96 - n4 / 360 - (81 * n5) / 512 + (96199 * n6) / 604800,
  n2 / 48 + n3 / 15 - (437 * n4) / 1440 + (46 * n5) / 105 - (1118711 * n6) / 3870720,
  (17 * n3) / 480 - (37 * n4) / 840 - (209 * n5) / 4480 + (5569 * n6) / 90720,
  (4397 * n4) / 161280 - (11 * n5) / 504 - (830251 * n6) / 7257600,
  (4583 * n5) / 161280 - (108847 * n6) / 3991680,
  (20648693 * n6) / 638668800,
];

const RAD = Math.PI / 180;

/** WGS84 lat/lon (degrees) -> grid { x: northing, y: easting } in metres. */
export function projectLatLon(p: Projection, lat: number, lon: number): { x: number; y: number } {
  const phi = lat * RAD;
  const dLambda = (lon - p.centralMeridian) * RAD;
  const sinPhi = Math.sin(phi);
  const t = Math.sinh(Math.atanh(sinPhi) - E * Math.atanh(E * sinPhi));
  const xiP = Math.atan2(t, Math.cos(dLambda));
  const etaP = Math.atanh(Math.sin(dLambda) / Math.sqrt(1 + t * t));
  let xi = xiP;
  let eta = etaP;
  for (let j = 1; j <= 6; j++) {
    xi += ALPHA[j - 1] * Math.sin(2 * j * xiP) * Math.cosh(2 * j * etaP);
    eta += ALPHA[j - 1] * Math.cos(2 * j * xiP) * Math.sinh(2 * j * etaP);
  }
  return {
    x: p.scaleFactor * A_RECT * xi + p.falseNorthing,
    y: p.scaleFactor * A_RECT * eta + p.falseEasting,
  };
}

/** Grid { x: northing, y: easting } -> WGS84 lat/lon in degrees. */
export function unprojectXY(p: Projection, x: number, y: number): { lat: number; lon: number } {
  const xi = (x - p.falseNorthing) / (p.scaleFactor * A_RECT);
  const eta = (y - p.falseEasting) / (p.scaleFactor * A_RECT);
  let xiP = xi;
  let etaP = eta;
  for (let j = 1; j <= 6; j++) {
    xiP -= BETA[j - 1] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
    etaP -= BETA[j - 1] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
  }
  // Conformal latitude, then iterate to geodetic latitude.
  const chi = Math.asin(Math.sin(xiP) / Math.cosh(etaP));
  let phi = chi;
  for (let i = 0; i < 15; i++) {
    const es = E * Math.sin(phi);
    const next =
      2 * Math.atan(Math.tan(Math.PI / 4 + chi / 2) * Math.pow((1 + es) / (1 - es), E / 2)) - Math.PI / 2;
    if (Math.abs(next - phi) < 1e-14) {
      phi = next;
      break;
    }
    phi = next;
  }
  const dLambda = Math.atan2(Math.sinh(etaP), Math.cos(xiP));
  return { lat: phi / RAD, lon: p.centralMeridian + dLambda / RAD };
}

export function latLonToXY(theatreName: string, lat: number, lon: number): { x: number; y: number } {
  return projectLatLon(theatreData(theatreName).projection, lat, lon);
}

export function xyToLatLon(theatreName: string, x: number, y: number): { lat: number; lon: number } {
  return unprojectXY(theatreData(theatreName).projection, x, y);
}

export function supportsTheatre(name: string): boolean {
  return resolveTheatreName(name) !== undefined;
}
