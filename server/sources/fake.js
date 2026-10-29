// Simulated KSP flight, so the dashboard can be built and tested without the
// game running. A two-stage rocket flies a gravity turn from KSC into a ~80 km
// Kerbin orbit, coasts for a few minutes, then "reverts to launch" (which, like
// the real game, makes Universal Time jump backwards).
//
// The physics are deliberately simple (2D, equatorial, constant thrust/Isp,
// exponential atmosphere) but the numbers are in the right range for stock KSP.

const MU = 3.5316e12; // Kerbin gravitational parameter, m^3/s^2
const RADIUS = 600000; // m
const ROTATION_RATE = (2 * Math.PI) / 21549.425; // rad/s
const ATMOSPHERE_HEIGHT = 70000; // m
const SCALE_HEIGHT = 5600; // m
const SEA_LEVEL_DENSITY = 1.225; // kg/m^3
const G0 = 9.80665;

const KSC_LATITUDE = -0.0972;
const KSC_LONGITUDE = -74.5577;
const PAD_ALTITUDE = 70;

// KSP fuel tanks hold LiquidFuel:Oxidizer at 0.9:1.1 by volume, 5 kg per unit.
const LF_UNITS_PER_KG = 0.45 / 5;
const OX_UNITS_PER_KG = 0.55 / 5;
const MAX_ELECTRIC_CHARGE = 150;

const STAGES = [
  { dryMass: 2000, propellant: 11000, thrust: 300000, isp: 290, dragArea: 1.2 },
  { dryMass: 3000, propellant: 4000, thrust: 60000, isp: 340, dragArea: 0.6 }
];

const START_UT = 2_000_000;
const COUNTDOWN = 10; // s on the pad before liftoff
const TARGET_APOAPSIS = 80000;
const TARGET_PERIAPSIS = 75000;
const ORBIT_COAST = 300; // s in orbit before reverting
const STEP = 0.02; // physics step, s

export class Simulation {
  constructor() {
    this.revert();
  }

  revert() {
    this.ut = START_UT;
    this.launchUT = START_UT + COUNTDOWN;
    this.phase = 'prelaunch'; // prelaunch | ascent | coast | circularize | orbit
    this.stageIndex = 0;
    this.propellant = STAGES.map((s) => s.propellant);
    this.throttle = 0;
    this.pitch = 90;
    this.electricCharge = MAX_ELECTRIC_CHARGE;
    this.orbitTime = 0;
    this.nonGravAccel = G0; // sitting on the pad reads 1 g
    this.placeOnPad();
  }

  placeOnPad() {
    const angle = degToRad(KSC_LONGITUDE) + ROTATION_RATE * this.ut;
    const r = RADIUS + PAD_ALTITUDE;
    this.x = r * Math.cos(angle);
    this.y = r * Math.sin(angle);
    this.vx = -ROTATION_RATE * this.y;
    this.vy = ROTATION_RATE * this.x;
  }

  get mass() {
    let m = 0;
    for (let i = this.stageIndex; i < STAGES.length; i++) {
      m += STAGES[i].dryMass + this.propellant[i];
    }
    return m;
  }

  advance(seconds) {
    for (let t = 0; t < seconds; t += STEP) {
      this.step(Math.min(STEP, seconds - t));
    }
  }

  step(dt) {
    this.ut += dt;

    if (this.phase === 'prelaunch') {
      this.placeOnPad();
      if (this.ut >= this.launchUT) {
        this.phase = 'ascent';
        this.throttle = 1;
      }
      return;
    }

    this.guide(dt);
    this.integrate(dt);

    this.electricCharge += (this.phase === 'orbit' ? 0.5 : -0.05) * dt;
    this.electricCharge = Math.min(MAX_ELECTRIC_CHARGE, Math.max(0, this.electricCharge));
  }

