// Float64 JavaScript port of simplequakes.okada85.displacement (Okada, 1985).
//
// A faithful, scalar transcription of python/src/simplequakes/okada85.py used
// (a) as the CPU baseline in the benchmark and (b) as the correctness oracle
// for the GLSL shader. Kept structurally identical to the Python reference:
// setup_args -> chinnery -> strike-slip / dip-slip / tensile subfunctions.
//
// Conventions match the reference: e, n are East/North offsets from the fault
// centroid; depth is centroid depth (positive down); strike/dip/rake in
// degrees; all lengths in consistent units.

const EPS = Number.EPSILON; // == numpy np.spacing(1)
const DEG = Math.PI / 180;

// I... displacement subfunctions [Okada eqs (28)-(29)].
function I5(xi, eta, q, dip, nu, R, db) {
  const sd = Math.sin(dip), cd = Math.cos(dip);
  const X = Math.sqrt(xi * xi + q * q);
  const xs = xi === 0 ? xi + EPS : xi; // guard the cos(dip)>0 branch
  if (cd > EPS) {
    return (1 - 2 * nu) * 2 / cd *
      Math.atan((eta * (X + q * cd) + X * (R + X) * sd) /
                (xs * (R + X) * cd));
  }
  return -(1 - 2 * nu) * xi * sd / (R + db);
}

function I4(db, eta, q, dip, nu, R) {
  const sd = Math.sin(dip), cd = Math.cos(dip);
  if (cd > EPS) {
    return (1 - 2 * nu) / cd * (Math.log(R + db) - sd * Math.log(R + eta));
  }
  return -(1 - 2 * nu) * q / (R + db);
}

function I3(eta, q, dip, nu, R) {
  const sd = Math.sin(dip), cd = Math.cos(dip);
  const yb = eta * cd + q * sd;
  const db = eta * sd - q * cd;
  if (cd > EPS) {
    return (1 - 2 * nu) * (yb / (cd * (R + db)) - Math.log(R + eta)) +
      sd / cd * I4(db, eta, q, dip, nu, R);
  }
  return (1 - 2 * nu) / 2 *
    (eta / (R + db) + yb * q / ((R + db) * (R + db)) - Math.log(R + eta));
}

function I2(eta, q, dip, nu, R) {
  return (1 - 2 * nu) * (-Math.log(R + eta)) - I3(eta, q, dip, nu, R);
}

function I1(xi, eta, q, dip, nu, R) {
  const sd = Math.sin(dip), cd = Math.cos(dip);
  const db = eta * sd - q * cd;
  if (cd > EPS) {
    return (1 - 2 * nu) * (-xi / (cd * (R + db))) -
      sd / cd * I5(xi, eta, q, dip, nu, R, db);
  }
  return -(1 - 2 * nu) / 2 * xi * q / ((R + db) * (R + db));
}

