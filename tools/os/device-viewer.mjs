import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { root } from "../../acceptance/lib/workspace.mjs";
import { DeviceCommand } from "../../os/guest/device-contract.ts";
import {
  deviceScreenshot,
  downloadVmSong,
  finishDeviceVm,
  uploadVmFile,
} from "./device-client.mjs";
import { bootVm, createVmSession, imageIdentity } from "./vm.mjs";

// "live-mk1" selects the ARMv7 image on the official az01 kernel; still a VM.
const variant = process.argv[2] ?? "x86";
if (process.argv.length > 3 || !["x86", "live-mk1"].includes(variant))
  throw new Error("No hardware or network overrides supported");
const image = await imageIdentity(
  join(root, variant === "live-mk1" ? "artifacts/os/live-mk1-device" : "artifacts/os/device"),
);
await mkdir(join(root, "reports/device-viewer"), { recursive: true });
const session = await createVmSession(
  join(root, "reports/device-viewer", image.manifest.buildId),
  image.directory,
);
console.log("Booting offline Linux Device view…");
const vm = await bootVm(session),
  token = randomBytes(32).toString("hex");
let origin,
  queue = Promise.resolve();
const page = `<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>XMP Linux VM Device view</title><style>body{margin:0;background:#111;color:#eee;font:16px system-ui}header{padding:12px;display:flex;gap:12px;align-items:center;flex-wrap:wrap}button{padding:9px;background:#333;color:white;border:1px solid #777;border-radius:5px}img{display:block;width:100%;max-width:1600px;outline:none}small{color:#bbb}#status{padding:8px}</style><header><strong>XMP · Linux VM</strong><button id="refresh">Refresh screen</button><button id="reload">Reload guest UI</button><button id="open-song">Open song</button><button id="save-song">Save song</button><label><input id="pack-song" type="checkbox" checked> Package samples</label><button id="locate-song">Locate WAV samples</button><input id="song-upload" type="file" accept=".xmpsong,.json,.xmp.json" hidden><input id="sample-upload" type="file" accept=".wav" multiple hidden><small>Guest-rendered screen · click controls · Tab/arrows/Enter operate menus · audio muted · Ctrl-C in terminal to shut down</small></header><div id="status" role="status">Loading guest screen…</div><img id="screen" alt="Device view rendered inside the Linux guest" tabindex="0"><script>
const token=${JSON.stringify(token)},screen=document.getElementById('screen'),status=document.getElementById('status');let busy=false,url;
async function action(command){if(busy)return;busy=true;status.textContent='Waiting for Linux guest…';try{if(command){const r=await fetch('/command',{method:'POST',headers:{'Content-Type':'application/json','X-XMP-Token':token},body:JSON.stringify(command)});if(!r.ok)throw Error('Guest command failed');const reply=await r.json();if(reply.confirmationRequired){if(!confirm(reply.confirmationRequired)){status.textContent='Cancelled · project unchanged';return;}const approved=await fetch('/command',{method:'POST',headers:{'Content-Type':'application/json','X-XMP-Token':token},body:JSON.stringify({...command,confirmed:true})});if(!approved.ok)throw Error('Confirmed command failed')}}const r=await fetch('/screen',{method:'POST',headers:{'X-XMP-Token':token}});if(!r.ok)throw Error('Screen failed');if(url)URL.revokeObjectURL(url);url=URL.createObjectURL(await r.blob());screen.src=url;status.textContent='Ready · saved projects stay in this VM data disk';}catch(e){status.textContent=e.message}finally{busy=false}}
screen.onclick=e=>{const r=screen.getBoundingClientRect();screen.focus();action({op:'device-click',x:Math.min(1599,Math.floor((e.clientX-r.left)*1600/r.width)),y:Math.min(999,Math.floor((e.clientY-r.top)*1000/r.height))})};
screen.onkeydown=e=>{if(['Tab','Enter','Escape','ArrowLeft','ArrowRight','ArrowUp','ArrowDown',' '].includes(e.key)){e.preventDefault();action({op:'device-key',key:e.key})}};
async function transfer(kind,file){if(busy)return;if(kind!=='save'&&(!file||file.size>(kind==='sample'?4:96)*1024*1024)){status.textContent='File exceeds the supported size';return;}busy=true;status.textContent='Transferring song files…';let message='';try{const r=await fetch('/song/'+kind,{method:'POST',headers:{'X-XMP-Token':token,...(kind==='save'?{'Content-Type':'application/json'}:{})},body:kind==='save'?JSON.stringify({packageSamples:document.getElementById('pack-song').checked}):file});if(!r.ok)throw Error('File transfer failed; check the song format and sample availability');if(kind==='save'){const u=URL.createObjectURL(await r.blob()),a=document.createElement('a');a.href=u;a.download='song.xmpsong';a.click();setTimeout(()=>URL.revokeObjectURL(u),1000);message='Song downloaded to this computer';}else{message=(await r.json()).message}}catch(e){message=e.message}finally{busy=false}await action();if(message)status.textContent=message;}
document.getElementById('open-song').onclick=()=>document.getElementById('song-upload').click();document.getElementById('song-upload').onchange=e=>{const f=e.target.files[0];if(f)transfer('open',f);e.target.value=''};document.getElementById('save-song').onclick=()=>transfer('save');document.getElementById('locate-song').onclick=()=>document.getElementById('sample-upload').click();document.getElementById('sample-upload').onchange=async e=>{const files=[...e.target.files];e.target.value='';if(files.length>16){status.textContent='Choose at most sixteen WAV files';return;}for(const f of files)await transfer('sample',f)};
document.getElementById('refresh').onclick=()=>action();document.getElementById('reload').onclick=()=>action({op:'device-reload'});action();</script></html>`;
const server = createServer((req, res) => {
  queue = queue.then(async () => {
    try {
      if (req.headers.host !== new URL(origin).host) throw new Error("Host rejected");
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Frame-Options", "DENY");
      if (req.method === "GET" && req.url === "/") {
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(page);
        return;
      }
      if (
        req.method !== "POST" ||
        req.headers.origin !== origin ||
        req.headers["x-xmp-token"] !== token
      )
        throw new Error("Viewer authorization rejected");
      if (req.url === "/screen") {
        res.setHeader("Content-Type", "image/png");
        res.end((await deviceScreenshot(vm)).png);
        return;
      }
      if (["/song/open", "/song/sample"].includes(req.url)) {
        const limit = (req.url === "/song/sample" ? 4 : 96) * 1024 * 1024,
          chunks = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > limit) throw new Error("File budget exceeded");
          chunks.push(chunk);
        }
        const result = await uploadVmFile(
          vm,
          Buffer.concat(chunks),
          req.url === "/song/sample" ? "sample" : "song",
        );
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(result));
        return;
      }
      if (req.url === "/song/save") {
        let body = "";
        for await (const chunk of req) {
          body += chunk;
          if (body.length > 128) throw new Error("Invalid save options");
        }
        const options = JSON.parse(body);
        if (
          !options ||
          typeof options !== "object" ||
          Object.keys(options).length !== 1 ||
          typeof options.packageSamples !== "boolean"
        )
          throw new Error("Invalid save options");
        const file = await downloadVmSong(vm, options.packageSamples);
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.setHeader("Content-Disposition", 'attachment; filename="song.xmpsong"');
        res.end(file.bytes);
        return;
      }
      if (req.url !== "/command") throw new Error("Unknown viewer route");
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (Buffer.byteLength(body) > 4096) throw new Error("Input budget");
      }
      const command = DeviceCommand.parse(JSON.parse(body));
      if (!["device-click", "device-key", "device-reload"].includes(command.op))
        throw new Error("Viewer action denied");
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(await vm.request(command)));
    } catch {
      res.writeHead(400);
      res.end("Viewer request rejected");
    }
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
origin = `http://127.0.0.1:${server.address().port}`;
console.log(
  `Device view: ${origin}\nProfile: ${image.manifest.profile}\nForce and host audio are not connected.`,
);
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  server.close();
  await queue;
  await finishDeviceVm(vm);
  process.exit(0);
}
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
vm.child.once("close", () => {
  if (!stopping) {
    server.close();
    process.exitCode = 1;
  }
});
