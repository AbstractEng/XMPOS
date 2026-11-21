import json
import plistlib
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import usb_inventory

# Synthetic az01-style USB device as macOS would cache it. Not captured from hardware.
SERIAL = "PRIVATE-SERIAL-123"
def interface(number, cls, subclass, protocol=0, endpoints=0, alternate=0, children=None):
    return {"IOObjectClass": "IOUSBHostInterface", "idVendor": 0x09E8, "idProduct": 0x0000,
            "bInterfaceNumber": number, "bAlternateSetting": alternate, "bInterfaceClass": cls,
            "bInterfaceSubClass": subclass, "bInterfaceProtocol": protocol, "bNumEndpoints": endpoints,
            "USB Serial Number": SERIAL, "IORegistryEntryLocation": "14200000",
            "IORegistryEntryChildren": children or []}
ENGINE = {"IOObjectClass": "AppleUSBAudioEngine", "IOProviderClass": "IOUSBHostInterface",
          "IOAudioEngineGlobalUniqueID": f"AppleUSBAudioEngine:Synthetic:Device:{SERIAL}:1",
          "IOAudioEngineSampleRate": {"IOAudioSampleRateWholeNumber": 48000, "IOAudioSampleRateFraction": 0},
          "IORegistryEntryChildren": [
              {"IOObjectClass": "IOAudioStream", "IOAudioStreamDirection": 0,
               "IOAudioStreamFormat": {"IOAudioStreamNumChannels": 6, "IOAudioStreamBitDepth": 24, "IOAudioStreamBitWidth": 32}},
              {"IOObjectClass": "IOAudioStream", "IOAudioStreamDirection": 1,
               "IOAudioStreamFormat": {"IOAudioStreamNumChannels": 4, "IOAudioStreamBitDepth": 24, "IOAudioStreamBitWidth": 32}},
          ]}
MAC_TREE = [
    interface(2, 1, 3, endpoints=2),
    interface(1, 1, 2, alternate=1, endpoints=1, children=[ENGINE]),
    interface(0, 1, 1),
    interface(3, 8, 6, protocol=80, endpoints=2),
]

class InventoryBoundaryTests(unittest.TestCase):
    def test_whitelist_excludes_serial_and_paths(self):
        source = [{"IORegistryEntryChildren": [{"idVendor": 0x09e8, "idProduct": 0x1234,
            "USB Product Name": "Force", "USB Vendor Name": "Akai",
            "USB Serial Number": "PRIVATE", "path": "/dev/secret"}]}]
        result = usb_inventory.summarize_macos(source)
        self.assertEqual(result, [{"product": "Force", "manufacturer": "Akai", "vendorId": "09e8", "productId": "1234"}])
        self.assertNotIn("PRIVATE", str(result))

    @patch("usb_inventory.platform.system", return_value="Darwin")
    @patch("usb_inventory.subprocess.run")
    def test_only_os_registry_is_read(self, run, _system):
        run.return_value.stdout = plistlib.dumps([])
        self.assertEqual(usb_inventory.collect(), [])
        self.assertEqual(run.call_args.args[0], ["/usr/sbin/ioreg", "-p", "IOUSB", "-a", "-l"])
        self.assertTrue(run.call_args.kwargs["check"])
        self.assertEqual(run.call_args.kwargs["timeout"], 15)

    @patch("usb_inventory.platform.system", return_value="Darwin")
    @patch("usb_inventory.subprocess.run")
    def test_device_read_includes_registry_properties(self, run, _system):
        # Regression: the property-less archive reported no devices at all.
        run.return_value.stdout = plistlib.dumps({"IORegistryEntryChildren": [
            {"IOObjectClass": "AppleUSBDevice", "idVendor": 0x09E8, "idProduct": 0x0000,
             "USB Product Name": "Synthetic", "USB Vendor Name": "Synthetic", "USB Serial Number": SERIAL}]})
        devices = usb_inventory.collect()
        self.assertEqual(devices, [{"product": "Synthetic", "manufacturer": "Synthetic", "vendorId": "09e8", "productId": "0000"}])
        self.assertIn("-l", run.call_args.args[0])

