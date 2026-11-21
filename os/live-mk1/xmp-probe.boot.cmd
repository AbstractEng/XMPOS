# XMP probe boot script v6 for the MPC Live Mk1 (AZ01, ACV8).
# Replaces /boot/boot.scr.uimg in a copy of the official 3.10.0 root filesystem.
#
# History: v1 went to update mode; v2 and v3 booted stock. The v3 report showed
# xmp.fallback=probe-file-not-loaded: the Live's 2016-era U-Boot cannot read
# files added to Akai's ext4 (64-bit group descriptors; group 0 has no free
# inodes, so every added file lands in a later group it misreads).
#
# v4 adds no file for U-Boot to find. boot.scr.uimg keeps Akai's group-0 inode
# and is a two-part script image: part 0 is this script, part 1 the probe
# initramfs (raw cpio.gz). `imxtract` copies part 1 out of the script image
# that distro boot already loaded at ${scriptaddr}, before anything else is
# loaded over it. On the Live (U-Boot 2016.05-inmusic) that worked, but bootz
# never passed the ramdisk to the kernel: Akai's kernel logged no initramfs.
#
# v5 therefore writes the initramfs location into the device tree's /chosen
# node itself (`fdt chosen <start> <end>`) and boots with no ramdisk argument,
# so U-Boot's own ramdisk handling is never used. The v5 report showed
# xmp.fallback=end-address-failed: this U-Boot has no `setexpr`.
#
# v6 does no arithmetic on the device. The image builder fills in the end
# address for each known start address: 0x04000000 on the Live (its
# environment's ramdisk_addr_r) and 0x49000000 in the QEMU test U-Boot. Any
# other start address falls back to stock, recorded as unknown-ramdisk-address.
#
# Style: Akai's own boot.scr layout, multi-line if blocks only. Akai's kernel
# and device tree are booted; bootargs from U-Boot's environment are kept and
# only appended to. The fallback runs Akai's stock commands inline and passes
# xmp.fallback=<stage> plus the load addresses, which the XMP report service in
# the stock system records.

echo "XMP probe v6: starting"
setenv xmp_stock_bootargs "${bootargs}"
setenv xmp_stage probe-extract-failed

# Rockchip RK3288 U-Boot defines ramdisk_addr_r=0x04000000; set it if absent.
if test -z "${ramdisk_addr_r}"
then
	setenv ramdisk_addr_r 0x04000000
fi

setenv xmp_have_probe 0
if imxtract ${scriptaddr} 1 ${ramdisk_addr_r}
then
	setenv xmp_stage unknown-ramdisk-address
	if test "${ramdisk_addr_r}" = "0x04000000"
	then
		setenv xmp_initrd_end @XMP_INITRD_END_0x04000000@
		setenv xmp_have_probe 1
	fi
	if test "${ramdisk_addr_r}" = "0x49000000"
	then
		setenv xmp_initrd_end @XMP_INITRD_END_0x49000000@
		setenv xmp_have_probe 1
	fi
fi

load ${devtype} ${devnum}:${distro_bootpart} ${kernel_addr_r} ${prefix}zImage || exit
load ${devtype} ${devnum}:${distro_bootpart} ${fdt_addr_r} ${prefix}${fdtfile} || exit

if test "${board_name}" = "az01b"
then
	if load ${devtype} ${devnum}:${distro_bootpart} ${loadaddr} ${prefix}rk3288-az01b.dtbo
	then
		fdt addr ${fdt_addr_r}
		fdt resize
		fdt apply ${loadaddr}
	fi
fi

if test "${xmp_have_probe}" = "1"
then
	setenv xmp_stage fdt-chosen-failed
	fdt addr ${fdt_addr_r}
	fdt resize
	# The probe never mounts the root filesystem: rdinit runs it from RAM.
	setenv bootargs "${xmp_stock_bootargs} rdinit=/init xmp.probe=6 xmp.initrd=${ramdisk_addr_r},${xmp_initrd_end}"
	if fdt chosen ${ramdisk_addr_r} ${xmp_initrd_end}
	then
		fdt print /chosen
		echo "XMP probe: starting"
		setenv xmp_stage bootz-returned
		bootz ${kernel_addr_r} - ${fdt_addr_r}
	fi
fi

# Same as Akai's stock script from here on.
echo "XMP probe files missing or invalid: booting stock"
setenv bootargs "${xmp_stock_bootargs} fsck.repair=yes xmp.fallback=${xmp_stage} xmp.addr=${scriptaddr},${ramdisk_addr_r},${kernel_addr_r},${fdt_addr_r}"
bootz ${kernel_addr_r} - ${fdt_addr_r}
