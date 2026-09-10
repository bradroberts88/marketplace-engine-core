#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
AutoPost Bluetooth setup - the REDUNDANT front door for fixing a Pi's WiFi.

WHY THIS EXISTS
    The WiFi rescue (src/wifi-recovery.js) turns the Pi's own radio into an "AutoPost-Setup" access point when
    the box cannot get online, and serves a captive portal on it. That works, but it inherits one structural
    weakness it can never engineer away: it needs the WiFi radio, and it needs the radio to be free. The single
    Pi radio cannot be an access point and a station at the same time, so the rescue has to take the AP down to
    re-test the real network, it has to give the radio back when a correction is applied, and any activation
    that fails leaves a window with no rescue network in the air at all. Every one of those windows is a moment
    where a technician looks at their phone's WiFi list, sees nothing, and concludes the device is dead.

    Bluetooth has none of that coupling. The Pi's Bluetooth controller is a separate function of the combo chip
    with its own link layer, so this service is reachable while the WiFi radio is scanning, associating, failing
    to associate, hosting the rescue AP, or torn down mid-probe. It comes up at boot and stays up. If the WiFi
    rescue never appears - for any reason, including reasons nobody has diagnosed yet - this is still there.

WHAT IT DELIBERATELY DOES NOT DO
    It never touches nmcli. One radio, one owner: it writes a request file into the connector runtime directory
    and wifi-recovery.js applies it through the SAME applyAndVerify() the captive portal uses. That is what keeps
    the never-strand teardown order, the captive-portal outcome, the duplicate-profile cleanup and the AP
    re-raise on failure identical no matter which door the credentials came through. Two processes racing
    `nmcli connection up` against one radio is exactly the failure class this design refuses to create.

HOW A TECHNICIAN USES IT
    Any generic BLE app works - nRF Connect or LightBlue, both free, both on iOS and Android. That matters: iOS
    Safari has no Web Bluetooth, so a web page alone would have covered Android only. Connect to the device
    named the same as the rescue AP ("AutoPost-Setup-3C4D"), then write one UTF-8 string to the CREDENTIALS
    characteristic:

        <setup code>|<network name>|<password>

    Read STATUS for what the box is doing, NETWORKS for what it can see, RESULT for how the last attempt went,
    and LOG for the rolling diagnostic ring. ble-setup-page.html drives the same characteristics over Web
    Bluetooth for a one-tap version on Android/desktop Chrome.

IMPLEMENTATION NOTE
    Python + dbus, not Node. The rest of the connector is stdlib-only Node on purpose, but a BLE peripheral means
    speaking BlueZ's D-Bus GATT API, and the only stdlib-only Node route is hand-rolling the D-Bus wire protocol
    - several hundred lines of message marshalling that cannot be tested anywhere but on the hardware. This is
    the path BlueZ itself documents and ships examples for. Given the whole point of this service is to be the
    thing that still works when the clever thing did not, proven beats pure.

    Requires: python3-dbus, python3-gi, bluez (installed by deploy/pi/install.sh).
