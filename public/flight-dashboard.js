// Creates a starter "KSP Flight Dashboard" display layout in My Items the first
// time Open MCT loads in a browser. After that it's an ordinary layout stored in
// the browser's local storage: edit it, duplicate it or delete it.

(function () {
  const CREATED_FLAG = 'ksp-openmct:flight-dashboard-created';
  const ksp = (key) => ({ namespace: 'ksp', key });

  // Readouts down the left edge, top to bottom (grid units are 10px).
  const READOUTS = [
    'vessel.name',
    'vessel.situation',
    'bridge.link',
    'time.met',
    'flight.altitude',
    'flight.surfaceSpeed',
    'flight.orbitalSpeed',
    'flight.verticalSpeed',
    'orbit.apoapsis',
    'orbit.periapsis',
    'orbit.timeToApoapsis',
    'control.throttle',
    'control.stage',
    'flight.gForce',
    'flight.dynamicPressure',
    'resources.liquidFuel',
    'resources.electricCharge'
  ];
  const READOUT_WIDTH = 26;
  const READOUT_HEIGHT = 3;

  const PLOTS = [
    {
      name: 'Altitude & Apoapsis',
      type: 'telemetry.plot.overlay',
      points: ['flight.altitude', 'orbit.apoapsis'],
      x: 27, y: 0, width: 73, height: 30
    },
    {
      name: 'Ascent Loads',
      type: 'telemetry.plot.stacked',
      points: ['flight.dynamicPressure', 'flight.gForce', 'control.throttle'],
      x: 27, y: 31, width: 36, height: 48
    },
    {
      name: 'Orbit & Fuel',
      type: 'telemetry.plot.stacked',
      points: ['orbit.periapsis', 'flight.orbitalSpeed', 'resources.liquidFuel'],
      x: 64, y: 31, width: 36, height: 48
    }
  ];

  function FlightDashboardPlugin() {
    return function install(openmct) {
      openmct.on('start', () => {
        if (readFlag()) return;
        createDashboard(openmct)
          .then(writeFlag)
          .catch((error) => console.warn('Could not create the KSP Flight Dashboard', error));
      });
    };
  }

  async function createDashboard(openmct) {
    const myItems = await openmct.objects.get({ namespace: '', key: 'mine' });
    const layoutId = { namespace: '', key: crypto.randomUUID() };
    const layoutLocation = openmct.objects.makeKeyString(layoutId);

    const plotItems = [];
    for (const spec of PLOTS) {
      const plot = {
        identifier: { namespace: '', key: crypto.randomUUID() },
        name: spec.name,
        type: spec.type,
        location: layoutLocation,
        composition: spec.points.map(ksp),
        configuration:
          spec.type === 'telemetry.plot.stacked'
            ? { series: [], yAxis: {}, xAxis: {}, objectStyles: {} }
            : { series: [], objectStyles: {} }
      };
      await openmct.objects.save(plot);
      plotItems.push({
        type: 'subobject-view',
        id: crypto.randomUUID(),
        identifier: plot.identifier,
        x: spec.x,
        y: spec.y,
        width: spec.width,
        height: spec.height,
        hasFrame: true,
        fontSize: 'default',
        font: 'default'
      });
    }

    const readoutItems = READOUTS.map((key, index) => ({
      type: 'telemetry-view',
      id: crypto.randomUUID(),
      identifier: ksp(key),
      x: 0,
      y: index * READOUT_HEIGHT,
      width: READOUT_WIDTH,
      height: READOUT_HEIGHT,
      displayMode: 'all',
      value: 'value',
      stroke: '',
      fill: '',
      color: '',
      fontSize: 'default',
      font: 'default'
    }));

    const layout = {
      identifier: layoutId,
      name: 'KSP Flight Dashboard',
      type: 'layout',
      location: openmct.objects.makeKeyString(myItems.identifier),
      composition: [...READOUTS.map(ksp), ...plotItems.map((item) => item.identifier)],
      configuration: {
        items: [...readoutItems, ...plotItems],
        layoutGrid: [10, 10],
        objectStyles: {}
      }
    };
    await openmct.objects.save(layout);

    // Open MCT skips saving an object whose `modified` time isn't newer than its
    // `persisted` time. On a first visit My Items was persisted moments ago
    // (often in the same millisecond), so let the clock move past it first.
    while (myItems.persisted !== undefined && Date.now() <= myItems.persisted) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    openmct.composition.get(myItems).add(layout);
  }

  function readFlag() {
    try {
      return localStorage.getItem(CREATED_FLAG) !== null;
    } catch {
      return true; // no storage, nowhere to save a dashboard anyway
    }
  }

  function writeFlag() {
    try {
      localStorage.setItem(CREATED_FLAG, new Date().toISOString());
    } catch {
      // ignore
    }
  }

  window.FlightDashboardPlugin = FlightDashboardPlugin;
})();
