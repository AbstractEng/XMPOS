// Saving an export: staging happens before commit, and the sink must replace
// the file atomically or not at all.
export interface ExportSink {
  exists(): Promise<boolean>;
  stage(bytes: Uint8Array): Promise<void>;
  append?(bytes: Uint8Array): Promise<void>;
  commit(): Promise<void>;
  abort(): Promise<void>;
}
export async function saveExport(
  sink: ExportSink,
  overwrite: boolean,
  render: () => Promise<Uint8Array>,
) {
  if ((await sink.exists()) && !overwrite)
    throw new Error("Overwrite declined; existing file preserved");
  try {
    const bytes = await render();
    await sink.stage(bytes);
    await sink.commit();
  } catch (error) {
    await sink.abort();
    throw error;
  }
}

/** Stream into a temporary destination; commit only after every block succeeds. */
export async function saveStreamExport(
  sink: ExportSink,
  overwrite: boolean,
  chunks: AsyncIterable<Uint8Array>,
) {
  if ((await sink.exists()) && !overwrite)
    throw new Error("Overwrite declined; existing file preserved");
  if (!sink.append) throw new Error("This destination does not support streaming export");
  try {
    await sink.stage(new Uint8Array());
    for await (const bytes of chunks) await sink.append(bytes);
    await sink.commit();
  } catch (error) {
    await sink.abort();
    throw error;
  }
}
