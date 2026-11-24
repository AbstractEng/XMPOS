import version from "./version.json" with { type: "json" };

export const INSTALLER_VERSION = version.installerVersion;
if (!/^\d+\.\d+\.\d+$/.test(INSTALLER_VERSION)) throw Error("Invalid installer version");
export const windowsVersionSource = () =>
  `using System.Reflection;\n[assembly: AssemblyTitle("XMP OS Installer")]\n[assembly: AssemblyProduct("XMP OS Installer")]\n[assembly: AssemblyCompany("Abstract Engineering")]\n[assembly: AssemblyVersion("${INSTALLER_VERSION}.0")]\n[assembly: AssemblyFileVersion("${INSTALLER_VERSION}.0")]\n[assembly: AssemblyInformationalVersion("${INSTALLER_VERSION}")]\n`;