  guide(dt) {
    const altitude = this.altitude;
    const orbit = this.orbit();
    const stage = STAGES[this.stageIndex];

    // Drop an empty stage.
    if (this.propellant[this.stageIndex] <= 0 && this.stageIndex < STAGES.length - 1) {
      this.stageIndex++;
    }

    switch (this.phase) {
      case 'ascent': {
        // Classic sqrt gravity turn: vertical to 1 km, horizontal by 45 km.
        const progress = clamp((altitude - 1000) / 44000, 0, 1);
        this.pitch = 90 * (1 - Math.sqrt(progress));
        this.throttle = 1;
        if (orbit.apoapsis >= TARGET_APOAPSIS) {
          this.throttle = 0;
          this.phase = 'coast';
        }
        break;
      }
      case 'coast': {
        this.pitch = radToDeg(Math.asin(clamp(this.verticalSpeed / this.orbitalSpeed, -1, 1)));
        // Top up apoapsis lost to drag while still in the atmosphere.
        this.throttle = altitude < ATMOSPHERE_HEIGHT && orbit.apoapsis < TARGET_APOAPSIS - 500 ? 0.2 : 0;
        const acceleration = stage.thrust / this.mass;
        const burnTime = this.circularizationDeltaV(orbit) / acceleration;
        if (altitude > ATMOSPHERE_HEIGHT && orbit.timeToApoapsis <= burnTime / 2) {
          this.phase = 'circularize';
        }
        break;
      }
      case 'circularize': {
        // Burn horizontally, nudging the nose to hold vertical speed near zero.
        this.pitch = clamp(-0.3 * this.verticalSpeed, -15, 15);
        this.throttle = 1;
        if (orbit.periapsis >= TARGET_PERIAPSIS || this.propellant[this.stageIndex] <= 0) {
          this.throttle = 0;
          this.phase = 'orbit';
        }
        break;
      }
      case 'orbit': {
        this.pitch = 0;
        this.throttle = 0;
        this.orbitTime += dt;
        if (this.orbitTime >= ORBIT_COAST) {
          this.revert();
        }
        break;
      }
    }
  }

  integrate(dt) {
    if (this.phase === 'prelaunch') return;

    const stage = STAGES[this.stageIndex];
    const mass = this.mass;
    const r = Math.hypot(this.x, this.y);
    const upX = this.x / r;
    const upY = this.y / r;
    const eastX = -upY;
    const eastY = upX;

    // Thrust
    const fuel = this.propellant[this.stageIndex];
    const thrust = fuel > 0 ? this.throttle * stage.thrust : 0;
    this.propellant[this.stageIndex] = Math.max(0, fuel - (thrust / (stage.isp * G0)) * dt);
    const pitch = degToRad(this.pitch);
    const thrustX = thrust * (Math.cos(pitch) * eastX + Math.sin(pitch) * upX);
    const thrustY = thrust * (Math.cos(pitch) * eastY + Math.sin(pitch) * upY);

    // Drag against the rotating atmosphere
    const [relX, relY] = this.surfaceVelocity();
    const relSpeed = Math.hypot(relX, relY);
    const dragFactor = -0.5 * this.airDensity * relSpeed * stage.dragArea;
    const dragX = dragFactor * relX;
    const dragY = dragFactor * relY;

    const gravity = -MU / (r * r);
    const ax = (thrustX + dragX) / mass + gravity * upX;
    const ay = (thrustY + dragY) / mass + gravity * upY;
    this.nonGravAccel = Math.hypot(thrustX + dragX, thrustY + dragY) / mass;

    this.vx += ax * dt;
    this.vy += ay * dt;
    this.x += this.vx * dt;
    this.y += this.vy * dt;
  }

  get altitude() {
    return Math.hypot(this.x, this.y) - RADIUS;
  }

  get airDensity() {
    const h = this.altitude;
    return h < ATMOSPHERE_HEIGHT ? SEA_LEVEL_DENSITY * Math.exp(-h / SCALE_HEIGHT) : 0;
  }

  get verticalSpeed() {
    return (this.x * this.vx + this.y * this.vy) / Math.hypot(this.x, this.y);
  }

  get orbitalSpeed() {
    return Math.hypot(this.vx, this.vy);
  }

  surfaceVelocity() {
    return [this.vx + ROTATION_RATE * this.y, this.vy - ROTATION_RATE * this.x];
  }

  circularizationDeltaV(orbit) {
    const ra = RADIUS + orbit.apoapsis;
    const speedAtApoapsis = Math.sqrt(MU * (2 / ra - 1 / orbit.semiMajorAxis));
    return Math.max(0, Math.sqrt(MU / ra) - speedAtApoapsis);
  }

