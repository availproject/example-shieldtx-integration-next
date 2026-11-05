import { expect, test } from "bun:test";
import { POST } from "../app/api/profile/route";

test("Next.js onboarding route rejects unauthenticated requests before provisioning", async () => {
  const response = await POST(new Request("https://partner.example/api/profile", {
    method: "POST", body: "{}",
  }));
  expect(response.status).toBe(401);
  expect(await response.json()).toMatchObject({ error: { code: "UNAUTHORIZED" } });
});
