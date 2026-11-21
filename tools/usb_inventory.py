"""Passive host metadata only. Never opens USB devices or mounted volumes."""
import argparse
import json
import platform
import plistlib
from pathlib import Path
import re
import subprocess

# Interface classes worth naming; anything else is reported by number only.
INTERFACE_CLASSES = {
    (1, 1): "audio-control",
    (1, 2): "audio-streaming",
    (1, 3): "midi-streaming",
    (3, None): "hid",
    (8, None): "mass-storage",
    (9, None): "hub",
    (17, None): "usb-c-billboard",
    (2, None): "communications",
    (10, None): "cdc-data",
    (254, None): "application-specific",
    (255, None): "vendor-specific",
}

def interface_kind(cls, subclass):
    return INTERFACE_CLASSES.get((cls, subclass)) or INTERFACE_CLASSES.get((cls, None)) or f"class-{cls}"

def as_int(value):
    try:
        return int(value)
    except (TypeError, ValueError):
        return None

def summarize_macos(tree):
    devices = []
    def visit(node):
        if isinstance(node, list):
            for item in node:
                visit(item)
        elif isinstance(node, dict):
            if "idVendor" in node and "idProduct" in node:
                devices.append({
                    "product": str(node.get("USB Product Name", "Unknown")),
                    "manufacturer": str(node.get("USB Vendor Name", "Unknown")),
                    "vendorId": f'{int(node["idVendor"]):04x}',
                    "productId": f'{int(node["idProduct"]):04x}',
                })
            visit(node.get("IORegistryEntryChildren", []))
    visit(tree)
    return devices

def _stream_format(fmt):
    # Allow-listed numeric fields only.
    if not isinstance(fmt, dict):
        return None
    return {
        "channels": as_int(fmt.get("IOAudioStreamNumChannels")),
        "bitDepth": as_int(fmt.get("IOAudioStreamBitDepth")),
        "bitWidth": as_int(fmt.get("IOAudioStreamBitWidth")),
    }

def _audio_from_subtree(node):
    """Engines and streams the OS driver already published under one interface."""
    engines = []
    def visit(n, engine):
        if not isinstance(n, dict):
            return
        cls = str(n.get("IOObjectClass", ""))
        if "IOAudioEngine" in n.get("IOProviderClass", "") or "AudioEngine" in cls:
            rate = n.get("IOAudioEngineSampleRate")
            engine = {
                "sampleRate": as_int(rate.get("IOAudioSampleRateWholeNumber")) if isinstance(rate, dict) else None,
                "streams": [],
            }
            engines.append(engine)
        elif "AudioStream" in cls and engine is not None:
            direction = as_int(n.get("IOAudioStreamDirection"))
            engine["streams"].append({
                "direction": {0: "output", 1: "input"}.get(direction, "unknown"),
                "format": _stream_format(n.get("IOAudioStreamFormat")),
            })
        for child in n.get("IORegistryEntryChildren", []):
            visit(child, engine)
    visit(node, None)
    return engines

def summarize_macos_interfaces(tree):
    """USB interface descriptors as cached by macOS; never serials, paths or GUIDs."""
    interfaces = []
    def visit(node):
        if isinstance(node, list):
            for item in node:
                visit(item)
            return
        if not isinstance(node, dict):
            return
        if "bInterfaceClass" in node and "idVendor" in node and "idProduct" in node:
            cls, subclass = as_int(node.get("bInterfaceClass")), as_int(node.get("bInterfaceSubClass"))
            entry = {
                "vendorId": f'{int(node["idVendor"]):04x}',
                "productId": f'{int(node["idProduct"]):04x}',
                "interface": as_int(node.get("bInterfaceNumber")),
                "alternate": as_int(node.get("bAlternateSetting")),
                "class": cls,
                "subclass": subclass,
                "protocol": as_int(node.get("bInterfaceProtocol")),
                "kind": interface_kind(cls, subclass),
                "endpoints": as_int(node.get("bNumEndpoints")),
            }
            audio = _audio_from_subtree(node)
            if audio:
                entry["audioEngines"] = audio
            interfaces.append(entry)
            return
        visit(node.get("IORegistryEntryChildren", []))
    visit(tree)
    return sorted(interfaces, key=lambda i: (i["vendorId"], i["productId"], i["interface"] or 0, i["alternate"] or 0))