  // Keplerian elements from the current state vector.
  orbit() {
    const { x, y, vx, vy } = this;
    const r = Math.hypot(x, y);
    const v2 = vx * vx + vy * vy;
    const energy = v2 / 2 - MU / r;
    const h = x * vy - y * vx;
    const a = -MU / (2 * energy);
    const rv = x * vx + y * vy;
    const ex = ((v2 - MU / r) * x - rv * vx) / MU;
    const ey = ((v2 - MU / r) * y - rv * vy) / MU;
    const e = Math.hypot(ex, ey);

    const trueAnomaly = Math.sign(h || 1) * Math.atan2(ex * y - ey * x, ex * x + ey * y);
    const E = 2 * Math.atan2(Math.sqrt(1 - e) * Math.sin(trueAnomaly / 2), Math.sqrt(1 + e) * Math.cos(trueAnomaly / 2));
    const M = mod(E - e * Math.sin(E), 2 * Math.PI);
    const n = Math.sqrt(MU / (a * a * a));

    return {
      semiMajorAxis: a,
      eccentricity: e,
      apoapsis: a * (1 + e) - RADIUS,
      periapsis: a * (1 - e) - RADIUS,
      period: (2 * Math.PI) / n,
      timeToPeriapsis: (2 * Math.PI - M) / n,
      timeToApoapsis: mod(Math.PI - M, 2 * Math.PI) / n
    };
  }

  get situation() {
    if (this.phase === 'prelaunch') return 'PRE_LAUNCH';
    if (this.altitude < ATMOSPHERE_HEIGHT) return 'FLYING';
    return this.orbit().periapsis > ATMOSPHERE_HEIGHT ? 'ORBITING' : 'SUB_ORBITAL';
  }

  // Telemetry values keyed by dictionary id.
  snapshot() {
    const orbit = this.orbit();
    const [relX, relY] = this.surfaceVelocity();
    const surfaceSpeed = Math.hypot(relX, relY);
    const angle = Math.atan2(this.y, this.x) - ROTATION_RATE * this.ut;
    const propellant = this.propellant.slice(this.stageIndex).reduce((sum, p) => sum + p, 0);
    const launched = this.phase !== 'prelaunch';

    return {
      'vessel.name': 'Mun Or Bust (simulated)',
      'vessel.body': 'Kerbin',
      'vessel.situation': this.situation,
      'control.stage': launched ? STAGES.length - 1 - this.stageIndex : STAGES.length,
      'control.throttle': this.throttle * 100,
      'flight.altitude': this.altitude,
      'flight.surfaceSpeed': surfaceSpeed,
      'flight.verticalSpeed': this.verticalSpeed,
      'flight.orbitalSpeed': this.orbitalSpeed,
      'flight.gForce': this.nonGravAccel / G0,
      'flight.dynamicPressure': (0.5 * this.airDensity * surfaceSpeed * surfaceSpeed) / 1000,
      'flight.latitude': KSC_LATITUDE,
      'flight.longitude': radToDeg(mod(angle + Math.PI, 2 * Math.PI) - Math.PI),
      'attitude.pitch': this.pitch,
      'attitude.heading': 90,
      'attitude.roll': 0,
      'orbit.apoapsis': orbit.apoapsis,
      'orbit.periapsis': orbit.periapsis,
      'orbit.timeToApoapsis': orbit.timeToApoapsis,
      'orbit.timeToPeriapsis': orbit.timeToPeriapsis,
      'orbit.inclination': 0,
      'orbit.eccentricity': orbit.eccentricity,
      'orbit.period': orbit.period,
      'resources.liquidFuel': propellant * LF_UNITS_PER_KG,
      'resources.oxidizer': propellant * OX_UNITS_PER_KG,
      'resources.electricCharge': this.electricCharge,
      'time.ut': this.ut,
      'time.met': Math.max(0, this.ut - this.launchUT)
    };
  }
}

export function createFakeSource({ publish, rateMs, simSpeed, log }) {
  const sim = new Simulation();
  log(`simulating a launch from KSC at ${simSpeed}x speed`);

  const timer = setInterval(() => {
    sim.advance((rateMs / 1000) * simSpeed);
    publish(sim.snapshot());
  }, rateMs);

  return {
    name: 'Simulator',
    stop: () => clearInterval(timer)
  };
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

function mod(a, n) {
  return ((a % n) + n) % n;
}

function degToRad(d) {
  return (d * Math.PI) / 180;
}

function radToDeg(r) {
  return (r * 180) / Math.PI;
}
