import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { bootVm, createVmSession, imageIdentity } from "./vm.mjs";

if (process.argv.length > 2)
  throw new Error("No physical devices or arbitrary QEMU flags supported");
const identity = await imageIdentity(resolve("artifacts/os/p10"));
const session = await createVmSession(resolve("reports/os-console", identity.manifest.buildId));
const vm = await bootVm(session);
console.log(JSON.stringify({ session: session.session, boot: vm.boot }));
console.log("Virtual console: pad 0, record, beat, synth, arrange, save, export, status, shutdown");
vm.child.stdout.pipe(process.stdout);
vm.child.stderr.pipe(process.stderr);
const input = createInterface({ input: process.stdin });
let queue = Promise.resolve();
input.on("line", (line) => {
  queue = queue.then(async () => {
    const [op, number] = line.trim().split(/\s+/);
    if (op === "shutdown") {
      await vm.finish();
      input.close();
      process.exit(0);
    }
    try {
      console.log(await vm.request(op === "pad" ? { op, pad: Number(number) } : { op }));
    } catch (error) {
      console.error(error.message);
    }
  });
});
process.once("SIGINT", async () => {
  await vm.finish();
  process.exit(0);
});
vm.child.once("close", () => input.close());