"""

import errno
import json
import os
import re
import sys
import time

import dbus
import dbus.exceptions
import dbus.mainloop.glib
import dbus.service

from gi.repository import GLib

# --------------------------------------------------------------------------------------------------------------
# Configuration. Every value is env-overridable so the service unit can retune a fleet without a code change.
# --------------------------------------------------------------------------------------------------------------
RUNTIME_DIR = os.environ.get('CONNECTOR_RUNTIME_DIR', '/var/lib/autopost/runtime')
CONFIG_PATH = os.environ.get('CONNECTOR_CONFIG', '/var/lib/autopost/config.json')
ADAPTER_NAME = os.environ.get('AUTOPOST_BLE_ADAPTER', 'hci0')
NAME_PREFIX = os.environ.get('WIFI_RECOVERY_AP_SSID_PREFIX', 'AutoPost-Setup')
# The fleet setup password. Identical to the rescue AP's WPA2 password on purpose: a technician who has been
# given one secret has been given both, and a per-device-only code means the operator has to track a code per
# card and read it out over the phone - an operational step that WILL be the thing that fails on site.
FLEET_CODE = os.environ.get('WIFI_RECOVERY_AP_PASSWORD', 'autopost212')
# Per-device code: the last 6 hex of the board serial. Not derivable from the advertised name (which carries only
# the last 4), so it is a genuinely separate secret for anyone who wants one.
PER_DEVICE_CODE_LEN = 6
# Advertise whenever the box is not online. A healthy claimed unit sitting on a dealership network has no reason
# to keep an unauthenticated-by-default provisioning surface in the air; a unit that cannot get online is exactly
# the one someone needs to reach. ALWAYS=1 pins it on for bench work.
ADVERTISE_ALWAYS = os.environ.get('AUTOPOST_BLE_ALWAYS', '0') == '1'
# ...but always advertise for a window after boot regardless, so a technician who power-cycles a box that IS
# online (to change which network it uses, say) still gets a way in.
BOOT_WINDOW_S = int(os.environ.get('AUTOPOST_BLE_BOOT_WINDOW_S', '900'))
# Anything older than this and the status file is treated as stale (wifi-recovery.js is dead or wedged), which
# counts as "not online" - the case where a way in matters most.
STATUS_STALE_S = int(os.environ.get('AUTOPOST_BLE_STATUS_STALE_S', '180'))
# A wrong code costs a growing delay. BLE is range-limited so this is not a serious brute-force surface, but a
# 6-hex code is 16.7M possibilities and there is no reason to let anyone walk it quickly.
AUTH_FAIL_LOCKOUT_S = int(os.environ.get('AUTOPOST_BLE_LOCKOUT_S', '30'))
AUTH_FAIL_BEFORE_LOCKOUT = int(os.environ.get('AUTOPOST_BLE_FAILS', '3'))
# How long a partial write may sit before it is treated as complete. BLE writes arrive in MTU-sized chunks with
# no framing of their own, so reassembly needs either a terminator or an idle timeout; this supports both.
WRITE_IDLE_MS = int(os.environ.get('AUTOPOST_BLE_WRITE_IDLE_MS', '400'))
POLL_MS = 2000

# --------------------------------------------------------------------------------------------------------------
# UUIDs. Fixed for the life of the product - a client that knows these numbers must keep working against every
# future firmware, so they are never to be regenerated.
# --------------------------------------------------------------------------------------------------------------
SVC_UUID = 'a5f10000-4e7a-4c2b-9d1f-6b0e2c7a9d31'
CHR_STATUS = 'a5f10001-4e7a-4c2b-9d1f-6b0e2c7a9d31'  # read + notify : JSON, what the box is doing
CHR_NETWORKS = 'a5f10002-4e7a-4c2b-9d1f-6b0e2c7a9d31'  # read          : JSON, the cached scan
CHR_CREDS = 'a5f10003-4e7a-4c2b-9d1f-6b0e2c7a9d31'  # write         : code|ssid|password  (or JSON)
CHR_RESULT = 'a5f10004-4e7a-4c2b-9d1f-6b0e2c7a9d31'  # read + notify : JSON, outcome of the last request
CHR_LOG = 'a5f10005-4e7a-4c2b-9d1f-6b0e2c7a9d31'  # read          : text, the diagnostic ring
CHR_COMMAND = 'a5f10006-4e7a-4c2b-9d1f-6b0e2c7a9d31'  # write         : code|scan / code|recheck

BLUEZ = 'org.bluez'
DBUS_OM_IFACE = 'org.freedesktop.DBus.ObjectManager'
DBUS_PROP_IFACE = 'org.freedesktop.DBus.Properties'
GATT_MANAGER_IFACE = 'org.bluez.GattManager1'
GATT_SERVICE_IFACE = 'org.bluez.GattService1'
GATT_CHRC_IFACE = 'org.bluez.GattCharacteristic1'
LE_ADV_MANAGER_IFACE = 'org.bluez.LEAdvertisingManager1'
LE_ADVERTISEMENT_IFACE = 'org.bluez.LEAdvertisement1'
ADAPTER_IFACE = 'org.bluez.Adapter1'

STARTED_AT = time.time()


def log(msg):
    sys.stdout.write('%s [ble-setup] %s\n' % (time.strftime('%Y-%m-%dT%H:%M:%S'), msg))
    sys.stdout.flush()


# --------------------------------------------------------------------------------------------------------------
# Board identity
# --------------------------------------------------------------------------------------------------------------
def board_serial():
    """The Pi's board serial, or '' if it cannot be read. Same sources wifi-recovery.js uses, so the last-4 tail
    in the advertised name is guaranteed to match the rescue AP's SSID - a technician must never be made to
    wonder whether the Bluetooth device and the WiFi network are the same box."""
    for path in ('/proc/cpuinfo', '/sys/firmware/devicetree/base/serial-number'):
        try:
            with open(path, 'r', errors='replace') as fh:
                text = fh.read()
        except OSError:
            continue
        m = re.search(r'Serial\s*:\s*([0-9a-fA-F]+)', text) or re.search(r'([0-9a-fA-F]{6,})', text)
        if m:
            return m.group(1)
    return ''


SERIAL = board_serial()
DEVICE_TAIL = (re.sub(r'[^0-9a-fA-F]', '', SERIAL)[-4:] or 'XXXX').upper()
DEVICE_NAME = '%s-%s' % (NAME_PREFIX, DEVICE_TAIL)
PER_DEVICE_CODE = (re.sub(r'[^0-9a-fA-F]', '', SERIAL)[-PER_DEVICE_CODE_LEN:] or '').upper()


# --------------------------------------------------------------------------------------------------------------
# The bridge to wifi-recovery.js. Files only - see the module docstring for why this never calls nmcli.
# --------------------------------------------------------------------------------------------------------------
def _read_json(name):
    try:
        with open(os.path.join(RUNTIME_DIR, name), 'r', errors='replace') as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


def read_status():
    return _read_json('wifi-status.json') or _read_json('wifi-recovery.json') or {}


def read_networks():
    scan = _read_json('wifi-scan.json') or {}
    nets = scan.get('networks') or []
    # Trimmed to what a chooser actually needs. A BLE read is paid for in round trips at ~20-500 bytes each, and
    # the security string and channel number are noise to the person picking their own network off a list.
    return [{'ssid': n.get('ssid', ''), 'signal': n.get('signal', 0)} for n in nets if n.get('ssid')]


def read_result():
    return _read_json('wifi-result.json') or {}


def read_log(max_bytes=8192):
    """The tail of the diagnostic ring. Tail, not head: when something is wrong the newest lines are the ones
    that say what, and a BLE long read of the whole file would be dozens of round trips of ancient history."""
    try:
        with open(os.path.join(RUNTIME_DIR, 'recovery-log.txt'), 'rb') as fh:
            try:
                fh.seek(0, os.SEEK_END)
                size = fh.tell()
                fh.seek(max(0, size - max_bytes), os.SEEK_SET)
            except OSError:
                pass
            data = fh.read()
        text = data.decode('utf-8', errors='replace')
        if len(data) >= max_bytes:
            text = text.split('\n', 1)[-1]  # drop the half line the seek landed in the middle of
        return text
    except OSError:
        return '(no diagnostic log yet)\n'


def write_request(payload):
    """Hand a request to wifi-recovery.js. Written to a temp file and renamed, because the reader is a separate
    process polling on its own clock with no lock between us: rename is atomic on ext4, so it can only ever see
    the whole file or the previous one, never half of this one."""
    payload = dict(payload)
    payload.setdefault('source', 'bluetooth')
    payload.setdefault('at', int(time.time() * 1000))
    payload['id'] = '%d-%s' % (int(time.time() * 1000), os.urandom(4).hex())
    path = os.path.join(RUNTIME_DIR, 'wifi-request.json')
    tmp = path + '.tmp'
    try:
        os.makedirs(RUNTIME_DIR, exist_ok=True)
        with open(tmp, 'w') as fh:
            json.dump(payload, fh)
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
        return payload['id']
    except OSError as exc:
        log('could not write request: %s' % exc)
        try:
            os.unlink(tmp)
        except OSError:
            pass
        return None


# --------------------------------------------------------------------------------------------------------------
# Payload parsing
# --------------------------------------------------------------------------------------------------------------
class AuthError(Exception):
    pass


class ParseError(Exception):
    pass


def check_code(code):
    """Either secret opens the door. The fleet code is the one a technician has already been given (it is the
    rescue AP's WiFi password, printed on the same card), and the per-device code exists for anyone who wants a
    secret that is not shared across the fleet. Compared case-insensitively: this gets read aloud over a phone."""
    code = (code or '').strip()
    if not code:
        return False
    if code == FLEET_CODE:
        return True
    return bool(PER_DEVICE_CODE) and code.upper() == PER_DEVICE_CODE


def parse_credentials(text):
    """Accept both shapes on the same characteristic.

    JSON     - what ble-setup-page.html sends. Exact: any byte can appear in an SSID or password.
    PIPE     - what a human types into nRF Connect or LightBlue:  code|ssid|password
               Split into at most 3 parts so a password containing '|' still survives; an SSID containing one
               cannot, which is why the JSON form and the WiFi portal both exist.

    Returns (payload_dict, action)."""
    text = (text or '').strip()
    if not text:
        raise ParseError('Empty request.')

    if text.startswith('{'):
        try:
            obj = json.loads(text)
        except ValueError:
            raise ParseError('That did not parse as JSON.')
        if not check_code(obj.get('code')):
            raise AuthError('Wrong setup code.')
        action = str(obj.get('action') or 'connect')
        ssid = str(obj.get('ssid') or '').strip()
        if action == 'connect' and not ssid:
            raise ParseError('No network name given.')
        return ({
            'action': action,
            'ssid': ssid,
            'password': str(obj.get('password') or ''),
            'identity': str(obj.get('identity') or '').strip(),
            'hidden': bool(obj.get('hidden')),
        }, action)

    parts = text.split('|', 2)
    if not check_code(parts[0]):
        raise AuthError('Wrong setup code.')
    if len(parts) == 2 and parts[1].strip().lower() in ('scan', 'recheck'):
        return ({'action': parts[1].strip().lower()}, parts[1].strip().lower())
    if len(parts) < 2 or not parts[1].strip():
        raise ParseError('Send: code|network name|password')
    return ({
        'action': 'connect',
        'ssid': parts[1].strip(),
        'password': parts[2] if len(parts) > 2 else '',
        'identity': '',
        'hidden': False,
    }, 'connect')


# --------------------------------------------------------------------------------------------------------------
# BlueZ GATT scaffolding (the shape BlueZ's own examples use)
# --------------------------------------------------------------------------------------------------------------
class InvalidArgsException(dbus.exceptions.DBusException):
    _dbus_error_name = 'org.freedesktop.DBus.Error.InvalidArgs'


class FailedException(dbus.exceptions.DBusException):
    _dbus_error_name = 'org.bluez.Error.Failed'


class NotPermittedException(dbus.exceptions.DBusException):
    _dbus_error_name = 'org.bluez.Error.NotPermitted'


class Application(dbus.service.Object):
    """The GATT application root. BlueZ discovers the whole tree by calling GetManagedObjects on this path."""

    def __init__(self, bus, path='/com/autopost/ble'):
        self.path = path
        self.services = []
        dbus.service.Object.__init__(self, bus, self.path)

    def get_path(self):
        return dbus.ObjectPath(self.path)

    def add_service(self, service):
        self.services.append(service)

    @dbus.service.method(DBUS_OM_IFACE, out_signature='a{oa{sa{sv}}}')
    def GetManagedObjects(self):
        response = {}
        for service in self.services:
            response[service.get_path()] = service.get_properties()
            for chrc in service.characteristics:
                response[chrc.get_path()] = chrc.get_properties()
        return response


class Service(dbus.service.Object):
    def __init__(self, bus, index, uuid, primary=True):
        self.path = '/com/autopost/ble/service%d' % index
        self.bus = bus
        self.uuid = uuid
        self.primary = primary
        self.characteristics = []
        dbus.service.Object.__init__(self, bus, self.path)

    def get_path(self):
        return dbus.ObjectPath(self.path)

    def add_characteristic(self, chrc):
        self.characteristics.append(chrc)

    def get_properties(self):
        return {
            GATT_SERVICE_IFACE: {
                'UUID': self.uuid,
                'Primary': self.primary,
                'Characteristics': dbus.Array([c.get_path() for c in self.characteristics], signature='o'),
            }
        }

    @dbus.service.method(DBUS_PROP_IFACE, in_signature='s', out_signature='a{sv}')
    def GetAll(self, interface):
        if interface != GATT_SERVICE_IFACE:
            raise InvalidArgsException()
        return self.get_properties()[GATT_SERVICE_IFACE]


class Characteristic(dbus.service.Object):
    """One characteristic.

    Long values are handled by honouring the `offset` BlueZ passes into ReadValue: the client reads the first
    MTU-worth, then re-reads from where it stopped. The value is SNAPSHOTTED at offset 0 and served from that
    snapshot for the rest of the sequence - re-rendering live state on every chunk would splice two different
    JSON documents together and hand the client something that does not parse."""

    def __init__(self, bus, index, uuid, flags, service):
        self.path = '%s/char%d' % (service.path, index)
        self.bus = bus
        self.uuid = uuid
        self.flags = flags
        self.service = service
        self.notifying = False
        self._snapshot = b''
        self._wbuf = bytearray()
        self._wtimer = None
        dbus.service.Object.__init__(self, bus, self.path)
        service.add_characteristic(self)

    def get_path(self):
        return dbus.ObjectPath(self.path)

    def get_properties(self):
        return {
            GATT_CHRC_IFACE: {
                'Service': self.service.get_path(),
                'UUID': self.uuid,
                'Flags': self.flags,
            }
        }

    @dbus.service.method(DBUS_PROP_IFACE, in_signature='s', out_signature='a{sv}')
    def GetAll(self, interface):
        if interface != GATT_CHRC_IFACE:
            raise InvalidArgsException()
        return self.get_properties()[GATT_CHRC_IFACE]

    @dbus.service.signal(DBUS_PROP_IFACE, signature='sa{sv}as')
    def PropertiesChanged(self, interface, changed, invalidated):
        pass

    # -- subclass hooks ------------------------------------------------------------------------------------
    def render(self):
        """Current value as bytes. Called once per read sequence (at offset 0)."""
        return b''

    def handle_write(self, text):
        """A complete reassembled write. Subclasses that accept writes override this."""
        raise NotPermittedException()

    # -- GATT methods --------------------------------------------------------------------------------------
    @dbus.service.method(GATT_CHRC_IFACE, in_signature='a{sv}', out_signature='ay')
    def ReadValue(self, options):
        offset = int(options.get('offset', 0))
        if offset == 0:
            self._snapshot = self.render()
        return dbus.Array([dbus.Byte(b) for b in self._snapshot[offset:]], signature='y')

    @dbus.service.method(GATT_CHRC_IFACE, in_signature='aya{sv}')
    def WriteValue(self, value, options):
        offset = int(options.get('offset', 0))
        chunk = bytes(bytearray(value))
        if offset == 0 and not self._wtimer:
            self._wbuf = bytearray()
        # A prepared (long) write tells us where it belongs; a stream of write-without-response chunks all claim
        # offset 0, so those just append in arrival order.
        if offset and offset <= len(self._wbuf):
            self._wbuf[offset:] = chunk
        else:
            self._wbuf.extend(chunk)
        if self._wtimer:
            GLib.source_remove(self._wtimer)
            self._wtimer = None
        # A newline ends the message immediately; otherwise a short idle does. Both are needed: the web page
        # sends one framed write, and a person typing into a BLE app sends whatever their app decides to chunk.
        if b'\n' in self._wbuf or b'\r' in self._wbuf:
            self._flush_write()
        else:
            self._wtimer = GLib.timeout_add(WRITE_IDLE_MS, self._flush_write)

    def _flush_write(self):
        self._wtimer = None
        raw = bytes(self._wbuf)
        self._wbuf = bytearray()
        if not raw.strip():
            return False
        try:
            self.handle_write(raw.decode('utf-8', errors='replace'))
        except Exception as exc:  # a bad write must never take the service down - it is the last way in
            log('write handler error: %s' % exc)
        return False  # one-shot timer

    @dbus.service.method(GATT_CHRC_IFACE)
    def StartNotify(self):
        self.notifying = True

    @dbus.service.method(GATT_CHRC_IFACE)
    def StopNotify(self):
        self.notifying = False

    def notify(self, payload):
        """Push a value change. Truncated to 20 bytes on purpose: a notification is capped at the connection MTU
        and there is no way to know it from here, so this is a nudge that says "something changed, read me",
        not a delivery mechanism. Clients re-read the characteristic properly."""
        if not self.notifying:
            return
        head = payload[:20]
        self.PropertiesChanged(GATT_CHRC_IFACE, {'Value': dbus.Array([dbus.Byte(b) for b in head], signature='y')}, [])


class Advertisement(dbus.service.Object):
    def __init__(self, bus, index, local_name, service_uuids):
        self.path = '/com/autopost/ble/adv%d' % index
        self.bus = bus
        self.local_name = local_name
        self.service_uuids = service_uuids
        dbus.service.Object.__init__(self, bus, self.path)

    def get_path(self):
        return dbus.ObjectPath(self.path)

    def get_properties(self):
        return {
            LE_ADVERTISEMENT_IFACE: {
                'Type': 'peripheral',
                'ServiceUUIDs': dbus.Array(self.service_uuids, signature='s'),
                'LocalName': dbus.String(self.local_name),
                'Includes': dbus.Array(['tx-power'], signature='s'),
                'Discoverable': dbus.Boolean(True),
            }
        }

    @dbus.service.method(DBUS_PROP_IFACE, in_signature='s', out_signature='a{sv}')
    def GetAll(self, interface):
        if interface != LE_ADVERTISEMENT_IFACE:
            raise InvalidArgsException()
        return self.get_properties()[LE_ADVERTISEMENT_IFACE]

    @dbus.service.method(LE_ADVERTISEMENT_IFACE, in_signature='', out_signature='')
    def Release(self):
        log('advertisement released by BlueZ')


# --------------------------------------------------------------------------------------------------------------
# The AutoPost characteristics
# --------------------------------------------------------------------------------------------------------------
class StatusChrc(Characteristic):
    def __init__(self, bus, index, service):
        Characteristic.__init__(self, bus, index, CHR_STATUS, ['read', 'notify'], service)

    def render(self):
        st = read_status()
        phase = st.get('phase', 'unknown')
        conn = st.get('connectivity', 'unknown')
        # A flat, small, self-explaining document. Whoever is reading this is doing it through a raw BLE app on a
        # phone in a service bay, so field names are the message.
        out = {
            'device': DEVICE_NAME,
            'online': conn == 'full',
            'connectivity': conn,          # full | portal | limited | none | unknown
            'phase': phase,                # boot | monitor | ap | connecting | captive
            'ssid': st.get('ssid', ''),
            'apSsid': st.get('apSsid') or '',
            'mac': st.get('mac', ''),
            'lastError': st.get('lastError', ''),
            'apFailures': st.get('apFailures', 0),
            'neverOnline': st.get('neverOnline', None),
            'statusAgeS': int(max(0, time.time() - (st.get('at', 0) / 1000.0))) if st.get('at') else None,
        }
        return json.dumps(out, separators=(',', ':')).encode('utf-8')


class NetworksChrc(Characteristic):
    def __init__(self, bus, index, service):
        Characteristic.__init__(self, bus, index, CHR_NETWORKS, ['read'], service)

    def render(self):
        nets = read_networks()
        return json.dumps({'networks': nets}, separators=(',', ':')).encode('utf-8')


class ResultChrc(Characteristic):
    def __init__(self, bus, index, service):
        Characteristic.__init__(self, bus, index, CHR_RESULT, ['read', 'notify'], service)
        self.local = None  # set directly when we reject a request before it ever reaches wifi-recovery.js

    def render(self):
        if self.local is not None:
            return json.dumps(self.local, separators=(',', ':')).encode('utf-8')
        res = read_result()
        return json.dumps({
            'ok': res.get('ok'),
            'ssid': res.get('ssid', ''),
            'captive': bool(res.get('captive')),
            'signInUrl': res.get('signInUrl', ''),
            'error': res.get('error', ''),
            'message': res.get('message', ''),
        }, separators=(',', ':')).encode('utf-8')

    def set_local(self, obj):
        self.local = obj
        self.notify(json.dumps(obj, separators=(',', ':')).encode('utf-8'))


class LogChrc(Characteristic):
    def __init__(self, bus, index, service):
        Characteristic.__init__(self, bus, index, CHR_LOG, ['read'], service)

    def render(self):
        return read_log().encode('utf-8')


class WriteChrc(Characteristic):
    """Shared write handling for CREDENTIALS and COMMAND: rate-limited auth, then hand off to wifi-recovery.js."""

    def __init__(self, bus, index, uuid, service, result_chrc, only_actions=None):
        Characteristic.__init__(self, bus, index, uuid, ['write', 'write-without-response'], service)
        self.result = result_chrc
        self.only_actions = only_actions
        self.fails = 0
        self.locked_until = 0.0

    def handle_write(self, text):
        now = time.time()
        if now < self.locked_until:
            self.result.set_local({'ok': False, 'error': 'Too many wrong codes. Wait %ds.' % int(self.locked_until - now)})
            return
        try:
            payload, action = parse_credentials(text)
        except AuthError as exc:
            self.fails += 1
            if self.fails >= AUTH_FAIL_BEFORE_LOCKOUT:
                self.locked_until = now + AUTH_FAIL_LOCKOUT_S
                self.fails = 0
            log('rejected a write: %s' % exc)
            self.result.set_local({'ok': False, 'error': str(exc)})
            return
        except ParseError as exc:
            self.result.set_local({'ok': False, 'error': str(exc)})
            return
        self.fails = 0
        if self.only_actions and action not in self.only_actions:
            self.result.set_local({'ok': False, 'error': 'Not accepted on this characteristic.'})
            return
        req_id = write_request(payload)
        if not req_id:
            self.result.set_local({'ok': False, 'error': 'Could not hand the request to the WiFi service.'})
            return
        log('accepted %s request over Bluetooth (%s)' % (action, payload.get('ssid') or '-'))
        # Clear the local override so subsequent reads show what wifi-recovery.js actually reports, not our
        # optimistic acknowledgement of having accepted the request.
        self.result.local = None
        self.result.notify(b'{"ok":null,"message":"accepted"}')


# --------------------------------------------------------------------------------------------------------------
# Service wiring + the advertising policy
# --------------------------------------------------------------------------------------------------------------
class SetupService(Service):
    def __init__(self, bus, index):
        Service.__init__(self, bus, index, SVC_UUID, True)
        self.status = StatusChrc(bus, 0, self)
        self.networks = NetworksChrc(bus, 1, self)
        self.result = ResultChrc(bus, 3, self)
        self.creds = WriteChrc(bus, 2, CHR_CREDS, self, self.result, only_actions=('connect',))
        self.log = LogChrc(bus, 4, self)
        self.command = WriteChrc(bus, 5, CHR_COMMAND, self, self.result, only_actions=('scan', 'recheck'))


class Peripheral(object):
    def __init__(self):
        self.bus = dbus.SystemBus()
        self.adapter_path = '/org/bluez/%s' % ADAPTER_NAME
        self.app = None
        self.adv = None
        self.advertising = False
        self.registered = False
        self.last_status_blob = None
        self.last_result_blob = None

    # -- adapter -------------------------------------------------------------------------------------------
    def _adapter_props(self):
        return dbus.Interface(self.bus.get_object(BLUEZ, self.adapter_path), DBUS_PROP_IFACE)

    def adapter_ready(self):
        try:
            props = self._adapter_props()
            if not bool(props.Get(ADAPTER_IFACE, 'Powered')):
                props.Set(ADAPTER_IFACE, 'Powered', dbus.Boolean(True))
            # Alias is what shows up in a phone's Bluetooth list for a CLASSIC scan and in some BLE apps; the LE
            # advertisement carries LocalName separately. Setting both means the device is called the same thing
            # wherever the technician happens to be looking.
            if str(props.Get(ADAPTER_IFACE, 'Alias')) != DEVICE_NAME:
                props.Set(ADAPTER_IFACE, 'Alias', dbus.String(DEVICE_NAME))
            return True
        except dbus.exceptions.DBusException as exc:
            log('adapter %s not ready: %s' % (ADAPTER_NAME, exc.get_dbus_name()))
            return False

    # -- GATT ----------------------------------------------------------------------------------------------
    def register_app(self):
        if self.registered:
            return True
        self.app = Application(self.bus)
        self.svc = SetupService(self.bus, 0)
        self.app.add_service(self.svc)
        try:
            mgr = dbus.Interface(self.bus.get_object(BLUEZ, self.adapter_path), GATT_MANAGER_IFACE)
            mgr.RegisterApplication(self.app.get_path(), {},
                                    reply_handler=self._app_ok, error_handler=self._app_err)
            return True
        except dbus.exceptions.DBusException as exc:
            log('RegisterApplication failed: %s' % exc)
            return False

    def _app_ok(self):
        self.registered = True
        log('GATT application registered as "%s" (service %s)' % (DEVICE_NAME, SVC_UUID))

    def _app_err(self, error):
        self.registered = False
        log('GATT registration error: %s' % error)

    # -- advertising ---------------------------------------------------------------------------------------
    def should_advertise(self):
        """Advertise when the box needs rescuing, plus a window after every boot.

        A claimed unit humming along on the dealership's network has no reason to keep a provisioning surface in
        the air. A unit that cannot get online is precisely the one someone has to reach - and so is one whose
        status file has gone stale, because that means the WiFi rescue itself is dead or wedged and this is the
        only door left."""
        if ADVERTISE_ALWAYS:
            return True
        if time.time() - STARTED_AT < BOOT_WINDOW_S:
            return True
        st = read_status()
        at = st.get('at')
        if not at:
            return True  # no status at all: wifi-recovery has not written one, so assume the worst
        if time.time() - (at / 1000.0) > STATUS_STALE_S:
            return True  # stale: nobody is updating it
        return st.get('connectivity') != 'full'

    def set_advertising(self, on):
        if on == self.advertising:
            return
        try:
            mgr = dbus.Interface(self.bus.get_object(BLUEZ, self.adapter_path), LE_ADV_MANAGER_IFACE)
            if on:
                self.adv = Advertisement(self.bus, 0, DEVICE_NAME, [SVC_UUID])
                mgr.RegisterAdvertisement(self.adv.get_path(), {},
                                          reply_handler=lambda: log('advertising as "%s"' % DEVICE_NAME),
                                          error_handler=lambda e: log('RegisterAdvertisement failed: %s' % e))
            else:
                mgr.UnregisterAdvertisement(self.adv.get_path())
                try:
                    self.adv.remove_from_connection()
                except Exception:
                    pass
                self.adv = None
                log('stopped advertising (box is online)')
            self.advertising = on
        except dbus.exceptions.DBusException as exc:
            log('advertising change failed: %s' % exc)

    # -- poll ----------------------------------------------------------------------------------------------
    def poll(self):
        if not self.registered:
            if self.adapter_ready():
                self.register_app()
            return True
        self.set_advertising(self.should_advertise())
        # Notify only on CHANGE. A phone sitting on the status characteristic during a 2-minute correction should
        # get a handful of nudges at the moments something actually happened, not one every two seconds.
        blob = self.svc.status.render()
        if blob != self.last_status_blob:
            self.last_status_blob = blob
            self.svc.status.notify(blob)
        rblob = self.svc.result.render()
        if rblob != self.last_result_blob:
            self.last_result_blob = rblob
            self.svc.result.notify(rblob)
        return True

    def run(self):
        log('starting: device "%s", serial tail %s, runtime %s' % (DEVICE_NAME, DEVICE_TAIL, RUNTIME_DIR))
        log('setup code: fleet password, or the per-device code (last %d of the board serial)' % PER_DEVICE_CODE_LEN)
        GLib.timeout_add(POLL_MS, self.poll)
        self.poll()
        GLib.MainLoop().run()


def main():
    dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)
    try:
        os.makedirs(RUNTIME_DIR, exist_ok=True)
    except OSError as exc:
        if exc.errno != errno.EEXIST:
            log('runtime dir %s is not writable: %s' % (RUNTIME_DIR, exc))
    Peripheral().run()


if __name__ == '__main__':
    main()
