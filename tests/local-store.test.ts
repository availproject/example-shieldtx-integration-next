import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localProfileStore } from "../server/local-store";
import type { ProfileLedger } from "../server/provision";

const actorId = "97fffa5d-d4a7-5ecf-b1ba-1ea6fc32c54a";
const state: ProfileLedger = { actorId, nsAddress: "test-root", pending: "policy", resources: {} };

test("local checkpoints survive new requests with private file permissions", async () => {
  const folder = mkdtempSync(join(tmpdir(), "shieldtx-profile-"));
  try {
    const first = localProfileStore(folder);
    expect(await first.load(actorId)).toBeUndefined();
    await first.save(state);
    expect(await localProfileStore(folder).load(actorId)).toEqual(state);
    expect(statSync(join(folder, actorId + ".json")).mode & 0o777).toBe(0o600);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test("stale local requests cannot overwrite another request's creation fence", async () => {
  const folder = mkdtempSync(join(tmpdir(), "shieldtx-profile-"));
  try {
    const first = localProfileStore(folder), stale = localProfileStore(folder);
    await first.load(actorId); await stale.load(actorId);
    await first.save(state);
    await expect(stale.save({ ...state, pending: "positionSet" })).rejects.toMatchObject({ code: "PROFILE_BUSY" });
    expect(await localProfileStore(folder).load(actorId)).toEqual(state);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test("local store rejects actor changes and path traversal", async () => {
  const folder = mkdtempSync(join(tmpdir(), "shieldtx-profile-"));
  try {
    const store = localProfileStore(folder);
    await expect(store.load("../other")).rejects.toThrow("Invalid profile actor");
    await store.load(actorId);
    await expect(store.save({ ...state, actorId: crypto.randomUUID() })).rejects.toThrow("binding mismatch");
  } finally { rmSync(folder, { recursive: true, force: true }); }
});
