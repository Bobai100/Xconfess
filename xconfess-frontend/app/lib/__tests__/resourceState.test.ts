import {
  getResourceState,
  RESOURCE_STATE_COPY,
} from "@/app/lib/resourceState";

describe("resource state classification", () => {
  it.each([
    [404, "missing"],
    [410, "deleted"],
    [401, "private"],
    [403, "private"],
    [419, "expired"],
  ] as const)("maps status %i to %s", (status, state) => {
    expect(getResourceState(status)).toBe(state);
  });

  it("uses neutral copy for private resources", () => {
    expect(RESOURCE_STATE_COPY.private.title).toBe("Resource is private");
    expect(RESOURCE_STATE_COPY.private.description).not.toContain("owner");
  });
});
