#!/usr/bin/env python3
"""Stream KSP telemetry from the kRPC mod into the Open MCT bridge.

    pip install -r krpc/requirements.txt
    npm run krpc                  # terminal 1: bridge, waiting on POST /ingest
    python krpc/bridge.py         # terminal 2: with KSP running and the kRPC server started

The active vessel is tracked automatically: switching vessels, changing SOI, or
leaving/entering the flight scene rebuilds the kRPC streams.
"""

import argparse
import json
import math
import time
import urllib.error
import urllib.request

import krpc
from krpc.error import ConnectionError as KrpcConnectionError, RPCError, StreamError

# kRPC's ConnectionError is a RuntimeError, not the builtin ConnectionError.
CONNECTION_ERRORS = (ConnectionError, OSError, KrpcConnectionError)


def stream_specs(conn, vessel):
    """Dictionary id -> (stream, transform) for the given vessel."""
    orbit = vessel.orbit
    surface = vessel.flight(orbit.body.reference_frame)  # surface-relative speeds and attitude

    def attr(obj, name, transform=None):
        return conn.add_stream(getattr, obj, name), transform

    def resource(name):
        return conn.add_stream(vessel.resources.amount, name), None

    return {
        'vessel.name': attr(vessel, 'name'),
        'vessel.situation': attr(vessel, 'situation', lambda s: getattr(s, 'name', str(s)).upper()),
        'control.stage': attr(vessel.control, 'current_stage'),
        'control.throttle': attr(vessel.control, 'throttle', lambda t: t * 100),
        'flight.altitude': attr(surface, 'mean_altitude'),
        'flight.surfaceSpeed': attr(surface, 'speed'),
        'flight.verticalSpeed': attr(surface, 'vertical_speed'),
        'flight.orbitalSpeed': attr(orbit, 'speed'),
        'flight.gForce': attr(surface, 'g_force'),
        'flight.dynamicPressure': attr(surface, 'dynamic_pressure', lambda pa: pa / 1000),
        'flight.latitude': attr(surface, 'latitude'),
        'flight.longitude': attr(surface, 'longitude'),
        'attitude.pitch': attr(surface, 'pitch'),
        'attitude.heading': attr(surface, 'heading'),
        'attitude.roll': attr(surface, 'roll'),
        'orbit.apoapsis': attr(orbit, 'apoapsis_altitude'),
        'orbit.periapsis': attr(orbit, 'periapsis_altitude'),
        'orbit.timeToApoapsis': attr(orbit, 'time_to_apoapsis'),
        'orbit.timeToPeriapsis': attr(orbit, 'time_to_periapsis'),
        'orbit.inclination': attr(orbit, 'inclination', math.degrees),
        'orbit.eccentricity': attr(orbit, 'eccentricity'),
        'orbit.period': attr(orbit, 'period'),
        'resources.liquidFuel': resource('LiquidFuel'),
        'resources.oxidizer': resource('Oxidizer'),
        'resources.electricCharge': resource('ElectricCharge'),
        'time.ut': attr(conn.space_center, 'ut'),
        'time.met': attr(vessel, 'met'),
    }


def read(specs):
    values = {}
    for point_id, (stream, transform) in specs.items():
        value = stream()
        if transform:
            value = transform(value)
        # JSON has no NaN/Infinity (e.g. time to apoapsis on an escape trajectory).
        if isinstance(value, float) and not math.isfinite(value):
            continue
        values[point_id] = value
    return values


def remove(specs):
    for stream, _ in (specs or {}).values():
        try:
            stream.remove()
        except Exception:
            pass


class Bridge:
    def __init__(self, url):
        self.url = url
        self.last_warning = 0

    def post(self, values):
        body = json.dumps({'values': values, 'source': 'kRPC'}).encode()
        request = urllib.request.Request(self.url, data=body, headers={'Content-Type': 'application/json'})
        try:
            with urllib.request.urlopen(request, timeout=2) as response:
                result = json.loads(response.read())
                if result.get('rejected'):
                    self.warn(f"bridge rejected: {', '.join(result['rejected'])}")
        except (urllib.error.URLError, OSError) as error:
            self.warn(f'bridge not reachable at {self.url} ({error})')

    def warn(self, message):
        if time.monotonic() - self.last_warning > 5:
            self.last_warning = time.monotonic()
            print(message, flush=True)


def track(conn, bridge, rate):
    vessel = body = specs = None
    next_check = 0

    while True:
        now = time.monotonic()
        if now >= next_check:
            next_check = now + 1
            try:
                active = conn.space_center.active_vessel
                active_body = active.orbit.body.name
            except RPCError:  # not in the flight scene
                active = active_body = None

            if active != vessel or active_body != body:
                remove(specs)
                specs = None
                vessel, body = active, active_body
                if vessel is None:
                    print('No active vessel (not in the flight scene), waiting...', flush=True)
                else:
                    specs = stream_specs(conn, vessel)
                    print(f'Tracking {vessel.name} around {body}', flush=True)

        if specs:
            try:
                values = read(specs)
            except (RPCError, StreamError):  # vessel destroyed or scene changing; re-check next loop
                remove(specs)
                specs = vessel = None
                next_check = 0
            else:
                values['vessel.body'] = body
                bridge.post(values)

        time.sleep(1 / rate)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--krpc-host', default='127.0.0.1', help='machine running KSP (default: 127.0.0.1)')
    parser.add_argument('--rpc-port', type=int, default=50000)
    parser.add_argument('--stream-port', type=int, default=50001)
    parser.add_argument('--bridge-url', default='http://127.0.0.1:8090/ingest')
    parser.add_argument('--rate', type=float, default=10, help='samples per second (default: 10)')
    args = parser.parse_args()

    bridge = Bridge(args.bridge_url)
    while True:
        try:
            conn = krpc.connect(
                name='Open MCT bridge',
                address=args.krpc_host,
                rpc_port=args.rpc_port,
                stream_port=args.stream_port,
            )
        except CONNECTION_ERRORS as error:
            print(f'Could not connect to kRPC at {args.krpc_host}:{args.rpc_port} ({error}); retrying in 5s', flush=True)
            time.sleep(5)
            continue

        print(f'Connected to kRPC at {args.krpc_host}:{args.rpc_port}', flush=True)
        try:
            track(conn, bridge, args.rate)
        except CONNECTION_ERRORS as error:
            print(f'Lost kRPC connection ({error}); reconnecting in 5s', flush=True)
            time.sleep(5)
        finally:
            try:
                conn.close()
            except Exception:
                pass


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        pass
