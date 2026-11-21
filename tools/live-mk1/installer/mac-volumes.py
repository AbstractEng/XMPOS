"""Passive macOS volume metadata only; no mounts or device handles."""
import hashlib
import json
import plistlib
import re
import subprocess
import sys

def query(*args):
    result = subprocess.run(['/usr/sbin/diskutil', *args], capture_output=True, check=True)
    return plistlib.loads(result.stdout)

def usb_disks():
    # IORegistry is passive OS metadata. Follow USB ancestry to each BSD disk;
    # model text alone cannot reliably distinguish an instrument's storage.
    raw = subprocess.run(['/usr/sbin/ioreg', '-a', '-r', '-l', '-c', 'IOUSBHostDevice'],
                         capture_output=True, check=True).stdout
    if len(raw) > 32 * 1024**2:
        raise ValueError('USB registry inventory exceeds bound')
    found = {}
    def visit(node, ancestry=()):
        if 'idVendor' in node:
            ancestry = ancestry + (dict(vendor=int(node['idVendor']),
                product=int(node.get('idProduct', 0)),
                serial=str(node.get('USB Serial Number', '')),
                entry=str(node.get('IORegistryEntryID', ''))),)
        if node.get('BSD Name') and ancestry:
            found[node['BSD Name']] = ancestry
        for child in node.get('IORegistryEntryChildren', []):
            visit(child, ancestry)
    for node in plistlib.loads(raw):
        visit(node)
    return found

USB_DISKS = {}

def descriptor(device):
    info = query('info', '-plist', device)
    whole = query('info', '-plist', info.get('ParentWholeDisk', device))
    model = str(whole.get('MediaName', ''))
    ancestry = USB_DISKS.get(whole.get('DeviceIdentifier'), ())
    if not ancestry or any(v['vendor'] == 0x09e8 for v in ancestry):
        raise ValueError('Verified non-Akai USB storage ancestry required')
    usb = ancestry[-1]
    location, internal = whole.get('DeviceLocation'), whole.get('Internal')
    external = ((location == 'External' and internal is not True) or
                (location is None and internal is False))
    if (not external or not whole.get('Ejectable') or
        whole.get('BusProtocol') != 'USB' or
        re.search(r'force|ada2|akai|inmusic', model, re.I) or
        info.get('FilesystemType') != 'msdos' or
        'FAT32' not in info.get('FilesystemName', '') or
        not info.get('MountPoint')):
        raise ValueError('External removable FAT32 USB key required')
    return dict(mountPoint=info['MountPoint'], filesystem='fat32', external=True,
                removable=True, bus='USB', model=model, label=info.get('VolumeName', ''),
                deviceId=info['DeviceIdentifier'], wholeDisk=info.get('ParentWholeDisk'),
                usbVendorId=usb['vendor'], usbProductId=usb['product'],
                deviceKey=hashlib.sha256((info.get('VolumeUUID', '')+'|'+info['DeviceIdentifier']+'|'+model+'|'+json.dumps(usb, sort_keys=True)).encode()).hexdigest(),
                freeBytes=info.get('VolumeFreeSpace', info.get('FreeSpace', 0)),
                capacityBytes=info.get('TotalSize', 0))

if __name__ == '__main__':
    USB_DISKS = usb_disks()
    if sys.argv[1] == 'inspect':
        print(json.dumps(descriptor(sys.argv[2])))
    else:
        inventory = query('list', '-plist', 'external', 'physical')
        result = []
        for disk in inventory.get('AllDisksAndPartitions', []):
            for part in disk.get('Partitions', []):
                try:
                    result.append(descriptor(part['DeviceIdentifier']))
                except (ValueError, subprocess.CalledProcessError):
                    pass
        print(json.dumps(result))
