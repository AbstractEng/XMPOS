import type { SongImportOptions } from "./assets.ts";
import { type Project, ProjectSchema } from "./index.ts";
import { openProject } from "./project-io.ts";
export interface ProjectWriter {
  save(project: Project): Promise<void>;
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}
export class ProjectSession {
  #project: Project;
  #committed?: Project;
  #history: Project[] = [];
  #future: Project[] = [];
  #revision = 0;
  #gesture?: Project;
  #gestureFuture?: Project[];
  #saveChain: Promise<void> = Promise.resolve();
  error: string | undefined;
  originalImport: string | undefined;
  constructor(project: Project, saved = false) {
    this.#project = freeze(ProjectSchema.parse(project));
    if (saved) this.#committed = this.#project;
  }
  get project() {
    return this.#project;
  }
  get revision() {
    return this.#revision;
  }
  get dirty() {
    return this.#project !== this.#committed;
  }
  get historyDepth() {
    return this.#history.length;
  }
  get redoDepth() {
    return this.#future.length;
  }
  get canUndo() {
    return this.#history.length > 0;
  }
  get canRedo() {
    return this.#future.length > 0;
  }
  private validate(candidate: Project) {
    const validated = ProjectSchema.parse(candidate);
    for (const sample of validated.samples) {
      const previous = this.#project.samples.find((s) => s.id === sample.id);
      if (
        previous &&
        previous.pcm.length === sample.pcm.length &&
        sample.pcm.every((v, i) => v === previous.pcm[i])
      )
        sample.pcm = previous.pcm;
    }
    return freeze(validated);
  }
  edit(change: (project: Project) => Project | undefined): boolean {
    const candidate = change(structuredClone(this.#project));
    if (!candidate) return false;
    const validated = this.validate(candidate);
    if (!this.#gesture) this.#history.push(this.#project);
    this.#history = this.#history.slice(-20);
    this.#future = [];
    this.#project = validated;
    this.#revision++;
    this.error = undefined;
    return true;
  }
  // A change the user didn't ask for (filling in defaults before playback). It has
  // no undo step of its own, so UNDO still takes back the user's last edit.
  amend(change: (project: Project) => Project | undefined): boolean {
    const candidate = change(structuredClone(this.#project));
    if (!candidate) return false;
    this.#project = this.validate(candidate);
    this.#revision++;
    this.error = undefined;
    return true;
  }
  // A drag/knob gesture previews validated edits and commits one history entry.
  beginGesture() {
    if (!this.#gesture) {
      this.#gesture = this.#project;
      this.#gestureFuture = this.#future;
    }
  }
  endGesture(cancel = false) {
    const before = this.#gesture;
    const future = this.#gestureFuture;
    this.#gestureFuture = undefined;
    this.#gesture = undefined;
    if (!before || before === this.#project) return false;
    if (cancel) {
      this.#project = before;
      this.#future = future ?? [];
    } else {
      this.#history.push(before);
      this.#history = this.#history.slice(-20);
    }
    this.#revision++;
    return true;
  }
  undo() {
    this.endGesture();
    const previous = this.#history.pop();
    if (!previous) return false;
    this.#future.push(this.#project);
    this.#project = previous;
    this.#revision++;
    this.error = undefined;
    return true;
  }
  redo() {
    this.endGesture();
    const next = this.#future.pop();
    if (!next) return false;
    this.#history.push(this.#project);
    this.#project = next;
    this.#revision++;
    this.error = undefined;
    return true;
  }
  async open(text: string, options: SongImportOptions = {}) {
    const revision = this.#revision;
    try {
      // The C++ core (WebAssembly) opens every project file (docs/cpp-port.md, phase 9).
      const project = await openProject(text, options);
      if (revision !== this.#revision)
        throw new Error("Project changed during import; retry opening the file");
      this.edit(() => project);
      this.originalImport = text;
    } catch (error) {
      this.error = error instanceof Error ? error.message : "Project import failed";
      throw error;
    }
  }
  async save(writer: ProjectWriter) {
    const snapshot = this.#project;
    const task = this.#saveChain
      .catch(() => {})
      .then(async () => {
        try {
          await writer.save(snapshot);
          this.#committed = snapshot;
          this.error = undefined;
        } catch (error) {
          this.error = `Unsaved changes: ${error instanceof Error ? error.message : "Storage failure"}`;
          throw error;
        }
      });
    this.#saveChain = task;
    return task;
  }
}
