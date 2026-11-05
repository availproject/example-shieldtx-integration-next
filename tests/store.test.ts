import { expect, mock, test } from "bun:test";
import type { ProfileLedger } from "../server/provision";

let current: { etag: string } | null = null;
let savedEtag = "new-version";
const writes: { path: string; options: Record<string, unknown> }[] = [];
mock.module("@vercel/blob", () => ({
  get: async (_path: string, options: Record<string, unknown>) => {
    expect(options).toMatchObject({ access: "private", useCache: false });
    return current && { statusCode: 200, blob: { ...current, size: 2 }, stream: new Response("{}").body };
  },
  put: async (path: string, _body: string, options: Record<string, unknown>) => {
    writes.push({ path, options }); return { etag: savedEtag };
  },
}));
const { blobProfileStore } = await import("../server/store.js");
const state: ProfileLedger = { actorId: crypto.randomUUID(), nsAddress: "public-root", resources: {} };

test("blob checkpoints use atomic creation and conditional overwrites", async () => {
  writes.length = 0; current = null; savedEtag = "new-version";
  const first = blobProfileStore("fake-token");
  expect(await first.load(state.actorId)).toBeUndefined();
  await first.save(state);
  expect(writes[0]!.options).toMatchObject({ access: "private", addRandomSuffix: false, allowOverwrite: false });
  expect(writes[0]!.options).not.toHaveProperty("ifMatch");
  await first.save(state);
  expect(writes[1]!.options).toMatchObject({ allowOverwrite: true, ifMatch: "new-version" });
  current = { etag: "read-version" };
  const resumed = blobProfileStore("fake-token");
  await resumed.load(state.actorId); await resumed.save(state);
  expect(writes[2]!.options).toMatchObject({ allowOverwrite: true, ifMatch: "read-version" });
});

test("missing storage versions and actor changes fail closed", async () => {
  writes.length = 0; current = { etag: "" };
  await expect(blobProfileStore("fake-token").load(state.actorId)).rejects.toThrow("Invalid profile checkpoint");
  expect(writes).toHaveLength(0);
  current = null; savedEtag = "";
  const store = blobProfileStore("fake-token");
  await store.load(state.actorId);
  await expect(store.save(state)).rejects.toThrow("Profile changed or storage is unavailable");
  await expect(store.save({ ...state, actorId: crypto.randomUUID() })).rejects.toThrow("binding mismatch");
});
