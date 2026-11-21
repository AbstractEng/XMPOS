// Synthetic input for --simulate and host tests only. Never a measured unit.
export function stockInstallFixture({
  serial = "SIMULATED-LIVE",
  treeSerial = "SIMULATED-DT",
  sectors = 1024000,
} = {}) {
  const report = `XMP_STOCK_INSTALL_REPORT_V1
@@compatible
inmusic,acv8 inmusic,az01 rockchip,rk3288
@@model
MPC Live
@@product
ACV8
@@serial
${treeSerial}
@@cpu_serial
Serial\t: ${serial}
@@version
3.10.1
@@root_device
45830
@@root_mount
22 1 179:6 / / rw,relatime - ext4 /dev/root rw
@@partitions
major minor #blocks name
179 6 ${Math.floor(sectors / 2)} mmcblk0p6
@@rootfs_sectors
${sectors}
@@rootfs_path
/sys/devices/platform/ff0f0000.dwmmc/mmc_host/mmc0/mmc0:0001/block/mmcblk0/mmcblk0p6
@@end
`;
  const identity = `compatible=inmusic,acv8,inmusic,az01,rockchip,rk3288,
model=MPC Live
serial=${treeSerial}
app=3.10.1
@@MOUNTS
/dev/root / ext4 rw,relatime 0 0
`;
  return { report, identity };
}
