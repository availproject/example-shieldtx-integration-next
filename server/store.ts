import { get, put } from "@vercel/blob";
import { ProfileError, type ProfileStore } from "./provision";

// A private blob is a cold-path checkpoint, not a trading database. Conditional
// writes fence concurrent invocations before either can create a Privy resource.
export function blobProfileStore(token?: string): ProfileStore {
  let path: string | undefined;
  let etag: string | undefined;
  return {
    async load(actorId) {
      path = "profiles/" + actorId + ".json";
      const current = await get(path, { access: "private", token, useCache: false });
      if (!current) return undefined;
      if (current.statusCode !== 200 || !current.stream || !current.blob.etag || (current.blob.size ?? 0) > 8192)
        throw new Error("Invalid profile checkpoint");
      etag = current.blob.etag;
      return new Response(current.stream).json();
    },
    async save(state) {
      if (path !== "profiles/" + state.actorId + ".json") throw new Error("Profile store binding mismatch");
      try {
        const saved = await put(path, JSON.stringify(state), {
          access: "private", token, addRandomSuffix: false, contentType: "application/json",
          allowOverwrite: etag !== undefined, ...(etag ? { ifMatch: etag } : {}),
        });
        if (!saved.etag) throw new Error("Missing checkpoint version");
        etag = saved.etag;
      } catch {
        // Do not retry a stale checkpoint or a write whose result is unknown.
        throw new ProfileError("PROFILE_BUSY", 409, "Profile changed or storage is unavailable; retry the same setup after checking its status");
      }
    },
  };
}
