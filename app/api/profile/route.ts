import { handleProfile } from "../../../server/profile";
import { blobProfileStore } from "../../../server/store";
import { localProfileStore } from "../../../server/local-store";

export const runtime = "nodejs";
export const maxDuration = 120;

export function POST(request: Request): Promise<Response> {
  return handleProfile(request, {
    env: process.env,
    store: process.env.NODE_ENV === "development" ? localProfileStore() : blobProfileStore(process.env.BLOB_READ_WRITE_TOKEN),
  });
}