// Displacement subfunctions [Okada eqs (25)-(27)].
function ux_ss(xi, eta, q, dip, nu) {
  const sd = Math.sin(dip);
  const R = Math.sqrt(xi * xi + eta * eta + q * q);
  return xi * q / (R * (R + eta)) + Math.atan(xi * eta / (q * R)) +
    I1(xi, eta, q, dip, nu, R) * sd;
}
function uy_ss(xi, eta, q, dip, nu) {
  const sd = Math.sin(dip), cd = Math.cos(dip);
  const R = Math.sqrt(xi * xi + eta * eta + q * q);
  return (eta * cd + q * sd) * q / (R * (R + eta)) + q * cd / (R + eta) +
    I2(eta, q, dip, nu, R) * sd;
}
function uz_ss(xi, eta, q, dip, nu) {
  const sd = Math.sin(dip), cd = Math.cos(dip);
  const R = Math.sqrt(xi * xi + eta * eta + q * q);
  const db = eta * sd - q * cd;
  return (eta * sd - q * cd) * q / (R * (R + eta)) + q * sd / (R + eta) +
    I4(db, eta, q, dip, nu, R) * sd;
}
function ux_ds(xi, eta, q, dip, nu) {
  const sd = Math.sin(dip), cd = Math.cos(dip);
  const R = Math.sqrt(xi * xi + eta * eta + q * q);
  return q / R - I3(eta, q, dip, nu, R) * sd * cd;
}
function uy_ds(xi, eta, q, dip, nu) {
  const sd = Math.sin(dip), cd = Math.cos(dip);
  const R = Math.sqrt(xi * xi + eta * eta + q * q);
  return (eta * cd + q * sd) * q / (R * (R + xi)) +
    cd * Math.atan(xi * eta / (q * R)) -
    I1(xi, eta, q, dip, nu, R) * sd * cd;
}
function uz_ds(xi, eta, q, dip, nu) {
  const sd = Math.sin(dip), cd = Math.cos(dip);
  const R = Math.sqrt(xi * xi + eta * eta + q * q);
  const db = eta * sd - q * cd;
  return db * q / (R * (R + xi)) + sd * Math.atan(xi * eta / (q * R)) -
    I5(xi, eta, q, dip, nu, R, db) * sd * cd;
}
function ux_tf(xi, eta, q, dip, nu) {
  const sd = Math.sin(dip);
  const R = Math.sqrt(xi * xi + eta * eta + q * q);
  return q * q / (R * (R + eta)) - I3(eta, q, dip, nu, R) * sd * sd;
}
function uy_tf(xi, eta, q, dip, nu) {
  const sd = Math.sin(dip), cd = Math.cos(dip);
  const R = Math.sqrt(xi * xi + eta * eta + q * q);
  return -(eta * sd - q * cd) * q / (R * (R + xi)) -
    sd * (xi * q / (R * (R + eta)) - Math.atan(xi * eta / (q * R))) -
    I1(xi, eta, q, dip, nu, R) * sd * sd;
}
function uz_tf(xi, eta, q, dip, nu) {
  const sd = Math.sin(dip), cd = Math.cos(dip);
  const R = Math.sqrt(xi * xi + eta * eta + q * q);
  const db = eta * sd - q * cd;
  return (eta * cd + q * sd) * q / (R * (R + xi)) +
    cd * (xi * q / (R * (R + eta)) - Math.atan(xi * eta / (q * R))) -
    I5(xi, eta, q, dip, nu, R, db) * sd * sd;
}

// Chinnery's notation [Okada eq (24)]: f(x,p) - f(x,p-W) - f(x-L,p) + f(x-L,p-W).
function chinnery(f, x, p, L, W, q, dip, nu) {
  return f(x, p, q, dip, nu) - f(x, p - W, q, dip, nu) -
    f(x - L, p, q, dip, nu) + f(x - L, p - W, q, dip, nu);
}

/**
 * Okada (1985) surface displacement for a single rectangular dislocation.
 * Scalar; mirrors okada85.displacement in the Python reference.
 * @returns {[number, number, number]} [ue, un, uz]
 */
export function displacement(e, n, depth, strike, dip, L, W, rake, slip, open, nu = 0.25) {
  strike *= DEG;
  dip *= DEG;
  rake *= DEG;
  const sstr = Math.sin(strike), cstr = Math.cos(strike);
  const sdip = Math.sin(dip), cdip = Math.cos(dip);

  const U1s = Math.cos(rake) * slip / (2 * Math.PI);
  const U2s = Math.sin(rake) * slip / (2 * Math.PI);
  const U3s = open / (2 * Math.PI);

  // Centroid -> Okada reference point (center of top edge), then x, p, q.
  const d = depth + sdip * W / 2;
  const ec = e + cstr * cdip * W / 2;
  const nc = n - sstr * cdip * W / 2;
  const x = cstr * nc + sstr * ec + L / 2;
  const y = sstr * nc - cstr * ec + cdip * W;
  const p = y * cdip + d * sdip;
  const q = y * sdip - d * cdip;

  const ux = -U1s * chinnery(ux_ss, x, p, L, W, q, dip, nu)
             - U2s * chinnery(ux_ds, x, p, L, W, q, dip, nu)
             + U3s * chinnery(ux_tf, x, p, L, W, q, dip, nu);
  const uy = -U1s * chinnery(uy_ss, x, p, L, W, q, dip, nu)
             - U2s * chinnery(uy_ds, x, p, L, W, q, dip, nu)
             + U3s * chinnery(uy_tf, x, p, L, W, q, dip, nu);
  const uz = -U1s * chinnery(uz_ss, x, p, L, W, q, dip, nu)
             - U2s * chinnery(uz_ds, x, p, L, W, q, dip, nu)
             + U3s * chinnery(uz_tf, x, p, L, W, q, dip, nu);

  const ue = sstr * ux - cstr * uy;
  const un = cstr * ux + sstr * uy;
  return [ue, un, uz];
}
