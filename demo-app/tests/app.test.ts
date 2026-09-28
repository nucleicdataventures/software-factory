import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";

const apps: Array<ReturnType<typeof buildApp>> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("todo API", () => {
  it("creates and lists todos", async () => {
    const app = buildApp();
    apps.push(app);

    const created = await app.inject({ method: "POST", url: "/todos", payload: { title: "Ship Forge" } });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ id: 1, title: "Ship Forge", completed: false });

    const listed = await app.inject({ method: "GET", url: "/todos" });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toHaveLength(1);
  });

  it("rejects an empty todo title", async () => {
    const app = buildApp();
    apps.push(app);
    const response = await app.inject({ method: "POST", url: "/todos", payload: { title: " " } });
    expect(response.statusCode).toBe(400);
  });
});
