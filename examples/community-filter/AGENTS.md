# Community module development

Keep packages declarative: program.json accepts only the documented sine/triangle/input, gain and cutoff primitives. Never put JavaScript, native binaries, hardware access or scripts in a package. Preserve API/ABI and stable parameter IDs/units. Declare exact DSP dependencies and hashes; use sdk build, test and preview after edits. Bump stateVersion and declare rename migrations for incompatible state IDs. Physical Akai devices are outside this workbench.