class InterfaceDescriptorTests(unittest.TestCase):
    def test_macos_interfaces_classify_audio_midi_and_storage(self):
        result = usb_inventory.summarize_macos_interfaces(MAC_TREE)
        self.assertEqual([(i["interface"], i["kind"]) for i in result],
                         [(0, "audio-control"), (1, "audio-streaming"), (2, "midi-streaming"), (3, "mass-storage")])
        self.assertEqual(result[1]["audioEngines"], [{"sampleRate": 48000, "streams": [
            {"direction": "output", "format": {"channels": 6, "bitDepth": 24, "bitWidth": 32}},
            {"direction": "input", "format": {"channels": 4, "bitDepth": 24, "bitWidth": 32}}]}])
        self.assertEqual(result[2]["endpoints"], 2)

    def test_macos_interfaces_never_include_serials_guids_or_locations(self):
        text = json.dumps(usb_inventory.summarize_macos_interfaces(MAC_TREE))
        for secret in (SERIAL, "GlobalUniqueID", "14200000", "Synthetic:Device"):
            self.assertNotIn(secret, text)
        allowed = {"vendorId", "productId", "interface", "alternate", "class", "subclass",
                   "protocol", "kind", "endpoints", "audioEngines"}
        for entry in json.loads(text):
            self.assertLessEqual(set(entry), allowed)

    @patch("usb_inventory.platform.system", return_value="Darwin")
    @patch("usb_inventory.subprocess.run")
    def test_interface_read_uses_the_registry_only(self, run, _system):
        run.return_value.stdout = plistlib.dumps(MAC_TREE)
        detail = usb_inventory.collect_interfaces()
        self.assertEqual(len(detail["interfaces"]), 4)
        self.assertEqual(run.call_args.args[0],
                         ["/usr/sbin/ioreg", "-p", "IOService", "-c", "IOUSBHostInterface", "-r", "-a"])
        self.assertEqual(run.call_args.kwargs["timeout"], 15)

    @patch("usb_inventory.platform.system", return_value="Darwin")
    @patch("usb_inventory.subprocess.run")
    def test_empty_registry_reports_no_interfaces(self, run, _system):
        run.return_value.stdout = b""
        self.assertEqual(usb_inventory.collect_interfaces(), {"interfaces": [], "alsaStreams": []})

    def test_linux_sysfs_and_alsa_text_are_summarized(self):
        with tempfile.TemporaryDirectory() as tmp:
            root, asound = Path(tmp, "devices"), Path(tmp, "asound")
            device = root / "1-1"
            device.mkdir(parents=True)
            (device / "idVendor").write_text("09e8\n")
            (device / "idProduct").write_text("0000\n")
            (device / "serial").write_text(SERIAL)
            for name, values in {"1-1:1.0": ("00", "01", "01", "00", "0"), "1-1:1.2": ("02", "01", "03", "02", "0")}.items():
                iface = root / name
                iface.mkdir()
                for key, value in zip(("bInterfaceNumber", "bInterfaceClass", "bInterfaceSubClass", "bNumEndpoints", "bAlternateSetting"), values):
                    (iface / key).write_text(value + "\n")
                (iface / "bInterfaceProtocol").write_text("00\n")
            card = asound / "card0"
            card.mkdir(parents=True)
            (card / "usbid").write_text("09e8:0000\n")
            (card / "stream0").write_text("Synthetic at usb-1\n\nPlayback:\n  Status: Stop\n  Interface 1\n    Channels: 6\n    Rates: 44100, 48000\n\nCapture:\n  Interface 2\n    Channels: 4\n    Rates: 48000\n")
            interfaces, streams = usb_inventory.summarize_linux_interfaces(root, asound)
        self.assertEqual([(i["interface"], i["kind"], i["endpoints"]) for i in interfaces],
                         [(0, "audio-control", 0), (2, "midi-streaming", 2)])
        self.assertEqual(streams, [
            {"usbId": "09e8:0000", "direction": "playback", "channels": [6], "rates": [44100, 48000]},
            {"usbId": "09e8:0000", "direction": "capture", "channels": [4], "rates": [48000]}])
        self.assertNotIn(SERIAL, json.dumps([interfaces, streams]))

    def test_hubs_and_billboards_are_named(self):
        self.assertEqual(usb_inventory.interface_kind(9, 0), "hub")
        self.assertEqual(usb_inventory.interface_kind(17, 0), "usb-c-billboard")
        self.assertEqual(usb_inventory.interface_kind(224, 1), "class-224")

    def test_command_line_still_has_no_options(self):
        with patch("sys.argv", ["usb_inventory.py", "--device", "/dev/x"]):
            with self.assertRaises(SystemExit):
                usb_inventory.main()

if __name__ == "__main__":
    unittest.main()
