export type ResourceState =
  | "missing"
  | "deleted"
  | "private"
  | "expired"
  | "unavailable";

export function getResourceState(status: number | undefined): ResourceState {
  if (status === 404) return "missing";
  if (status === 410) return "deleted";
  if (status === 403 || status === 401) return "private";
  if (status === 419) return "expired";
  return "unavailable";
}

export const RESOURCE_STATE_COPY: Record<
  Exclude<ResourceState, "unavailable">,
  { title: string; description: string }
> = {
  missing: {
    title: "Resource not found",
    description: "This resource does not exist or the link is incomplete.",
  },
  deleted: {
    title: "Resource deleted",
    description: "This resource was removed and is no longer available.",
  },
  private: {
    title: "Resource is private",
    description: "You do not have permission to view this resource.",
  },
  expired: {
    title: "Resource expired",
    description: "This resource is no longer active. Its link or content has expired.",
  },
};
