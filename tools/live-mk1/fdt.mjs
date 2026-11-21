// Minimal, read-only flattened device tree (DTB) parser. It never executes or
// loads device-tree content; it only decodes the published binary format.
const MAGIC = 0xd00dfeed;
const BEGIN_NODE = 1;
const END_NODE = 2;
const PROP = 3;
const NOP = 4;
const END = 9;
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_DEPTH = 32;

export function parseDtb(bytes) {
  const data = Buffer.from(bytes);
  if (data.length < 40 || data.length > MAX_BYTES) throw new Error("DTB size out of bounds");
  if (data.readUInt32BE(0) !== MAGIC) throw new Error("Not a flattened device tree");
  const total = data.readUInt32BE(4);
  const structOffset = data.readUInt32BE(8);
  const stringsOffset = data.readUInt32BE(12);
  const version = data.readUInt32BE(20);
  const stringsSize = data.readUInt32BE(32);
  const structSize = data.readUInt32BE(36);
  if (total !== data.length || version < 16) throw new Error("Unsupported or truncated DTB");
  if (structOffset + structSize > total || stringsOffset + stringsSize > total)
    throw new Error("DTB blocks exceed the blob");
  const name = (offset) => {
    if (offset >= stringsSize) throw new Error("DTB string offset out of bounds");
    const start = stringsOffset + offset;
    const end = data.indexOf(0, start);
    if (end < 0 || end >= stringsOffset + stringsSize) throw new Error("Unterminated DTB string");
    return data.toString("latin1", start, end);
  };
  const align = (n) => (n + 3) & ~3;
  let cursor = structOffset;
  const limit = structOffset + structSize;
  const stack = [];
  let root = null;
  while (cursor + 4 <= limit) {
    const token = data.readUInt32BE(cursor);
    cursor += 4;
    if (token === BEGIN_NODE) {
      const end = data.indexOf(0, cursor);
      if (end < 0 || end >= limit) throw new Error("Unterminated node name");
      const node = {
        name: data.toString("latin1", cursor, end),
        properties: new Map(),
        children: [],
      };
      cursor = align(end + 1);
      if (stack.length) stack.at(-1).children.push(node);
      else if (root) throw new Error("Multiple DTB roots");
      else root = node;
      stack.push(node);
      if (stack.length > MAX_DEPTH) throw new Error("DTB nesting too deep");
    } else if (token === END_NODE) {
      if (!stack.pop()) throw new Error("Unbalanced DTB node end");
    } else if (token === PROP) {
      if (!stack.length || cursor + 8 > limit) throw new Error("Property outside a node");
      const length = data.readUInt32BE(cursor);
      const key = name(data.readUInt32BE(cursor + 4));
      cursor += 8;
      if (cursor + length > limit) throw new Error("Property exceeds structure block");
      stack.at(-1).properties.set(key, data.subarray(cursor, cursor + length));
      cursor = align(cursor + length);
    } else if (token === NOP) {
      // Skip.
    } else if (token === END) {
      if (stack.length || !root) throw new Error("DTB ended inside a node");
      return root;
    } else throw new Error(`Unknown DTB token ${token}`);
  }
  throw new Error("DTB has no end token");
}

export const strings = (value) =>
  value ? value.toString("latin1").split("\0").filter(Boolean) : [];
export const text = (value) => strings(value)[0] ?? null;
export const u32 = (value) => (value && value.length >= 4 ? value.readUInt32BE(0) : null);

export function* walk(node, path = "") {
  const here = node.name === "" ? "/" : `${path === "/" ? "" : path}/${node.name}`;
  yield { path: here, node };
  for (const child of node.children) yield* walk(child, here);
}

export function findByCompatible(root, compatible) {
  const found = [];
  for (const entry of walk(root))
    if (strings(entry.node.properties.get("compatible")).includes(compatible)) found.push(entry);
  return found;
}

export function findByPrefix(root, prefix) {
  return [...walk(root)].filter((entry) => entry.node.name.split("@")[0] === prefix);
}

// UTF-16LE strings embedded in a USB5537 hub configuration blob.
export function hubStrings(bytes) {
  const data = Buffer.from(bytes);
  const found = new Set();
  let run = "";
  const flush = () => {
    if (run.trim().length >= 4) found.add(run.trim());
    run = "";
  };
  for (let i = 0; i + 1 < data.length; i += 2) {
    const low = data[i] ?? 0;
    if (data[i + 1] === 0 && low >= 0x20 && low <= 0x7e) run += String.fromCharCode(low);
    else {
      flush();
      // Re-synchronise on odd offsets: strings need not start on an even byte.
      if (data[i + 1] !== 0 && run === "") i -= 1;
    }
  }
  flush();
  return [...found];
}