def summarize_linux_interfaces(root=Path("/sys/bus/usb/devices"), asound=Path("/proc/asound")):
    """Interface attributes from sysfs plus ALSA's text stream summary; no device is opened."""
    interfaces = []
    for item in sorted(root.glob("*:*")):
        def read(directory, name):
            path = directory / name
            return path.read_text().strip() if path.is_file() else None
        def hexint(name):
            value = read(item, name)
            try:
                return int(value, 16) if value is not None else None
            except ValueError:
                return None
        parent = root / item.name.split(":")[0]
        vendor, product = read(parent, "idVendor"), read(parent, "idProduct")
        if not vendor or not product:
            continue
        cls, subclass = hexint("bInterfaceClass"), hexint("bInterfaceSubClass")
        interfaces.append({
            "vendorId": vendor, "productId": product,
            "interface": hexint("bInterfaceNumber"),
            "alternate": as_int(read(item, "bAlternateSetting")),
            "class": cls, "subclass": subclass,
            "protocol": hexint("bInterfaceProtocol"),
            "kind": interface_kind(cls, subclass),
            "endpoints": hexint("bNumEndpoints"),
        })
    streams = []
    for usbid in sorted(asound.glob("card*/usbid")):
        ident = usbid.read_text().strip()
        for stream in sorted(usbid.parent.glob("stream*")):
            text = stream.read_text()
            for direction in ("Playback", "Capture"):
                section = text.split(direction + ":", 1)
                if len(section) < 2:
                    continue
                body = section[1].split("\n\n", 1)[0]
                channels = re.findall(r"Channels: (\d+)", body)
                rates = re.findall(r"Rates: ([0-9, ]+)", body)
                streams.append({
                    "usbId": ident.lower(), "direction": direction.lower(),
                    "channels": sorted({int(c) for c in channels}),
                    "rates": sorted({int(r) for line in rates for r in line.replace(" ", "").split(",") if r}),
                })
    return interfaces, streams

def collect():
    if platform.system() == "Darwin":
        # ioreg reads the existing OS registry; no libusb/HID/MIDI endpoint is opened.
        # "-l" is required: without it the archive omits every property, so no device
        # (not even one that is connected) would be reported.
        result = subprocess.run(["/usr/sbin/ioreg", "-p", "IOUSB", "-a", "-l"],
                                check=True, capture_output=True, timeout=15)
        return summarize_macos(plistlib.loads(result.stdout))
    if platform.system() == "Linux":
        devices = []
        for item in sorted(Path("/sys/bus/usb/devices").glob("*")):
            if not (item / "idVendor").is_file():
                continue
            def read(name):
                path = item / name
                return path.read_text().strip() if path.is_file() else "Unknown"
            devices.append({"product": read("product"), "manufacturer": read("manufacturer"),
                            "vendorId": read("idVendor"), "productId": read("idProduct")})
        return devices
    raise RuntimeError("Passive inventory currently supports macOS and Linux")

def collect_interfaces():
    if platform.system() == "Darwin":
        # Same registry, IOService plane: interface nubs and the audio driver objects
        # macOS already attached. No user client, device interface or MIDI client is created.
        result = subprocess.run(["/usr/sbin/ioreg", "-p", "IOService", "-c", "IOUSBHostInterface", "-r", "-a"],
                                check=True, capture_output=True, timeout=15)
        data = result.stdout.strip()
        return {"interfaces": summarize_macos_interfaces(plistlib.loads(data)) if data else [], "alsaStreams": []}
    if platform.system() == "Linux":
        interfaces, streams = summarize_linux_interfaces()
        return {"interfaces": interfaces, "alsaStreams": streams}
    raise RuntimeError("Passive inventory currently supports macOS and Linux")

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.parse_args()  # No device paths, output destinations, or active-operation flags.
    detail = collect_interfaces()
    print(json.dumps({"mode": "passive-host-inventory", "deviceHandlesOpened": 0,
                      "serialNumbersIncluded": False, "devices": collect(),
                      "interfaces": detail["interfaces"], "alsaStreams": detail["alsaStreams"],
                      "note": "Interface data is what the host OS already cached; nothing was sent to any device."}, indent=2))

if __name__ == "__main__":
    main()
