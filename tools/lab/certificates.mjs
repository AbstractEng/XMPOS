import { spawnSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ownedScenarioDirectory } from "../../acceptance/lib/workspace.mjs";

export function provisionBenchCertificates(workspace) {
  const directory = ownedScenarioDirectory(workspace.directory);
  const configuration = `[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ca\n[dn]\nCN=XMP disposable host lab CA\n[ca]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n[agent]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:xmp-simulator.local\n[host]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=clientAuth\n`;
  writeFileSync(resolve(directory, "tls.cnf"), configuration, { mode: 0o600 });
  const run = (args) => {
    const result = spawnSync("openssl", args, { cwd: directory, encoding: "utf8", timeout: 15000 });
    if (result.status !== 0)
      throw new Error(
        "Disposable lab TLS certificate generation failed; OpenSSL/LibreSSL required",
      );
  };
  run([
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-sha256",
    "-days",
    "1",
    "-config",
    "tls.cnf",
    "-keyout",
    "ca.key",
    "-out",
    "ca.pem",
  ]);
  const pins = {};
  for (const role of ["host", "host-b", "agent-a", "agent-b"]) {
    run([
      "req",
      "-new",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-sha256",
      "-subj",
      `/CN=${role.startsWith("host") ? "xmp-host" : "xmp-simulator.local"}`,
      "-keyout",
      `${role}.key`,
      "-out",
      `${role}.csr`,
    ]);
    run([
      "x509",
      "-req",
      "-in",
      `${role}.csr`,
      "-CA",
      "ca.pem",
      "-CAkey",
      "ca.key",
      "-set_serial",
      String(role === "host" ? 2 : role === "agent-a" ? 3 : role === "agent-b" ? 4 : 5),
      "-days",
      "1",
      "-sha256",
      "-extfile",
      "tls.cnf",
      "-extensions",
      role.startsWith("host") ? "host" : "agent",
      "-out",
      `${role}.pem`,
    ]);
    pins[role] = new X509Certificate(readFileSync(resolve(directory, `${role}.pem`))).fingerprint256
      .replaceAll(":", "")
      .toLowerCase();
  }
  return pins;
}
