import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { validate as isUuid } from "uuid";
import { ProfileError, type ProfileStore } from "./provision";

// Development only; conditional file writes preserve the Blob adapter's retry fences.
export function localProfileStore(folder = join(process.cwd(), ".data", "profiles")): ProfileStore {
  let actorId: string | undefined;
  let path: string | undefined;
  let previous: string | undefined;
  const read = (file: string) => existsSync(file) ? readFileSync(file, "utf8") : undefined;
  return {
    async load(id) {
      if (!isUuid(id)) throw new Error("Invalid profile actor");
      mkdirSync(folder, { recursive: true, mode: 0o700 });
      actorId = id;
      path = join(folder, id + ".json");
      previous = read(path);
      return previous === undefined ? undefined : JSON.parse(previous);
    },
    async save(state) {
      if (!path || state.actorId !== actorId) throw new Error("Profile store binding mismatch");
      const lockPath = path + ".lock";
      let lock: number;
      try { lock = openSync(lockPath, "wx", 0o600); }
      catch { throw new ProfileError("PROFILE_BUSY", 409, "Profile is being updated; retry the same setup"); }
      const temporary = path + "." + crypto.randomUUID();
      try {
        if (read(path) !== previous) throw new ProfileError("PROFILE_BUSY", 409, "Profile changed; retry the same setup");
        const next = JSON.stringify(state);
        writeFileSync(temporary, next, { mode: 0o600, flag: "wx" });
        renameSync(temporary, path);
        previous = next;
      } finally {
        if (existsSync(temporary)) unlinkSync(temporary);
        closeSync(lock);
        unlinkSync(lockPath);
      }
    },
  };
}
