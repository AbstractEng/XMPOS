import { buildImage } from "../os/build.mjs";

if (process.argv.length > 2)
  throw new Error("Builds the two fixed generic VM variants; no device flags");
buildImage();
buildImage("artifacts/os/update-candidate", { variant: "update-candidate" });
