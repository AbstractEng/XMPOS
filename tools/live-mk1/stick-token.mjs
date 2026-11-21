import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

async function atomicToken(path, token) {
  const temp = `${path}.${randomBytes(12).toString("hex")}.new`;
  const file = await open(
    temp,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.writeFile(`${token}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await rename(temp, path);
    let directory;
    try {
      directory = await open(
        dirname(path),
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      await directory.sync();
    } catch (error) {
      if (
        !(
          process.platform === "win32" &&
          ["EPERM", "EISDIR", "EINVAL", "ENOTSUP"].includes(error.code)
        )
      )
        throw error;
      // Windows requires safe removal after file flush and rename; the UI keeps
      // that physical step explicit rather than claiming directory-fsync parity.
    } finally {
      await directory?.close();
    }
  } finally {
    await unlink(temp).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

// The production caller selects exactly one mounted XMP volume. Explicit paths
// here also allow tests to exercise actual local files without touching volumes.
export async function prepareStickToken(volume, macToken) {
  const directory = join(volume, "xmp");
  await mkdir(directory, { recursive: true });
  if (!(await lstat(directory)).isDirectory() || (await lstat(directory)).isSymbolicLink())
    throw new Error("Regular stick directory required");
  const path = join(directory, "bridge.token");
  let token;
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 128) throw new Error("Invalid stick token file");
      token = (await file.readFile("utf8")).trim();
    } finally {
      await file.close();
    }
    if (!/^[a-f0-9]{48}$/.test(token)) throw new Error("Invalid stick token");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    token = randomBytes(24).toString("hex");
    await atomicToken(path, token);
  }
  await mkdir(dirname(macToken), { recursive: true });
  await atomicToken(macToken, token);
}
