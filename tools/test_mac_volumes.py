"""USB inventory stays passive and refuses instrument/internal storage."""
import importlib.util
import plistlib
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

PATH = Path(__file__).parent / 'live-mk1' / 'installer' / 'mac-volumes.py'
spec = importlib.util.spec_from_file_location('mac_volumes', PATH)
volumes = importlib.util.module_from_spec(spec)
spec.loader.exec_module(volumes)

class MacVolumeInventory(unittest.TestCase):
    def setUp(self):
        self.partition = dict(ParentWholeDisk='disk2', DeviceIdentifier='disk2s1',
            FilesystemType='msdos', FilesystemName='MS-DOS FAT32',
            MountPoint='/Volumes/test-key', VolumeUUID='test-uuid',
            VolumeFreeSpace=1000000000, TotalSize=2000000000)
        self.whole = dict(DeviceIdentifier='disk2', MediaName='test key',
            BusProtocol='USB', Ejectable=True, Internal=False)
        self.ancestry = (dict(vendor=0x05DC, product=0xA201, serial='test-only', entry='42'),)
        self.mock_query = patch.object(volumes, 'query', side_effect=lambda *args:
            self.whole if args[-1] == 'disk2' else self.partition).start()
        patch.object(volumes, 'USB_DISKS', {'disk2': self.ancestry}).start()
        self.addCleanup(patch.stopall)

    def test_registry_children_need_properties_and_preserve_usb_ancestry(self):
        tree = [{'idVendor': 0x09e8, 'IORegistryEntryChildren': [
            {'idVendor': 0x05DC, 'IORegistryEntryChildren': [{'BSD Name': 'disk2'}]}]}]
        with patch.object(volumes.subprocess, 'run', return_value=SimpleNamespace(
                stdout=plistlib.dumps(tree))) as query:
            found = volumes.usb_disks()
        self.assertIn('-l', query.call_args.args[0])
        self.assertEqual([v['vendor'] for v in found['disk2']], [0x09e8, 0x05DC])

    def test_internal_false_proves_external_when_location_is_absent(self):
        result = volumes.descriptor('disk2s1')
        self.assertTrue(result['external'])
        self.assertEqual(result['usbVendorId'], 0x05DC)
        self.assertEqual(result['mountPoint'], '/Volumes/test-key')
        self.whole['DeviceLocation'] = 'External'
        self.assertEqual(volumes.descriptor('disk2s1')['deviceKey'], result['deviceKey'])
        self.partition['FreeSpace'] = self.partition.pop('VolumeFreeSpace')
        self.assertEqual(volumes.descriptor('disk2s1')['freeBytes'], 1000000000)

    def test_unknown_or_conflicting_location_is_refused(self):
        for location, internal in [(None, None), ('External', True), ('Internal', False)]:
            with self.subTest(location=location, internal=internal):
                self.whole['DeviceLocation'] = location
                self.whole['Internal'] = internal
                with self.assertRaises(ValueError): volumes.descriptor('disk2s1')

    def test_akai_anywhere_in_ancestry_is_refused(self):
        volumes.USB_DISKS['disk2'] = (dict(vendor=0x09e8),) + self.ancestry
        with self.assertRaises(ValueError): volumes.descriptor('disk2s1')
        volumes.USB_DISKS.clear()
        with self.assertRaises(ValueError): volumes.descriptor('disk2s1')

    def test_unsupported_storage_never_becomes_a_candidate(self):
        for target, key, value in [(self.whole, 'Ejectable', False),
                (self.whole, 'BusProtocol', 'PCI'), (self.whole, 'MediaName', 'Akai Force'),
                (self.partition, 'FilesystemType', 'exfat'),
                (self.partition, 'MountPoint', '')]:
            with self.subTest(key=key):
                old = target[key]; target[key] = value
                with self.assertRaises(ValueError): volumes.descriptor('disk2s1')
                target[key] = old

if __name__ == '__main__': unittest.main()
